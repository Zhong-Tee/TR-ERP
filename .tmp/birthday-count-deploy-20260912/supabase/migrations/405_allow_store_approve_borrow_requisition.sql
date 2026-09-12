BEGIN;

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
      SET reserved = inv_stock_balances.reserved + v_item.qty;
  END LOOP;

  UPDATE public.wms_borrow_requisitions
  SET status = 'approved', approved_by = auth.uid(), approved_at = NOW()
  WHERE id = p_borrow_id;
END;
$$;

COMMIT;
