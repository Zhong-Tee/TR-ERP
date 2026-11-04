-- ============================================
-- 096: Sequential numbering for PR/PO/GR + PO created_by
-- ============================================

-- 1. Add created_by to inv_po
ALTER TABLE inv_po ADD COLUMN IF NOT EXISTS created_by UUID;

-- 1.1 Add pr_type to inv_pr (ปกติ / ด่วน)
ALTER TABLE inv_pr ADD COLUMN IF NOT EXISTS pr_type TEXT DEFAULT 'normal';

-- 1.2 Add expected_arrival_date to inv_po
ALTER TABLE inv_po ADD COLUMN IF NOT EXISTS expected_arrival_date DATE;

-- ============================================
-- 2. Update rpc_create_pr with sequential numbering (daily reset)
-- ============================================
CREATE OR REPLACE FUNCTION rpc_create_pr(
  p_items JSONB,
  p_note TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_pr_type TEXT DEFAULT 'normal'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pr_id UUID;
  v_pr_no TEXT;
  v_item JSONB;
  v_last_price NUMERIC(12,2);
  v_today TEXT;
  v_seq INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pr_no_gen'));

  v_today := to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD');

  SELECT COALESCE(MAX(CAST(SPLIT_PART(pr_no, '-', 3) AS INTEGER)), 0) + 1
  INTO v_seq
  FROM inv_pr
  WHERE pr_no LIKE 'PR-' || v_today || '-___';

  v_pr_no := 'PR-' || v_today || '-' || lpad(v_seq::text, 3, '0');

  INSERT INTO inv_pr (pr_no, status, requested_by, requested_at, note, pr_type)
  VALUES (v_pr_no, 'pending', p_user_id, NOW(), p_note, COALESCE(p_pr_type, 'normal'))
  RETURNING id INTO v_pr_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT last_price INTO v_last_price
    FROM v_product_last_price
    WHERE product_id = (v_item->>'product_id')::UUID;

    INSERT INTO inv_pr_items (pr_id, product_id, qty, unit, estimated_price, last_purchase_price, note)
    VALUES (
      v_pr_id,
      (v_item->>'product_id')::UUID,
      (v_item->>'qty')::NUMERIC,
      v_item->>'unit',
      (v_item->>'estimated_price')::NUMERIC,
      COALESCE(v_last_price, NULL),
      v_item->>'note'
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_pr_id, 'pr_no', v_pr_no);
END;
$$;

-- ============================================
-- 3. Update rpc_convert_pr_to_po with sequential numbering + created_by
-- ============================================
CREATE OR REPLACE FUNCTION rpc_convert_pr_to_po(
  p_pr_id UUID,
  p_supplier_id UUID DEFAULT NULL,
  p_supplier_name TEXT DEFAULT NULL,
  p_prices JSONB DEFAULT '[]'::JSONB,
  p_note TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_po_id UUID;
  v_po_no TEXT;
  v_total NUMERIC(14,2) := 0;
  v_pr_item RECORD;
  v_price NUMERIC(12,2);
  v_subtotal NUMERIC(14,2);
  v_today TEXT;
  v_seq INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inv_pr WHERE id = p_pr_id AND status = 'approved') THEN
    RAISE EXCEPTION 'PR ไม่อยู่ในสถานะอนุมัติ';
  END IF;

  IF EXISTS (SELECT 1 FROM inv_po WHERE pr_id = p_pr_id) THEN
    RAISE EXCEPTION 'PR นี้ถูกแปลงเป็น PO แล้ว';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('po_no_gen'));

  v_today := to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD');

  SELECT COALESCE(MAX(CAST(SPLIT_PART(po_no, '-', 3) AS INTEGER)), 0) + 1
  INTO v_seq
  FROM inv_po
  WHERE po_no LIKE 'PO-' || v_today || '-___';

  v_po_no := 'PO-' || v_today || '-' || lpad(v_seq::text, 3, '0');

  INSERT INTO inv_po (po_no, pr_id, status, supplier_id, supplier_name, note, created_by)
  VALUES (v_po_no, p_pr_id, 'open', p_supplier_id, p_supplier_name, p_note, p_user_id)
  RETURNING id INTO v_po_id;

  FOR v_pr_item IN
    SELECT pri.product_id, pri.qty, pri.unit, pri.estimated_price, pri.note
    FROM inv_pr_items pri
    WHERE pri.pr_id = p_pr_id
  LOOP
    v_price := NULL;
    SELECT (elem->>'unit_price')::NUMERIC INTO v_price
    FROM jsonb_array_elements(p_prices) elem
    WHERE (elem->>'product_id')::UUID = v_pr_item.product_id
    LIMIT 1;

    IF v_price IS NULL THEN
      v_price := v_pr_item.estimated_price;
    END IF;
    IF v_price IS NULL THEN
      SELECT last_price INTO v_price FROM v_product_last_price WHERE product_id = v_pr_item.product_id;
    END IF;

    v_subtotal := COALESCE(v_price, 0) * v_pr_item.qty;
    v_total := v_total + v_subtotal;

    INSERT INTO inv_po_items (po_id, product_id, qty, unit_price, subtotal, unit, note)
    VALUES (v_po_id, v_pr_item.product_id, v_pr_item.qty, v_price, v_subtotal, v_pr_item.unit, v_pr_item.note);
  END LOOP;

  UPDATE inv_po SET total_amount = v_total, grand_total = v_total WHERE id = v_po_id;

  RETURN jsonb_build_object('id', v_po_id, 'po_no', v_po_no, 'total_amount', v_total);
END;
$$;

-- ============================================
-- 4. Update rpc_receive_gr with sequential numbering
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
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inv_po WHERE id = p_po_id AND status IN ('ordered')) THEN
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

  UPDATE inv_po SET status = CASE WHEN v_has_shortage THEN 'partial' ELSE 'received' END WHERE id = p_po_id;

  RETURN jsonb_build_object(
    'id', v_gr_id,
    'gr_no', v_gr_no,
    'status', CASE WHEN v_has_shortage THEN 'partial' ELSE 'received' END,
    'total_received', v_total_received
  );
END;
$$;
