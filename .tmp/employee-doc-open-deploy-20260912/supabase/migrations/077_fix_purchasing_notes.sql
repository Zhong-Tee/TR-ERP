-- 077: Fix purchasing notes – add p_note to rpc_convert_pr_to_po, copy item notes to PO items
-- ============================================

-- 1. Update rpc_convert_pr_to_po: accept p_note and copy item-level notes
CREATE OR REPLACE FUNCTION rpc_convert_pr_to_po(
  p_pr_id UUID,
  p_supplier_id UUID DEFAULT NULL,
  p_supplier_name TEXT DEFAULT NULL,
  p_prices JSONB DEFAULT '[]'::JSONB,
  p_note TEXT DEFAULT NULL
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
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inv_pr WHERE id = p_pr_id AND status = 'approved') THEN
    RAISE EXCEPTION 'PR ไม่อยู่ในสถานะอนุมัติ';
  END IF;

  IF EXISTS (SELECT 1 FROM inv_po WHERE pr_id = p_pr_id) THEN
    RAISE EXCEPTION 'PR นี้ถูกแปลงเป็น PO แล้ว';
  END IF;

  v_po_no := 'PO-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(floor(random()*9000+1000)::text, 4, '0');

  INSERT INTO inv_po (po_no, pr_id, status, supplier_id, supplier_name, note)
  VALUES (v_po_no, p_pr_id, 'open', p_supplier_id, p_supplier_name, p_note)
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
