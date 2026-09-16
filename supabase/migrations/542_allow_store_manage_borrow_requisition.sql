BEGIN;

-- Keep the browser permissions and database permissions aligned for the store role.
-- The row locks also prevent two concurrent actions from resolving the same borrow twice.
CREATE OR REPLACE FUNCTION public.approve_borrow_requisition(
  p_borrow_id UUID,
  p_user_id   UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   TEXT;
  v_status TEXT;
  v_item   RECORD;
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ผู้ใช้งานไม่ตรงกับ session ปัจจุบัน';
  END IF;

  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติรายการยืม (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT status INTO v_status
  FROM public.wms_borrow_requisitions
  WHERE id = p_borrow_id
  FOR UPDATE;

  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการยืม'; END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'รายการนี้ไม่อยู่ในสถานะรออนุมัติ (status: %)', v_status;
  END IF;

  FOR v_item IN
    SELECT product_id, qty
    FROM public.wms_borrow_requisition_items
    WHERE borrow_requisition_id = p_borrow_id
  LOOP
    INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_item.product_id, 0, v_item.qty, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET reserved = COALESCE(public.inv_stock_balances.reserved, 0) + v_item.qty;
  END LOOP;

  UPDATE public.wms_borrow_requisitions
  SET status = 'approved', approved_by = auth.uid(), approved_at = NOW()
  WHERE id = p_borrow_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.return_borrow_requisition(
  p_borrow_id UUID,
  p_items     JSONB,
  p_user_id   UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role        TEXT;
  v_status      TEXT;
  v_item        JSONB;
  v_product_id  UUID;
  v_return_qty  NUMERIC;
  v_borrow_item RECORD;
  v_all_done    BOOLEAN;
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ผู้ใช้งานไม่ตรงกับ session ปัจจุบัน';
  END IF;

  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์รับคืนรายการยืม (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT status INTO v_status
  FROM public.wms_borrow_requisitions
  WHERE id = p_borrow_id
  FOR UPDATE;

  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการยืม'; END IF;
  IF v_status NOT IN ('approved', 'partial_returned', 'overdue') THEN
    RAISE EXCEPTION 'ไม่สามารถคืนได้ (status: %)', v_status;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_return_qty := (v_item->>'return_qty')::NUMERIC;
    IF v_return_qty IS NULL OR v_return_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_borrow_item
    FROM public.wms_borrow_requisition_items
    WHERE borrow_requisition_id = p_borrow_id AND product_id = v_product_id
    FOR UPDATE;

    IF v_borrow_item IS NULL THEN CONTINUE; END IF;
    IF v_borrow_item.returned_qty + v_borrow_item.written_off_qty + v_return_qty > v_borrow_item.qty THEN
      RAISE EXCEPTION 'จำนวนคืนเกินจำนวนที่ยืม (สินค้า: %)', v_product_id;
    END IF;

    UPDATE public.wms_borrow_requisition_items
    SET returned_qty = returned_qty + v_return_qty
    WHERE id = v_borrow_item.id;

    UPDATE public.inv_stock_balances
    SET reserved = GREATEST(COALESCE(reserved, 0) - v_return_qty, 0)
    WHERE product_id = v_product_id;
  END LOOP;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.wms_borrow_requisition_items
    WHERE borrow_requisition_id = p_borrow_id
      AND (returned_qty + written_off_qty) < qty
  ) INTO v_all_done;

  IF v_all_done THEN
    UPDATE public.wms_borrow_requisitions
    SET status = 'returned', returned_at = NOW()
    WHERE id = p_borrow_id;
  ELSE
    UPDATE public.wms_borrow_requisitions
    SET status = 'partial_returned'
    WHERE id = p_borrow_id AND status <> 'partial_returned';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.write_off_borrow_requisition(
  p_borrow_id UUID,
  p_items     JSONB,
  p_user_id   UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role        TEXT;
  v_status      TEXT;
  v_item        JSONB;
  v_product_id  UUID;
  v_wo_qty      NUMERIC;
  v_borrow_item RECORD;
  v_movement_id UUID;
  v_all_done    BOOLEAN;
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ผู้ใช้งานไม่ตรงกับ session ปัจจุบัน';
  END IF;

  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตัดรายการยืมเป็นของเสีย (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT status INTO v_status
  FROM public.wms_borrow_requisitions
  WHERE id = p_borrow_id
  FOR UPDATE;

  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการยืม'; END IF;
  IF v_status NOT IN ('approved', 'partial_returned', 'overdue') THEN
    RAISE EXCEPTION 'ไม่สามารถตัดเป็นของเสียได้ (status: %)', v_status;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_wo_qty := (v_item->>'write_off_qty')::NUMERIC;
    IF v_wo_qty IS NULL OR v_wo_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_borrow_item
    FROM public.wms_borrow_requisition_items
    WHERE borrow_requisition_id = p_borrow_id AND product_id = v_product_id
    FOR UPDATE;

    IF v_borrow_item IS NULL THEN CONTINUE; END IF;
    IF v_borrow_item.returned_qty + v_borrow_item.written_off_qty + v_wo_qty > v_borrow_item.qty THEN
      RAISE EXCEPTION 'จำนวนตัดเสียเกินจำนวนที่ยืม (สินค้า: %)', v_product_id;
    END IF;

    UPDATE public.wms_borrow_requisition_items
    SET written_off_qty = written_off_qty + v_wo_qty
    WHERE id = v_borrow_item.id;

    UPDATE public.inv_stock_balances
    SET on_hand = COALESCE(on_hand, 0) - v_wo_qty,
        reserved = GREATEST(COALESCE(reserved, 0) - v_wo_qty, 0)
    WHERE product_id = v_product_id;

    INSERT INTO public.inv_stock_movements (
      product_id, movement_type, qty, ref_type, ref_id, note, created_by
    )
    VALUES (
      v_product_id, 'waste', -v_wo_qty,
      'wms_borrow_requisitions', p_borrow_id,
      'ตัดเป็นของเสีย (ยืมแล้วคืนไม่ได้)', auth.uid()
    )
    RETURNING id INTO v_movement_id;

    PERFORM public.fn_consume_stock_fifo(v_product_id, v_wo_qty, v_movement_id);
    PERFORM public.fn_recalc_product_landed_cost(v_product_id);
  END LOOP;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.wms_borrow_requisition_items
    WHERE borrow_requisition_id = p_borrow_id
      AND (returned_qty + written_off_qty) < qty
  ) INTO v_all_done;

  IF v_all_done THEN
    UPDATE public.wms_borrow_requisitions
    SET status = 'written_off', returned_at = NOW()
    WHERE id = p_borrow_id;
  ELSE
    UPDATE public.wms_borrow_requisitions
    SET status = 'partial_returned'
    WHERE id = p_borrow_id AND status <> 'partial_returned';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_borrow_requisition(
  p_borrow_id UUID,
  p_user_id   UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   TEXT;
  v_status TEXT;
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ผู้ใช้งานไม่ตรงกับ session ปัจจุบัน';
  END IF;

  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ปฏิเสธรายการยืม (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT status INTO v_status
  FROM public.wms_borrow_requisitions
  WHERE id = p_borrow_id
  FOR UPDATE;

  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการยืม'; END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'รายการนี้ไม่อยู่ในสถานะรออนุมัติ (status: %)', v_status;
  END IF;

  UPDATE public.wms_borrow_requisitions
  SET status = 'rejected', approved_by = auth.uid(), approved_at = NOW()
  WHERE id = p_borrow_id;
END;
$$;

COMMIT;
