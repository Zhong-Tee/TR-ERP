BEGIN;

ALTER TABLE public.wms_orders ADD COLUMN IF NOT EXISTS relinked_usage_at timestamptz;
COMMENT ON COLUMN public.wms_orders.relinked_usage_at IS 'Original effective reporting timestamp retained when the fulfillment moves to a replacement work order.';

CREATE TABLE public.wms_work_order_relinks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wms_order_id uuid NOT NULL REFERENCES public.wms_orders(id),
  previous_work_order_id uuid, previous_work_order_name text, work_order_id uuid NOT NULL REFERENCES public.or_work_orders(id),
  work_order_name text NOT NULL, previous_usage_at timestamptz, actor_id uuid REFERENCES public.us_users(id), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wms_work_order_relinks ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_wms_relinks ON public.wms_work_order_relinks FOR SELECT TO authenticated
USING(EXISTS(SELECT 1 FROM public.wms_orders w WHERE w.id=wms_order_id));
REVOKE ALL ON public.wms_work_order_relinks FROM anon,authenticated;
GRANT SELECT ON public.wms_work_order_relinks TO authenticated;

CREATE TABLE public.or_work_order_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_order_id uuid NOT NULL REFERENCES public.or_work_orders(id),
  action text NOT NULL,details jsonb NOT NULL,actor_id uuid REFERENCES public.us_users(id),created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.or_work_order_lifecycle_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_work_order_events ON public.or_work_order_lifecycle_events FOR SELECT TO authenticated
