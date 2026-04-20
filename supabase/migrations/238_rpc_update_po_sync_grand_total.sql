-- หลังแก้ไขรายการ PO: total_amount ถูกคำนวณใหม่ แต่ grand_total ค้างค่าเก่า
-- ทำให้หน้ารายการ PO แสดงยอดรวมไม่ตรงกับราคาต่อหน่วย (คอลัมน์ราคา/หน่วยใช้ total_amount)
CREATE OR REPLACE FUNCTION rpc_update_po(
  p_po_id UUID,
  p_note TEXT DEFAULT NULL,
  p_expected_arrival_date DATE DEFAULT NULL,
  p_items JSONB DEFAULT '[]'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_item JSONB;
  v_total NUMERIC := 0;
  v_subtotal NUMERIC;
  v_ship_thb NUMERIC;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไข PO (role: %)', COALESCE(v_role, 'unknown');
  END IF;

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

  SELECT intl_shipping_cost_thb INTO v_ship_thb FROM inv_po WHERE id = p_po_id;

  UPDATE inv_po
  SET
    total_amount = v_total,
    grand_total = v_total + COALESCE(v_ship_thb, 0)
  WHERE id = p_po_id;

  RETURN jsonb_build_object('total_amount', v_total);
END;
$$;
