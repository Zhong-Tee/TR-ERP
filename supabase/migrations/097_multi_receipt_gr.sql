-- ============================================
-- 097: Multi-Receipt GR + Shortage Resolution
-- ============================================

-- 1. Add tracking columns to inv_po_items
ALTER TABLE inv_po_items ADD COLUMN IF NOT EXISTS qty_received_total NUMERIC(12,2) DEFAULT 0;
ALTER TABLE inv_po_items ADD COLUMN IF NOT EXISTS resolution_type TEXT;
ALTER TABLE inv_po_items ADD COLUMN IF NOT EXISTS resolution_qty NUMERIC(12,2) DEFAULT 0;
ALTER TABLE inv_po_items ADD COLUMN IF NOT EXISTS resolution_note TEXT;
ALTER TABLE inv_po_items ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE inv_po_items ADD COLUMN IF NOT EXISTS resolved_by UUID;

-- 2. Backfill qty_received_total from existing GR data
UPDATE inv_po_items poi
SET qty_received_total = COALESCE(sub.total_recv, 0)
FROM (
  SELECT gi.product_id, gr.po_id, SUM(gi.qty_received) AS total_recv
  FROM inv_gr_items gi
  JOIN inv_gr gr ON gr.id = gi.gr_id
  GROUP BY gi.product_id, gr.po_id
) sub
WHERE poi.product_id = sub.product_id
  AND poi.po_id = sub.po_id;

-- ============================================
-- 3. Replace rpc_receive_gr to support multi-receipt
-- ============================================
CREATE OR REPLACE FUNCTION rpc_receive_gr(
  p_po_id UUID,
  p_items JSONB,
  p_shipping JSONB DEFAULT '{}'::JSONB,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_gr_id UUID;
  v_gr_no TEXT;
  v_item JSONB;
  v_has_shortage BOOLEAN := FALSE;
  v_total_received NUMERIC := 0;
  v_dom_cost NUMERIC(14,2);
  v_dom_cpp NUMERIC(12,4);
  v_qty_recv NUMERIC;
  v_qty_ord NUMERIC;
  v_qty_short NUMERIC;
  v_today TEXT;
  v_seq INT;
  v_all_fulfilled BOOLEAN;
BEGIN
  -- Allow both 'ordered' and 'partial' POs
  IF NOT EXISTS (SELECT 1 FROM inv_po WHERE id = p_po_id AND status IN ('ordered', 'partial')) THEN
    RAISE EXCEPTION 'PO ไม่อยู่ในสถานะที่รับสินค้าได้';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('gr_no_gen'));

  v_today := to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD');

  SELECT COALESCE(MAX(CAST(SPLIT_PART(gr_no, '-', 3) AS INTEGER)), 0) + 1
  INTO v_seq
  FROM inv_gr
  WHERE gr_no LIKE 'GR-' || v_today || '-___';

  v_gr_no := 'GR-' || v_today || '-' || lpad(v_seq::text, 3, '0');

  INSERT INTO inv_gr (
    gr_no, po_id, status, received_by, received_at, note,
    dom_shipping_company, dom_shipping_cost, shortage_note
  )
  VALUES (
    v_gr_no, p_po_id, 'received', p_user_id, NOW(), p_shipping->>'note',
    p_shipping->>'dom_shipping_company',
    (p_shipping->>'dom_shipping_cost')::NUMERIC,
    p_shipping->>'shortage_note'
  )
  RETURNING id INTO v_gr_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty_recv := (v_item->>'qty_received')::NUMERIC;
    v_qty_ord  := (v_item->>'qty_ordered')::NUMERIC;
    v_qty_short := GREATEST(v_qty_ord - v_qty_recv, 0);

    IF v_qty_short > 0 THEN
      v_has_shortage := TRUE;
    END IF;

    v_total_received := v_total_received + v_qty_recv;

    INSERT INTO inv_gr_items (gr_id, product_id, qty_received, qty_ordered, qty_shortage, shortage_note)
    VALUES (
      v_gr_id,
      (v_item->>'product_id')::UUID,
      v_qty_recv,
      v_qty_ord,
      v_qty_short,
      v_item->>'shortage_note'
    );

    -- Update cumulative received total on PO item
    UPDATE inv_po_items
    SET qty_received_total = qty_received_total + v_qty_recv
    WHERE po_id = p_po_id AND product_id = (v_item->>'product_id')::UUID;

    IF v_qty_recv > 0 THEN
      INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES ((v_item->>'product_id')::UUID, v_qty_recv, 0, 0)
      ON CONFLICT (product_id) DO UPDATE SET
        on_hand = inv_stock_balances.on_hand + v_qty_recv,
        updated_at = NOW();

      INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note, created_by)
      VALUES (
        (v_item->>'product_id')::UUID,
        'gr',
        v_qty_recv,
        'inv_gr',
        v_gr_id,
        'รับเข้าจาก GR ' || v_gr_no,
        p_user_id
      );
    END IF;
  END LOOP;

  v_dom_cost := (p_shipping->>'dom_shipping_cost')::NUMERIC;
  IF v_dom_cost IS NOT NULL AND v_dom_cost > 0 AND v_total_received > 0 THEN
    v_dom_cpp := v_dom_cost / v_total_received;
    UPDATE inv_gr SET dom_cost_per_piece = v_dom_cpp WHERE id = v_gr_id;
  END IF;

  IF v_has_shortage THEN
    UPDATE inv_gr SET status = 'partial' WHERE id = v_gr_id;
  END IF;

  -- Determine PO status: check all items
  SELECT NOT EXISTS (
    SELECT 1 FROM inv_po_items
    WHERE po_id = p_po_id
      AND (qty_received_total + COALESCE(resolution_qty, 0)) < qty
  ) INTO v_all_fulfilled;

  IF v_all_fulfilled THEN
    UPDATE inv_po SET status = 'received' WHERE id = p_po_id;
  ELSE
    UPDATE inv_po SET status = 'partial' WHERE id = p_po_id;
  END IF;

  RETURN jsonb_build_object(
    'id', v_gr_id,
    'gr_no', v_gr_no,
    'status', CASE WHEN v_has_shortage THEN 'partial' ELSE 'received' END,
    'total_received', v_total_received
  );
