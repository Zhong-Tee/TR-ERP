-- AFTER ROW triggers see every bill linked by the bulk UPDATE. Previously each
-- bill therefore scanned the whole work order again, before the RPC's final scan.
-- Defer only that trigger for this RPC's new UUID; keep one authoritative WMS
-- pass after all links and the plan row exist. Stock/FIFO functions are unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION public.trg_or_orders_try_auto_non_pick()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_nm TEXT;
BEGIN
  IF NEW.work_order_id IS NOT NULL
     AND current_setting('app.defer_auto_wms_work_order_id',true)=NEW.work_order_id::TEXT THEN
    RETURN NEW;
  END IF;
  v_nm:=trim(both FROM coalesce(NEW.work_order_name,''));
  IF v_nm='' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE'
     AND trim(both FROM coalesce(OLD.work_order_name,'')) IS NOT DISTINCT FROM v_nm THEN
    RETURN NEW;
  END IF;
  PERFORM public.fn_wms_try_auto_consume_non_pick(v_nm);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_create_work_order_with_plan(
  p_work_order_name TEXT,p_order_ids UUID[],p_plan_job_id TEXT,p_plan_date TEXT,
  p_cut TEXT,p_qty JSONB,p_order_index INTEGER
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_role TEXT; v_work_order_id UUID; v_requested INT; v_locked INT; v_auto_end TIMESTAMPTZ;
  v_previous_deferred_work_order TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id=auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','order_staff','packing_staff','manager','production') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์สร้างใบงาน';
  END IF;
  IF NULLIF(BTRIM(COALESCE(p_work_order_name,'')),'') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_plan_job_id,'')),'') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_plan_date,'')),'') IS NULL
     OR COALESCE(CARDINALITY(p_order_ids),0)=0 THEN
    RAISE EXCEPTION 'ข้อมูลสร้างใบงานไม่ครบ';
  END IF;
  v_requested:=(SELECT COUNT(DISTINCT id) FROM UNNEST(p_order_ids) AS requested(id));
  PERFORM 1 FROM public.or_orders WHERE id=ANY(p_order_ids) ORDER BY id FOR UPDATE;
  SELECT COUNT(*) INTO v_locked FROM public.or_orders
  WHERE id=ANY(p_order_ids) AND work_order_id IS NULL
    AND (
      status IN ('ใบสั่งงาน','คอนเฟิร์มแล้ว','เสร็จสิ้น','ย้ายจากใบงาน')
      OR (status='ตรวจสอบแล้ว' AND UPPER(BTRIM(COALESCE(channel_code,'')))='WY')
    );
  IF v_locked<>v_requested THEN
    RAISE EXCEPTION 'มีบิลบางรายการไม่อยู่ในคิวหรือถูกนำไปสร้างใบงานแล้ว กรุณารีเฟรช';
  END IF;

  INSERT INTO public.or_work_orders(work_order_name,status,order_count)
  VALUES(BTRIM(p_work_order_name),'กำลังผลิต',v_requested)
  RETURNING id INTO v_work_order_id;

  v_previous_deferred_work_order:=current_setting('app.defer_auto_wms_work_order_id',true);
  PERFORM set_config('app.defer_auto_wms_work_order_id',v_work_order_id::TEXT,true);
  UPDATE public.or_orders SET
    work_order_id=v_work_order_id,work_order_name=BTRIM(p_work_order_name),
    plan_released_from_work_order=NULL,plan_released_from_work_order_id=NULL,plan_released_at=NULL,
    status=CASE WHEN status='ย้ายจากใบงาน' THEN 'ใบสั่งงาน' ELSE status END
  WHERE id=ANY(p_order_ids);
  -- Restore before any other work; PostgreSQL also rolls this local setting
  -- back together with the statement if a validation/stock trigger raises.
  PERFORM set_config('app.defer_auto_wms_work_order_id',COALESCE(v_previous_deferred_work_order,''),true);

  INSERT INTO public.plan_jobs(id,date,name,work_order_id,cut,qty,tracks,line_assignments,
    manual_plan_starts,locked_plans,order_index)
  VALUES(BTRIM(p_plan_job_id),BTRIM(p_plan_date),BTRIM(p_work_order_name),v_work_order_id,p_cut,
    COALESCE(p_qty,'{}'::JSONB),'{}','{}','{}','{}',COALESCE(p_order_index,0));

  PERFORM public.fn_wms_try_auto_consume_non_pick(p_work_order_name);
  IF NOT EXISTS (
    SELECT 1 FROM public.or_orders o JOIN public.or_order_items oi ON oi.order_id=o.id
    JOIN public.pr_products p ON p.id=oi.product_id
    WHERE o.work_order_id=v_work_order_id AND NOT COALESCE(oi.is_detail_row,false)
      AND public.fn_wms_item_fulfillment_mode(p.id,p.product_category::TEXT)='warehouse_pick'
  ) THEN
    SELECT MAX(end_time) INTO v_auto_end FROM public.wms_orders WHERE work_order_id=v_work_order_id;
    v_auto_end:=COALESCE(v_auto_end,NOW());
    PERFORM public.merge_plan_tracks_by_work_order_id(v_work_order_id,'เบิก',jsonb_build_object(
      'หยิบของ',jsonb_build_object('start_if_null',v_auto_end,'end',v_auto_end),
      'ส่งมอบ',jsonb_build_object('start_if_null',v_auto_end,'end',v_auto_end)
    ));
  END IF;
  RETURN jsonb_build_object('success',true,'work_order_id',v_work_order_id,'work_order_name',BTRIM(p_work_order_name));
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_create_work_order_with_plan(TEXT,UUID[],TEXT,TEXT,TEXT,JSONB,INTEGER) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_create_work_order_with_plan(TEXT,UUID[],TEXT,TEXT,TEXT,JSONB,INTEGER) TO authenticated;

COMMIT;
