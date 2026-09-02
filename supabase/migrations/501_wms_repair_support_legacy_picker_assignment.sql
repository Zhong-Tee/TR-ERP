-- 501: A legacy Picker row may have fulfillment_mode NULL.  Reuse its picker
-- when repairing a missing WMS line; NULL is already treated as warehouse_pick
-- throughout the WMS UI.

CREATE OR REPLACE FUNCTION public.rpc_repair_wms_missing_item(p_order_item_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_role TEXT; v_item RECORD; v_existing NUMERIC; v_missing NUMERIC; v_picker UUID; v_mode TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id=auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ซ่อมสต๊อค';
  END IF;

  SELECT oi.id,oi.order_id,oi.product_name,COALESCE(oi.quantity,1)::NUMERIC qty,
    o.work_order_id,o.work_order_name,p.product_code::TEXT product_code,
    COALESCE(p.storage_location::TEXT,'') location,
    COALESCE(NULLIF(BTRIM(p.unit_name::TEXT),''),'ชิ้น') unit_name,
    public.fn_wms_is_pickable_category(p.product_category::TEXT) pickable
  INTO v_item
  FROM public.or_order_items oi
  JOIN public.or_orders o ON o.id=oi.order_id
  JOIN public.pr_products p ON p.id=oi.product_id
  WHERE oi.id=p_order_item_id AND NOT COALESCE(oi.is_detail_row,false)
  FOR UPDATE OF oi;

  IF v_item.id IS NULL OR v_item.work_order_id IS NULL THEN
    RAISE EXCEPTION 'ไม่พบรายการหรือรายการยังไม่มีใบงาน';
  END IF;

  SELECT COALESCE(SUM(qty),0) INTO v_existing
  FROM public.wms_orders
  WHERE source_order_item_id=p_order_item_id AND status<>'cancelled';
  v_missing:=v_item.qty-v_existing;

  IF v_missing<=0 THEN
    RETURN jsonb_build_object('success',true,'created_qty',0,'message','รายการตรงกันแล้ว');
  END IF;
  IF public.fn_wms_item_has_legacy_stock_conflict(p_order_item_id) THEN
    RAISE EXCEPTION 'พบ WMS/Movement รุ่นเก่าหรือยอด Movement ไม่สัมพันธ์ ระบบบล็อกเพื่อป้องกันตัดซ้ำ';
  END IF;

  IF v_item.pickable THEN
    SELECT assigned_to INTO v_picker
    FROM public.wms_orders
    WHERE work_order_id=v_item.work_order_id
      AND (fulfillment_mode='warehouse_pick' OR fulfillment_mode IS NULL)
      AND status<>'cancelled'
      AND assigned_to IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1;
    IF v_picker IS NULL THEN
      RAISE EXCEPTION 'ไม่พบผู้หยิบของใบงาน กรุณามอบหมาย Picker ก่อน';
    END IF;
    v_mode:='warehouse_pick';
  ELSE
    v_mode:='system_complete';
  END IF;

  INSERT INTO public.wms_orders(
    work_order_id,order_id,source_order_id,source_order_item_id,product_code,
    product_name,location,qty,unit_name,status,assigned_to,fulfillment_mode
  ) VALUES (
    v_item.work_order_id,v_item.work_order_name,v_item.order_id,v_item.id,v_item.product_code,
    v_item.product_name,v_item.location,v_missing,v_item.unit_name,'pending',v_picker,v_mode
  );

  IF v_mode='system_complete' THEN
    UPDATE public.wms_orders SET status='correct',end_time=NOW()
    WHERE source_order_item_id=v_item.id AND status='pending'
      AND fulfillment_mode='system_complete';
  END IF;

  RETURN jsonb_build_object('success',true,'created_qty',v_missing,'mode',v_mode);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_repair_wms_missing_item(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_repair_wms_missing_item(UUID) TO authenticated,service_role;

COMMENT ON FUNCTION public.rpc_repair_wms_missing_item(UUID) IS
  'Repairs one missing WMS line with legacy duplicate safeguards and supports legacy NULL fulfillment_mode picker assignments.';