USING(EXISTS(SELECT 1 FROM public.or_work_orders wo WHERE wo.id=work_order_id));
REVOKE ALL ON public.or_work_order_lifecycle_events FROM anon,authenticated;
GRANT SELECT ON public.or_work_order_lifecycle_events TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_relink_wms_to_work_order(p_work_order_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_name text; r record; v_count integer:=0; v_time timestamptz;
BEGIN
  SELECT work_order_name INTO v_name FROM public.or_work_orders WHERE id=p_work_order_id AND status='กำลังผลิต' FOR UPDATE;
  IF v_name IS NULL THEN RAISE EXCEPTION 'ไม่พบใบงานปลายทางที่กำลังผลิต'; END IF;
  FOR r IN
    SELECT w.*,old.status AS old_status,old.work_order_name AS old_name,old.wms_review_completed_at AS old_completed,
      oi.quantity AS item_qty,p.product_code AS item_code
    FROM public.or_orders o JOIN public.or_order_items oi ON oi.order_id=o.id
    JOIN public.pr_products p ON p.id=oi.product_id JOIN public.wms_orders w ON w.source_order_item_id=oi.id
    LEFT JOIN public.or_work_orders old ON old.id=w.work_order_id
    WHERE o.work_order_id=p_work_order_id AND NOT coalesce(oi.is_detail_row,false)
      AND w.status NOT IN ('cancelled','returned')
      AND (w.work_order_id IS DISTINCT FROM p_work_order_id OR w.order_id IS DISTINCT FROM v_name)
    ORDER BY w.id FOR UPDATE OF w
  LOOP
    IF r.work_order_id IS DISTINCT FROM p_work_order_id AND r.old_status IS DISTINCT FROM 'ยกเลิก' THEN
      RAISE EXCEPTION 'มี WMS ผูกใบงานอื่นที่ยังไม่ยกเลิก กรุณาตรวจสอบก่อนสร้างใบงาน';
    END IF;
    IF r.stock_action IS NOT NULL OR r.product_code IS DISTINCT FROM r.item_code OR r.qty IS DISTINCT FROM coalesce(r.item_qty,1) THEN
      RAISE EXCEPTION 'ข้อมูลสินค้า/จำนวน/การคืนสต๊อกเปลี่ยนไป ไม่สามารถใช้ผลหยิบเดิมอัตโนมัติได้';
    END IF;
    IF EXISTS(SELECT 1 FROM public.wms_orders w WHERE w.source_order_item_id=r.source_order_item_id
      AND w.id<>r.id AND w.status NOT IN ('cancelled','returned')) THEN
      RAISE EXCEPTION 'พบ WMS ซ้ำของรายการสินค้า กรุณาตรวจสอบก่อนย้าย';
    END IF;
    SELECT coalesce(r.relinked_usage_at,(SELECT min(s.checked_at) FROM public.wms_order_summaries s WHERE btrim(s.order_id)=btrim(r.order_id)),r.old_completed,
      CASE WHEN r.fulfillment_mode IN ('system_complete','sub_warehouse_skip') THEN r.end_time END) INTO v_time;
    INSERT INTO public.wms_work_order_relinks(wms_order_id,previous_work_order_id,previous_work_order_name,work_order_id,work_order_name,previous_usage_at,actor_id)
    VALUES(r.id,r.work_order_id,r.order_id,p_work_order_id,v_name,v_time,auth.uid());
    -- Do not write status/qty/assigned_to/end_time/stock_action: never re-run stock deductions.
    UPDATE public.wms_orders SET work_order_id=p_work_order_id,order_id=v_name,relinked_usage_at=v_time WHERE id=r.id;
    v_count:=v_count+1;
  END LOOP;
  PERFORM public.fn_stamp_wms_review_completed_at(p_work_order_id);
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.fn_relink_wms_to_work_order(uuid) FROM PUBLIC,anon,authenticated;

-- Released work must not continue under the cancelled header while it waits
-- for recreation. Explicit stock cancellation/return actions remain available.
CREATE OR REPLACE FUNCTION public.guard_wms_cancelled_work_order_progress() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('cancelled','returned')
    AND EXISTS(SELECT 1 FROM public.or_work_orders WHERE id=NEW.work_order_id AND status='ยกเลิก') THEN
    RAISE EXCEPTION 'ใบงานถูกยกเลิกกลับคิวแล้ว กรุณาสร้างใบงานใหม่ก่อนดำเนินการหยิบต่อ';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_wms_cancelled_work_order_progress() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_wms_cancelled_work_order_progress BEFORE UPDATE OF status ON public.wms_orders
FOR EACH ROW EXECUTE FUNCTION public.guard_wms_cancelled_work_order_progress();

CREATE OR REPLACE FUNCTION public.rpc_cancel_work_order_preserve_wms(p_work_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_wo public.or_work_orders; v_role text; v_ids uuid[]; v_wms integer;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id=auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','order_staff','packing_staff','manager','production') THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ยกเลิกใบงาน'; END IF;
  SELECT * INTO v_wo FROM public.or_work_orders WHERE id=p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบใบงาน'; END IF;
  IF v_wo.status='ยกเลิก' THEN RETURN jsonb_build_object('success',true,'already_cancelled',true); END IF;
  IF v_wo.status<>'กำลังผลิต' THEN RAISE EXCEPTION 'สถานะใบงานไม่รองรับการยกเลิกกลับคิว'; END IF;
  PERFORM 1 FROM public.or_orders WHERE work_order_id=p_work_order_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.wms_orders WHERE work_order_id=p_work_order_id ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.or_orders WHERE work_order_id=p_work_order_id AND status IN ('จัดส่งแล้ว','ยกเลิก')) THEN RAISE EXCEPTION 'มีบิลจัดส่งแล้วหรือยกเลิก กรุณาตรวจสอบก่อนยกเลิกใบงาน'; END IF;
  IF EXISTS(SELECT 1 FROM public.wms_orders WHERE work_order_id=p_work_order_id AND status NOT IN ('cancelled','returned') AND (source_order_item_id IS NULL OR stock_action IS NOT NULL)) THEN
    RAISE EXCEPTION 'มี WMS อะไหล่/รายการไม่ผูกบิลหรืออยู่ระหว่างจัดการสต๊อก กรุณาจัดการก่อนยกเลิกใบงาน';
  END IF;
  SELECT array_agg(id) INTO v_ids FROM public.or_orders WHERE work_order_id=p_work_order_id;
  SELECT count(*) INTO v_wms FROM public.wms_orders WHERE work_order_id=p_work_order_id AND status NOT IN ('cancelled','returned');
  UPDATE public.or_orders SET work_order_id=NULL,work_order_name=NULL,plan_released_from_work_order=NULL,
    plan_released_from_work_order_id=NULL,plan_released_at=NULL,status='ใบสั่งงาน' WHERE id=ANY(coalesce(v_ids,'{}'::uuid[]));
  UPDATE public.or_work_orders SET status='ยกเลิก',order_count=0 WHERE id=p_work_order_id;
  INSERT INTO public.or_work_order_lifecycle_events(work_order_id,action,details,actor_id)
  VALUES(p_work_order_id,'release_preserving_fulfillment',jsonb_build_object('order_ids',v_ids,'preserved_wms',v_wms,'previous_status',v_wo.status),auth.uid());
  RETURN jsonb_build_object('success',true,'preserved_wms',v_wms);
END $$;
REVOKE ALL ON FUNCTION public.rpc_cancel_work_order_preserve_wms(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_work_order_preserve_wms(uuid) TO authenticated;

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
  IF NEW.work_order_id IS NOT NULL THEN
    PERFORM public.fn_relink_wms_to_work_order(NEW.work_order_id);
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

  PERFORM public.fn_relink_wms_to_work_order(v_work_order_id);
  PERFORM public.fn_wms_try_auto_consume_non_pick(p_work_order_name);
  PERFORM public.fn_sync_plan_pick_end_from_wms(v_work_order_id);
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


CREATE OR REPLACE FUNCTION public.rpc_assign_wms_for_work_order_v2(
  p_work_order_id UUID,p_picker_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_role TEXT; v_existing INT; v_has_items BOOLEAN; v_pick_norm INT;
  v_pick_spare INT; v_system INT; v_sub_skip INT; v_picker_ok BOOLEAN; v_work_order_name TEXT; v_new_ids uuid[];
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id=auth.uid();
  IF (v_role IS NULL OR v_role NOT IN ('superadmin','admin','store','manager','production'))
     AND NOT public.is_current_wms_store_backup() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์มอบหมาย WMS';
  END IF;
  IF p_work_order_id IS NULL THEN RETURN jsonb_build_object('success',false,'error','ต้องระบุใบงาน'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('WMS_ASSIGN:'||p_work_order_id::TEXT,0));
  SELECT work_order_name INTO v_work_order_name FROM public.or_work_orders WHERE id=p_work_order_id;
  IF NULLIF(BTRIM(COALESCE(v_work_order_name,'')),'') IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','ไม่พบใบงาน');
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.us_users WHERE id=p_picker_id AND role='picker') INTO v_picker_ok;
  IF NOT COALESCE(v_picker_ok,false) THEN
    RETURN jsonb_build_object('success',false,'error','ต้องระบุผู้ใช้ role picker ที่ถูกต้อง');
  END IF;

  PERFORM public.fn_relink_wms_to_work_order(p_work_order_id);
  IF EXISTS(SELECT 1 FROM public.wms_orders WHERE work_order_id=p_work_order_id
    AND status NOT IN ('correct','cancelled','returned') AND (fulfillment_mode='warehouse_pick' OR fulfillment_mode IS NULL)
    AND assigned_to IS NOT NULL AND assigned_to<>p_picker_id) THEN
    RETURN jsonb_build_object('success',false,'error','มีรายการมอบหมาย Picker คนอื่นอยู่แล้ว กรุณาตรวจสอบก่อน');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.or_orders o JOIN public.or_order_items oi ON oi.order_id=o.id
    WHERE o.work_order_id=p_work_order_id AND NOT COALESCE(oi.is_detail_row,false)
  ) INTO v_has_items;
  IF NOT v_has_items THEN RETURN jsonb_build_object('success',false,'error','ไม่พบรายการสินค้าหลักในใบงานนี้'); END IF;

  UPDATE public.wms_orders SET assigned_to=p_picker_id WHERE work_order_id=p_work_order_id
    AND assigned_to IS NULL AND status NOT IN ('correct','cancelled','returned')
    AND (fulfillment_mode='warehouse_pick' OR fulfillment_mode IS NULL);
  GET DIAGNOSTICS v_existing = ROW_COUNT;

  WITH base AS (
    SELECT o.id source_order_id,oi.id source_order_item_id,oi.product_name,
      COALESCE(oi.quantity,1)::NUMERIC sum_q,p.product_category::TEXT cat,
      p.product_code::TEXT product_code,p.storage_location::TEXT loc,
      COALESCE(NULLIF(BTRIM(p.unit_name::TEXT),''),'ชิ้น') unit_name
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id=o.id
    JOIN public.pr_products p ON p.id=oi.product_id
    WHERE o.work_order_id=p_work_order_id AND NOT COALESCE(oi.is_detail_row,false)
      AND public.fn_wms_item_fulfillment_mode(p.id,p.product_category::TEXT)='warehouse_pick'
      AND NOT EXISTS (SELECT 1 FROM public.wms_orders w WHERE w.source_order_item_id=oi.id AND w.status NOT IN ('cancelled','returned'))
  ), ins AS (
    INSERT INTO public.wms_orders(work_order_id,order_id,source_order_id,source_order_item_id,
      product_code,product_name,location,qty,unit_name,status,assigned_to,fulfillment_mode)
    SELECT p_work_order_id,v_work_order_name,source_order_id,source_order_item_id,
      COALESCE(NULLIF(BTRIM(product_code),''),product_name,'N/A'),product_name,COALESCE(loc,''),sum_q,
      unit_name,'pending',p_picker_id,'warehouse_pick'
    FROM base RETURNING id,source_order_item_id
  ) SELECT COUNT(*),array_agg(source_order_item_id) INTO v_pick_norm,v_new_ids FROM ins;

  WITH spare AS (
    SELECT p.rubber_code rc,SUM(COALESCE(oi.quantity,1)::NUMERIC) sum_q
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id=o.id
    JOIN public.pr_products p ON p.id=oi.product_id
    WHERE o.work_order_id=p_work_order_id AND NOT COALESCE(oi.is_detail_row,false)
      AND oi.id=ANY(coalesce(v_new_ids,'{}'::uuid[]))
      AND NULLIF(BTRIM(COALESCE(p.rubber_code::TEXT,'')),'') IS NOT NULL
      AND public.fn_wms_item_fulfillment_mode(p.id,p.product_category::TEXT)='warehouse_pick'
    GROUP BY p.rubber_code
  ), ins2 AS (
    INSERT INTO public.wms_orders(work_order_id,order_id,source_order_id,source_order_item_id,
      product_code,product_name,location,qty,unit_name,status,assigned_to,fulfillment_mode)
    SELECT p_work_order_id,v_work_order_name,NULL,NULL,'SPARE_PART',rc::TEXT,'อะไหล่',sum_q,'ชิ้น',
      'pending',p_picker_id,'warehouse_pick' FROM spare RETURNING id
  ) SELECT COUNT(*) INTO v_pick_spare FROM ins2;

  IF coalesce(v_pick_norm,0)+coalesce(v_pick_spare,0)+coalesce(v_existing,0)=0 THEN
    RETURN jsonb_build_object('success',false,'error','ไม่มีรายการใหม่ที่ต้องหยิบ รายการเดิมอาจหยิบครบแล้ว กรุณารีเฟรช');
  END IF;
  PERFORM public.fn_wms_try_auto_consume_non_pick(v_work_order_name);
  SELECT COUNT(*) INTO v_system FROM public.wms_orders
    WHERE work_order_id=p_work_order_id AND fulfillment_mode='system_complete' AND status='correct';
  SELECT COUNT(*) INTO v_sub_skip FROM public.wms_orders
    WHERE work_order_id=p_work_order_id AND fulfillment_mode='sub_warehouse_skip' AND status='correct';
  RETURN jsonb_build_object('success',true,'work_order_id',p_work_order_id,'work_order_name',v_work_order_name,
    'warehouse_pick_main',COALESCE(v_pick_norm,0)+COALESCE(v_existing,0),'warehouse_pick_spare',COALESCE(v_pick_spare,0),
    'system_complete',COALESCE(v_system,0),'sub_warehouse_skip',COALESCE(v_sub_skip,0));
END;
$$;


CREATE OR REPLACE FUNCTION public.fn_wms_try_auto_consume_non_pick(p_work_order_name TEXT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_nm TEXT := BTRIM(COALESCE(p_work_order_name,''));
  v_work_order_id UUID;
  v_expected INT;
  v_linked INT;
BEGIN
  IF v_nm='' THEN RETURN; END IF;

  SELECT wo.id,COALESCE(wo.order_count,0) INTO v_work_order_id,v_expected
  FROM public.or_work_orders wo
  WHERE BTRIM(COALESCE(wo.work_order_name,''))=v_nm AND wo.status='กำลังผลิต'
  ORDER BY wo.created_at DESC,wo.id DESC LIMIT 1;
  IF COALESCE(v_expected,0)<=0 THEN RETURN; END IF;

  SELECT COUNT(*) INTO v_linked
  FROM public.or_orders o
  WHERE o.work_order_id=v_work_order_id;
  IF v_linked<v_expected THEN RETURN; END IF;

  INSERT INTO public.wms_orders(
    work_order_id,order_id,source_order_id,source_order_item_id,
    product_code,product_name,location,qty,unit_name,status,assigned_to,fulfillment_mode
  )
  SELECT o.work_order_id,v_nm,o.id,oi.id,
    COALESCE(NULLIF(BTRIM(p.product_code::TEXT),''),oi.product_name,'N/A'),
    oi.product_name,COALESCE(p.storage_location::TEXT,''),COALESCE(oi.quantity,1)::NUMERIC,
    COALESCE(NULLIF(BTRIM(p.unit_name::TEXT),''),'ชิ้น'),'pending',NULL,
    public.fn_wms_item_fulfillment_mode(p.id,p.product_category::TEXT)
  FROM public.or_orders o
  JOIN public.or_order_items oi ON oi.order_id=o.id
  JOIN public.pr_products p ON p.id=oi.product_id
  WHERE o.work_order_id=v_work_order_id
    AND NOT COALESCE(oi.is_detail_row,false)
    AND public.fn_wms_item_fulfillment_mode(p.id,p.product_category::TEXT)<>'warehouse_pick'
    AND NOT EXISTS (
      SELECT 1 FROM public.wms_orders w
      WHERE w.source_order_item_id=oi.id AND w.status NOT IN ('cancelled','returned')
    );

  UPDATE public.wms_orders
  SET status='correct',end_time=COALESCE(end_time,NOW())
  WHERE work_order_id=v_work_order_id
    AND fulfillment_mode IN ('system_complete','sub_warehouse_skip')
    AND status='pending';
END;
$$;


CREATE OR REPLACE FUNCTION public.rpc_wms_work_orders_needing_picker() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
SELECT coalesce(jsonb_agg(work_order_name ORDER BY work_order_name),'[]'::jsonb) FROM public.or_work_orders wo
WHERE wo.status='กำลังผลิต' AND EXISTS(
 SELECT 1 FROM public.or_orders o JOIN public.or_order_items oi ON oi.order_id=o.id JOIN public.pr_products p ON p.id=oi.product_id
 WHERE o.work_order_id=wo.id AND o.status NOT IN ('ยกเลิก','จัดส่งแล้ว') AND NOT coalesce(oi.is_detail_row,false)
 AND public.fn_wms_item_fulfillment_mode(p.id,p.product_category)='warehouse_pick'
 AND NOT EXISTS(SELECT 1 FROM public.wms_orders w WHERE w.source_order_item_id=oi.id AND w.work_order_id=wo.id
 AND w.status NOT IN ('cancelled','returned') AND (w.assigned_to IS NOT NULL OR w.status='correct')))
$$;
REVOKE ALL ON FUNCTION public.rpc_wms_work_orders_needing_picker() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_wms_work_orders_needing_picker() TO authenticated;

CREATE OR REPLACE FUNCTION public.rpc_get_sub_warehouse_daily_stock_sheet(p_sub_warehouse_id uuid, p_date date) RETURNS TABLE(product_id uuid, product_code text, product_name text, unit_name text, received_opening numeric, replenish_day numeric, reduce_day numeric, wms_opening numeric, wms_day numeric, balance_opening numeric, balance_eod numeric)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH bounds AS (
    SELECT
      make_timestamptz(EXTRACT(YEAR FROM p_date)::INT,EXTRACT(MONTH FROM p_date)::INT,
        EXTRACT(DAY FROM p_date)::INT,0,0,0,'Asia/Bangkok') AS day_start,
      make_timestamptz(EXTRACT(YEAR FROM p_date)::INT,EXTRACT(MONTH FROM p_date)::INT,
        EXTRACT(DAY FROM p_date)::INT,0,0,0,'Asia/Bangkok')+INTERVAL '1 day' AS day_end_excl
  ), groups_scope AS (
    SELECT map_group.id FROM public.wh_sub_wms_map_groups map_group
    WHERE map_group.sub_warehouse_id IS NULL OR map_group.sub_warehouse_id=p_sub_warehouse_id
  ), wms_usage AS (
    SELECT wms.product_code,wms.qty,
      COALESCE(
        wms.relinked_usage_at,
        summary.checked_at,
        completion.completed_at,
        CASE WHEN wms.fulfillment_mode IN ('system_complete','sub_warehouse_skip') THEN wms.end_time END
      ) AS used_at,
      CASE
        WHEN requisition.id IS NOT NULL OR UPPER(BTRIM(COALESCE(wms.order_id,''))) LIKE 'REQ-%' THEN 'requisition'
        WHEN wms.work_order_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM public.or_orders sales_order
          WHERE BTRIM(COALESCE(sales_order.work_order_name,''))=BTRIM(COALESCE(wms.order_id,''))
        ) THEN 'work_order'
        ELSE 'other'
      END AS usage_source
    FROM public.wms_orders wms
    LEFT JOIN public.wms_requisitions requisition ON requisition.requisition_id=wms.order_id
    LEFT JOIN LATERAL (
      SELECT wms_summary.checked_at FROM public.wms_order_summaries wms_summary
      WHERE BTRIM(wms_summary.order_id)=BTRIM(wms.order_id)
      ORDER BY wms_summary.checked_at LIMIT 1
    ) summary ON TRUE
    LEFT JOIN LATERAL (
      SELECT work_order.wms_review_completed_at AS completed_at
      FROM public.or_work_orders work_order
      WHERE work_order.id=wms.work_order_id
         OR (wms.work_order_id IS NULL AND BTRIM(work_order.work_order_name)=BTRIM(wms.order_id))
      ORDER BY (work_order.id=wms.work_order_id) DESC,work_order.created_at DESC
      LIMIT 1
    ) completion ON TRUE
    WHERE wms.status='correct'
  ), group_wms_open AS (
    SELECT source.group_id,COALESCE(SUM(usage.qty),0)::NUMERIC qty
    FROM public.wh_sub_wms_map_sources source
    JOIN groups_scope ON groups_scope.id=source.group_id
    JOIN public.pr_products product_source ON product_source.id=source.product_id
    JOIN wms_usage usage ON usage.product_code::TEXT=product_source.product_code::TEXT
    CROSS JOIN bounds
    WHERE usage.usage_source='work_order' AND usage.used_at<bounds.day_start
    GROUP BY source.group_id
  ), group_wms_day AS (
    SELECT source.group_id,COALESCE(SUM(usage.qty),0)::NUMERIC qty
    FROM public.wh_sub_wms_map_sources source
    JOIN groups_scope ON groups_scope.id=source.group_id
    JOIN public.pr_products product_source ON product_source.id=source.product_id
    JOIN wms_usage usage ON usage.product_code::TEXT=product_source.product_code::TEXT
    CROSS JOIN bounds
    WHERE usage.usage_source='work_order'
      AND usage.used_at>=bounds.day_start AND usage.used_at<bounds.day_end_excl
    GROUP BY source.group_id
  ), spare_group AS (
    SELECT spare.product_id,spare.group_id FROM public.wh_sub_wms_map_spares spare
    JOIN groups_scope ON groups_scope.id=spare.group_id
  ), products AS (
    SELECT assigned.product_id,product.product_code,product.product_name,product.unit_name
    FROM public.wh_sub_warehouse_products assigned
    JOIN public.pr_products product ON product.id=assigned.product_id
    WHERE assigned.sub_warehouse_id=p_sub_warehouse_id
  ), recv_open AS (
    SELECT movement.product_id,COALESCE(SUM(movement.qty_delta),0)::NUMERIC qty
    FROM public.wh_sub_warehouse_stock_moves movement CROSS JOIN bounds
    WHERE movement.sub_warehouse_id=p_sub_warehouse_id AND movement.created_at<bounds.day_start
    GROUP BY movement.product_id
  ), recv_day AS (
    SELECT movement.product_id,
      COALESCE(SUM(CASE WHEN movement.qty_delta>0 THEN movement.qty_delta ELSE 0 END),0)::NUMERIC replenish,
      COALESCE(SUM(CASE WHEN movement.qty_delta<0 THEN movement.qty_delta ELSE 0 END),0)::NUMERIC reduce_sum
    FROM public.wh_sub_warehouse_stock_moves movement CROSS JOIN bounds
    WHERE movement.sub_warehouse_id=p_sub_warehouse_id
      AND movement.created_at>=bounds.day_start AND movement.created_at<bounds.day_end_excl
    GROUP BY movement.product_id
  ), wms_open AS (
    SELECT usage.product_code::TEXT,COALESCE(SUM(usage.qty),0)::NUMERIC qty
    FROM wms_usage usage CROSS JOIN bounds
    WHERE usage.usage_source='work_order' AND usage.used_at<bounds.day_start
    GROUP BY usage.product_code
  ), wms_day_tbl AS (
    SELECT usage.product_code::TEXT,COALESCE(SUM(usage.qty),0)::NUMERIC qty
    FROM wms_usage usage CROSS JOIN bounds
    WHERE usage.usage_source='work_order'
      AND usage.used_at>=bounds.day_start AND usage.used_at<bounds.day_end_excl
    GROUP BY usage.product_code
  )
  SELECT product_row.product_id,product_row.product_code,product_row.product_name,product_row.unit_name,
    COALESCE(recv_open.qty,0)::NUMERIC,COALESCE(recv_day.replenish,0)::NUMERIC,
    COALESCE(recv_day.reduce_sum,0)::NUMERIC,
    (CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_open.qty,0) ELSE COALESCE(wms_open.qty,0) END)::NUMERIC,
    (CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_day.qty,0) ELSE COALESCE(wms_day.qty,0) END)::NUMERIC,
    (COALESCE(recv_open.qty,0)-CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_open.qty,0) ELSE COALESCE(wms_open.qty,0) END)::NUMERIC,
    ((COALESCE(recv_open.qty,0)+COALESCE(recv_day.replenish,0)+COALESCE(recv_day.reduce_sum,0))
      -(CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_open.qty,0) ELSE COALESCE(wms_open.qty,0) END)
      -(CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_day.qty,0) ELSE COALESCE(wms_day.qty,0) END))::NUMERIC
  FROM products product_row
  LEFT JOIN spare_group ON spare_group.product_id=product_row.product_id
  LEFT JOIN group_wms_open group_open ON group_open.group_id=spare_group.group_id
  LEFT JOIN group_wms_day group_day ON group_day.group_id=spare_group.group_id
  LEFT JOIN recv_open ON recv_open.product_id=product_row.product_id
  LEFT JOIN recv_day ON recv_day.product_id=product_row.product_id
  LEFT JOIN wms_open ON wms_open.product_code=product_row.product_code
  LEFT JOIN wms_day_tbl wms_day ON wms_day.product_code=product_row.product_code
  ORDER BY product_row.product_code;
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_wms_usage_breakdown_by_product(p_from timestamp with time zone, p_to timestamp with time zone) RETURNS TABLE(product_code text, correct_qty numeric, work_order_qty numeric, requisition_qty numeric, other_qty numeric)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH usage AS (
    SELECT
      w.product_code,
      COALESCE(w.qty, 0)::NUMERIC AS qty,
      COALESCE(
        w.relinked_usage_at,
        summary.checked_at,
        completion.completed_at,
        CASE
          WHEN w.fulfillment_mode IN ('system_complete', 'sub_warehouse_skip') THEN w.end_time
        END
      ) AS used_at,
      CASE
        WHEN requisition.id IS NOT NULL OR UPPER(BTRIM(COALESCE(w.order_id, ''))) LIKE 'REQ-%'
          THEN 'requisition'
        WHEN w.work_order_id IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM public.or_orders sales_order
            WHERE BTRIM(COALESCE(sales_order.work_order_name, '')) = BTRIM(COALESCE(w.order_id, ''))
          ) THEN 'work_order'
        ELSE 'other'
      END AS usage_source
    FROM public.wms_orders w
    LEFT JOIN public.wms_requisitions requisition ON requisition.requisition_id = w.order_id
    LEFT JOIN LATERAL (
      SELECT ws.checked_at
      FROM public.wms_order_summaries ws
      WHERE BTRIM(ws.order_id) = BTRIM(w.order_id)
      ORDER BY ws.checked_at
      LIMIT 1
    ) summary ON TRUE
    LEFT JOIN LATERAL (
      SELECT wo.wms_review_completed_at AS completed_at
      FROM public.or_work_orders wo
      WHERE wo.id = w.work_order_id
         OR (w.work_order_id IS NULL AND BTRIM(wo.work_order_name) = BTRIM(w.order_id))
      ORDER BY (wo.id = w.work_order_id) DESC, wo.created_at DESC
      LIMIT 1
    ) completion ON TRUE
    WHERE w.status = 'correct'
  )
  SELECT
    usage.product_code,
    COALESCE(SUM(usage.qty), 0)::NUMERIC,
    COALESCE(SUM(usage.qty) FILTER (WHERE usage.usage_source = 'work_order'), 0)::NUMERIC,
    COALESCE(SUM(usage.qty) FILTER (WHERE usage.usage_source = 'requisition'), 0)::NUMERIC,
    COALESCE(SUM(usage.qty) FILTER (WHERE usage.usage_source = 'other'), 0)::NUMERIC
  FROM usage
  WHERE usage.used_at >= p_from AND usage.used_at <= p_to
  GROUP BY usage.product_code
  ORDER BY usage.product_code;
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_sub_warehouse_other_wms_details(p_sub_warehouse_id uuid, p_product_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) RETURNS TABLE(wms_order_id uuid, order_reference text, product_code text, product_name text, qty numeric, unit_name text, used_at timestamp with time zone, fulfillment_mode text, picker_name text, classification_reason text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH groups_scope AS (
    SELECT g.id
    FROM public.wh_sub_wms_map_groups g
    WHERE g.sub_warehouse_id IS NULL
       OR g.sub_warehouse_id = p_sub_warehouse_id
  ), matched_groups AS (
    SELECT DISTINCT sp.group_id
    FROM public.wh_sub_wms_map_spares sp
    JOIN groups_scope gs ON gs.id = sp.group_id
    WHERE sp.product_id = p_product_id
  ), target_codes AS (
    SELECT p.product_code::TEXT AS product_code
    FROM public.wh_sub_wms_map_sources src
    JOIN matched_groups mg ON mg.group_id = src.group_id
    JOIN public.pr_products p ON p.id = src.product_id
    UNION ALL
    SELECT p.product_code::TEXT
    FROM public.pr_products p
    WHERE p.id = p_product_id
      AND NOT EXISTS (SELECT 1 FROM matched_groups)
  ), usage AS (
    SELECT
      w.id,
      w.order_id,
      w.product_code,
      w.product_name,
      COALESCE(w.qty, 0)::NUMERIC AS qty,
      w.unit_name,
      COALESCE(
        w.relinked_usage_at,
        s.checked_at,
        CASE
          WHEN w.fulfillment_mode IN ('system_complete', 'sub_warehouse_skip') THEN w.end_time
        END
      ) AS used_at,
      w.fulfillment_mode,
      picker.username::TEXT AS picker_name,
      r.id AS requisition_id,
      w.work_order_id,
      EXISTS (
        SELECT 1
        FROM public.or_orders o
        WHERE BTRIM(COALESCE(o.work_order_name, '')) = BTRIM(COALESCE(w.order_id, ''))
      ) AS has_work_order
    FROM public.wms_orders w
    JOIN target_codes tc ON tc.product_code = w.product_code::TEXT
    LEFT JOIN public.wms_requisitions r ON r.requisition_id = w.order_id
    LEFT JOIN public.us_users picker ON picker.id = w.assigned_to
    LEFT JOIN LATERAL (
      SELECT ws.checked_at
      FROM public.wms_order_summaries ws
      WHERE ws.order_id = w.order_id
      ORDER BY ws.checked_at
      LIMIT 1
    ) s ON TRUE
    WHERE auth.uid() IS NOT NULL
      AND w.status = 'correct'
  )
  SELECT
    u.id,
    u.order_id,
    u.product_code,
    u.product_name,
    u.qty,
    u.unit_name,
    u.used_at,
    u.fulfillment_mode,
    u.picker_name,
    CASE
      WHEN NULLIF(BTRIM(COALESCE(u.order_id, '')), '') IS NULL
        THEN 'ไม่มีเลขอ้างอิง WMS'
      ELSE 'ไม่พบใบงานหรือใบเบิกที่ตรงกับเลขอ้างอิง'
    END
  FROM usage u
  WHERE u.used_at >= p_from
    AND u.used_at <= p_to
    AND u.requisition_id IS NULL
    AND UPPER(BTRIM(COALESCE(u.order_id, ''))) NOT LIKE 'REQ-%'
    AND u.work_order_id IS NULL
    AND NOT u.has_work_order
  ORDER BY u.used_at DESC, u.order_id, u.product_code;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
