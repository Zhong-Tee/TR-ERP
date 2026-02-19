-- ============================================
-- 098: Product Landed Cost
-- Calculates full cost per piece = unit_price + intl_shipping/piece + dom_shipping/piece
-- ============================================

-- 1. Add landed_cost column to pr_products
ALTER TABLE pr_products ADD COLUMN IF NOT EXISTS landed_cost NUMERIC(14,4) DEFAULT 0;

-- 2. Helper: recalculate landed cost for all products in a given PO
CREATE OR REPLACE FUNCTION fn_update_product_landed_costs(p_po_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total_qty NUMERIC;
  v_intl_shipping_thb NUMERIC;
  v_intl_cpp NUMERIC;
  v_total_dom_cost NUMERIC;
  v_total_dom_received NUMERIC;
  v_dom_cpp NUMERIC;
  v_rec RECORD;
BEGIN
  SELECT SUM(qty) INTO v_total_qty
  FROM inv_po_items WHERE po_id = p_po_id;

  IF v_total_qty IS NULL OR v_total_qty = 0 THEN RETURN; END IF;

  SELECT COALESCE(intl_shipping_cost_thb, 0)
  INTO v_intl_shipping_thb
  FROM inv_po WHERE id = p_po_id;

  v_intl_cpp := v_intl_shipping_thb / v_total_qty;

  SELECT
    COALESCE(SUM(gr.dom_shipping_cost), 0),
    COALESCE(SUM(gi_agg.total_recv), 0)
  INTO v_total_dom_cost, v_total_dom_received
  FROM inv_gr gr
  LEFT JOIN LATERAL (
    SELECT SUM(qty_received) AS total_recv FROM inv_gr_items WHERE gr_id = gr.id
  ) gi_agg ON TRUE
  WHERE gr.po_id = p_po_id;

  v_dom_cpp := CASE
    WHEN v_total_dom_received > 0 THEN v_total_dom_cost / v_total_dom_received
    ELSE 0
  END;

  FOR v_rec IN
    SELECT product_id, COALESCE(unit_price, 0) AS unit_price
    FROM inv_po_items WHERE po_id = p_po_id
  LOOP
    UPDATE pr_products
    SET landed_cost = v_rec.unit_price + v_intl_cpp + v_dom_cpp
    WHERE id = v_rec.product_id;
  END LOOP;
END;
$$;

-- 3. Replace rpc_receive_gr to also recalc landed costs after receipt
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

  -- Recalculate landed cost for all products in this PO
  PERFORM fn_update_product_landed_costs(p_po_id);

  RETURN jsonb_build_object(
    'id', v_gr_id,
    'gr_no', v_gr_no,
    'status', CASE WHEN v_has_shortage THEN 'partial' ELSE 'received' END,
    'total_received', v_total_received
  );
END;
$$;

-- 4. RPC to recalculate landed cost (called when PO shipping is updated)
CREATE OR REPLACE FUNCTION rpc_recalc_po_landed_cost(p_po_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM fn_update_product_landed_costs(p_po_id);
END;
$$;

-- 5. Backfill: recalculate landed costs for all existing POs that have been received
DO $$
DECLARE
  v_po RECORD;
BEGIN
  FOR v_po IN
    SELECT DISTINCT po.id
    FROM inv_po po
    WHERE po.status IN ('received', 'partial', 'closed')
       OR po.intl_shipping_cost_thb IS NOT NULL
  LOOP
    PERFORM fn_update_product_landed_costs(v_po.id);
  END LOOP;
END;
$$;
