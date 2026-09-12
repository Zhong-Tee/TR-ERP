-- ============================================
-- 130: Allow editing PR (pending) and PO (open)
-- ============================================

-- 1. RPC: Update PR (only when status = 'pending')
CREATE OR REPLACE FUNCTION rpc_update_pr(
  p_pr_id UUID,
  p_items JSONB,
  p_note TEXT DEFAULT NULL,
  p_pr_type TEXT DEFAULT NULL,
  p_supplier_id UUID DEFAULT NULL,
  p_supplier_name TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item JSONB;
  v_last_price NUMERIC(12,2);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inv_pr WHERE id = p_pr_id AND status = 'pending') THEN
    RAISE EXCEPTION 'PR ไม่อยู่ในสถานะรออนุมัติ ไม่สามารถแก้ไขได้';
  END IF;

  UPDATE inv_pr
  SET note = COALESCE(p_note, note),
      pr_type = COALESCE(p_pr_type, pr_type),
      supplier_id = p_supplier_id,
      supplier_name = p_supplier_name,
      updated_at = NOW()
  WHERE id = p_pr_id;

  DELETE FROM inv_pr_items WHERE pr_id = p_pr_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT last_price INTO v_last_price
    FROM v_product_last_price
    WHERE product_id = (v_item->>'product_id')::UUID;

    INSERT INTO inv_pr_items (pr_id, product_id, qty, unit, estimated_price, last_purchase_price, note)
    VALUES (
      p_pr_id,
      (v_item->>'product_id')::UUID,
      (v_item->>'qty')::NUMERIC,
      v_item->>'unit',
      (v_item->>'estimated_price')::NUMERIC,
      COALESCE(v_last_price, NULL),
      v_item->>'note'
    );
  END LOOP;
END;
$$;

-- 2. RPC: Update PO (only when status = 'open')
CREATE OR REPLACE FUNCTION rpc_update_po(
  p_po_id UUID,
  p_note TEXT DEFAULT NULL,
  p_expected_arrival_date DATE DEFAULT NULL,
  p_items JSONB DEFAULT '[]'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item JSONB;
  v_total NUMERIC := 0;
  v_subtotal NUMERIC;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inv_po WHERE id = p_po_id AND status = 'open') THEN
    RAISE EXCEPTION 'PO ไม่อยู่ในสถานะเปิด ไม่สามารถแก้ไขได้';
  END IF;

  UPDATE inv_po
  SET note = p_note,
      expected_arrival_date = p_expected_arrival_date,
      updated_at = NOW()
  WHERE id = p_po_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_subtotal := COALESCE((v_item->>'unit_price')::NUMERIC, 0) * COALESCE((v_item->>'qty')::NUMERIC, 0);
    v_total := v_total + v_subtotal;

    UPDATE inv_po_items
    SET unit_price = (v_item->>'unit_price')::NUMERIC,
        qty = COALESCE((v_item->>'qty')::NUMERIC, qty),
        note = v_item->>'note',
        subtotal = v_subtotal
    WHERE id = (v_item->>'item_id')::UUID AND po_id = p_po_id;
  END LOOP;

  UPDATE inv_po SET total_amount = v_total WHERE id = p_po_id;

  RETURN jsonb_build_object('total_amount', v_total);
END;
$$;
