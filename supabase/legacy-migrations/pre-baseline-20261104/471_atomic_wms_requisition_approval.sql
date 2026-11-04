-- Approve a WMS requisition and create Picker jobs in one transaction.
-- The stock workflow remains: reserve when Picker marks "picked", deduct/FIFO when review marks "correct".

CREATE OR REPLACE FUNCTION public.approve_wms_requisition(
  p_requisition_id UUID,
  p_picker_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_picker_role TEXT;
  v_requisition public.wms_requisitions%ROWTYPE;
  v_item_count INTEGER;
BEGIN
  SELECT role INTO v_role
  FROM public.us_users
  WHERE id = v_uid;

  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติใบเบิก';
  END IF;

  SELECT role INTO v_picker_role
  FROM public.us_users
  WHERE id = p_picker_id;

  IF v_picker_role IS DISTINCT FROM 'picker' THEN
    RAISE EXCEPTION 'ผู้รับงานที่เลือกไม่ใช่ Picker';
  END IF;

  SELECT * INTO v_requisition
  FROM public.wms_requisitions
  WHERE id = p_requisition_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบใบเบิก';
  END IF;

  IF v_requisition.status <> 'pending' THEN
    RAISE EXCEPTION 'ใบเบิกนี้ไม่ได้อยู่ในสถานะรออนุมัติ (สถานะ: %)', v_requisition.status;
  END IF;

  SELECT COUNT(*) INTO v_item_count
  FROM public.wms_requisition_items
  WHERE requisition_id = v_requisition.requisition_id;

  IF v_item_count = 0 THEN
    RAISE EXCEPTION 'ใบเบิกนี้ไม่มีรายการสินค้า';
  END IF;

  UPDATE public.wms_requisitions
  SET status = 'approved',
      approved_by = v_uid,
      approved_at = NOW()
  WHERE id = p_requisition_id;

  INSERT INTO public.wms_orders (
    order_id, product_code, product_name, location, qty, assigned_to, status
  )
  SELECT
    v_requisition.requisition_id,
    item.product_code,
    item.product_name,
    item.location,
    item.qty,
    p_picker_id,
    'pending'
  FROM public.wms_requisition_items item
  WHERE item.requisition_id = v_requisition.requisition_id
  ORDER BY item.created_at, item.id;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_wms_requisition(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_wms_requisition(UUID, UUID) TO authenticated;