END;
$$;

-- ============================================
-- 4. New RPC: resolve PO shortages (refund / wrong item / cancel)
-- ============================================
CREATE OR REPLACE FUNCTION rpc_resolve_po_shortage(
  p_po_id UUID,
  p_resolutions JSONB,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_res JSONB;
  v_po_item_id UUID;
  v_type TEXT;
  v_qty NUMERIC;
  v_note TEXT;
  v_all_fulfilled BOOLEAN;
  v_updated_count INT := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inv_po WHERE id = p_po_id AND status IN ('partial')) THEN
    RAISE EXCEPTION 'PO ไม่อยู่ในสถานะที่จัดการยอดค้างได้';
  END IF;

  FOR v_res IN SELECT * FROM jsonb_array_elements(p_resolutions)
  LOOP
    v_po_item_id := (v_res->>'po_item_id')::UUID;
    v_type := v_res->>'resolution_type';
    v_qty := (v_res->>'resolution_qty')::NUMERIC;
    v_note := v_res->>'resolution_note';

    UPDATE inv_po_items
    SET resolution_type = v_type,
        resolution_qty = COALESCE(v_qty, qty - qty_received_total),
        resolution_note = v_note,
        resolved_at = NOW(),
        resolved_by = p_user_id
    WHERE id = v_po_item_id AND po_id = p_po_id;

    v_updated_count := v_updated_count + 1;
  END LOOP;

  -- Check if all items are fulfilled (received + resolved >= ordered)
  SELECT NOT EXISTS (
    SELECT 1 FROM inv_po_items
    WHERE po_id = p_po_id
      AND (qty_received_total + COALESCE(resolution_qty, 0)) < qty
  ) INTO v_all_fulfilled;

  IF v_all_fulfilled THEN
    UPDATE inv_po SET status = 'closed' WHERE id = p_po_id;
  END IF;

  RETURN jsonb_build_object(
    'success', TRUE,
    'updated_count', v_updated_count,
    'po_status', CASE WHEN v_all_fulfilled THEN 'closed' ELSE 'partial' END
  );
END;
$$;
