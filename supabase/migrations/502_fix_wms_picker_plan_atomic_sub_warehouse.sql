-- 502: Keep automatic/secondary-warehouse fulfillment separate from main-WMS picking,
-- and create work orders + plan rows atomically.

BEGIN;

ALTER TABLE public.wms_orders
  DROP CONSTRAINT IF EXISTS wms_orders_fulfillment_mode_check;
ALTER TABLE public.wms_orders
  ADD CONSTRAINT wms_orders_fulfillment_mode_check CHECK (
    fulfillment_mode IS NULL
    OR fulfillment_mode IN ('warehouse_pick', 'system_complete', 'sub_warehouse_skip')
  );

COMMENT ON COLUMN public.wms_orders.fulfillment_mode IS
  'warehouse_pick=Picker คลังหลัก, system_complete=ตัดคลังหลักอัตโนมัติ, sub_warehouse_skip=ข้าม Picker และตัดสต๊อคหลักอัตโนมัติ';

CREATE OR REPLACE FUNCTION public.fn_wms_is_sub_warehouse_product(p_product_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT p_product_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.wh_sub_warehouse_products swp
    JOIN public.wh_sub_warehouses sw ON sw.id=swp.sub_warehouse_id
    WHERE swp.product_id=p_product_id AND sw.is_active
  );
$$;

CREATE OR REPLACE FUNCTION public.fn_wms_item_fulfillment_mode(p_product_id UUID, p_category TEXT)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT CASE
    WHEN public.fn_wms_is_sub_warehouse_product(p_product_id) THEN 'sub_warehouse_skip'
    WHEN public.fn_wms_is_pickable_category(p_category) THEN 'warehouse_pick'
    ELSE 'system_complete'
  END;
$$;

REVOKE ALL ON FUNCTION public.fn_wms_is_sub_warehouse_product(UUID) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_wms_item_fulfillment_mode(UUID,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wms_is_sub_warehouse_product(UUID) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_wms_item_fulfillment_mode(UUID,TEXT) TO authenticated,service_role;

COMMENT ON FUNCTION public.fn_wms_item_fulfillment_mode(UUID,TEXT) IS
  'warehouse_pick=Picker คลังหลัก, system_complete=ตัดคลังหลักอัตโนมัติ, sub_warehouse_skip=สินค้าคลังย่อยที่ข้าม Picker แต่ยังตัดสต๊อคหลักอัตโนมัติ';

-- Mixed work orders may already contain auto-completed rows before a Picker is assigned.
-- Create only missing automatic rows and keep the operation idempotent.
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
      WHERE w.source_order_item_id=oi.id AND w.status<>'cancelled'
    );

  UPDATE public.wms_orders
  SET status='correct',end_time=COALESCE(end_time,NOW())
  WHERE work_order_id=v_work_order_id
    AND fulfillment_mode IN ('system_complete','sub_warehouse_skip')
    AND status='pending';
END;
$$;

-- Every completed sale item still deducts the main inventory. Sub-warehouse
-- membership controls Picker visibility/report grouping only.
CREATE OR REPLACE FUNCTION public.inv_deduct_stock_on_wms_picked()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_product_id UUID;
  v_movement_id UUID;
  v_stock_qty NUMERIC;
BEGIN
  IF NEW.status='cancelled' THEN RETURN NEW; END IF;

  SELECT id INTO v_product_id FROM public.pr_products
  WHERE product_code=NEW.product_code LIMIT 1;
  IF v_product_id IS NULL THEN RETURN NEW; END IF;
  v_stock_qty:=COALESCE(NEW.qty,0);

  IF NEW.status='picked' AND (OLD.status IS NULL OR OLD.status NOT IN ('picked','correct')) THEN
    INSERT INTO public.inv_stock_balances(product_id,on_hand,reserved,safety_stock)
    VALUES(v_product_id,0,v_stock_qty,0)
    ON CONFLICT(product_id) DO UPDATE SET
      reserved=COALESCE(public.inv_stock_balances.reserved,0)+v_stock_qty,
      updated_at=NOW();
  END IF;

  IF NEW.status='correct' AND (OLD.status IS NULL OR OLD.status<>'correct') THEN
    INSERT INTO public.inv_stock_balances(product_id,on_hand,reserved,safety_stock)
    VALUES(v_product_id,-v_stock_qty,0,0)
    ON CONFLICT(product_id) DO UPDATE SET
      on_hand=COALESCE(public.inv_stock_balances.on_hand,0)-v_stock_qty,
      reserved=GREATEST(COALESCE(public.inv_stock_balances.reserved,0)-v_stock_qty,0),
      updated_at=NOW();
    INSERT INTO public.inv_stock_movements(product_id,movement_type,qty,ref_type,ref_id,note)
    VALUES(v_product_id,'pick',-v_stock_qty,'wms_orders',NEW.id,
      'ตัดสต๊อกตามหน่วยสินค้า '||COALESCE(NULLIF(BTRIM(NEW.unit_name),'') ,'ชิ้น'))
    RETURNING id INTO v_movement_id;
    PERFORM public.fn_consume_stock_fifo(v_product_id,v_stock_qty,v_movement_id);
    PERFORM public.fn_recalc_product_landed_cost(v_product_id);
  END IF;

  IF NEW.status='out_of_stock' AND OLD.status='picked' THEN
    UPDATE public.inv_stock_balances
    SET reserved=GREATEST(COALESCE(reserved,0)-v_stock_qty,0),updated_at=NOW()
    WHERE product_id=v_product_id;
  END IF;

  IF NEW.status='returned' AND OLD.status IS DISTINCT FROM 'returned' THEN
    IF OLD.status='picked' THEN
      UPDATE public.inv_stock_balances
      SET reserved=GREATEST(COALESCE(reserved,0)-v_stock_qty,0),updated_at=NOW()
      WHERE product_id=v_product_id;
    ELSIF OLD.status='correct' THEN
      PERFORM public.fn_reverse_wms_stock(NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Existing completed system rows already deducted main stock correctly. Keep
-- that movement; also remove not-yet-started sub-warehouse lines from Picker.
UPDATE public.wms_orders w
SET fulfillment_mode='sub_warehouse_skip',assigned_to=NULL
FROM public.or_order_items oi,public.pr_products p
WHERE oi.id=w.source_order_item_id AND p.id=oi.product_id
  AND public.fn_wms_is_sub_warehouse_product(p.id)
  AND (
    w.fulfillment_mode='system_complete'
    OR (w.fulfillment_mode='warehouse_pick' AND w.status='pending')
  );

-- A pending legacy automatic row has not fired the stock trigger yet. Completing
-- it after reclassification deducts main stock exactly once.
UPDATE public.wms_orders
SET status='correct',end_time=COALESCE(end_time,NOW())
WHERE fulfillment_mode='sub_warehouse_skip' AND status='pending';

-- Populate automatic audit rows for active work orders that predate this rule.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT wo.work_order_name
    FROM public.or_work_orders wo
    WHERE wo.status='กำลังผลิต'
      AND NULLIF(BTRIM(COALESCE(wo.work_order_name,'')),'') IS NOT NULL
  LOOP
    PERFORM public.fn_wms_try_auto_consume_non_pick(r.work_order_name);
  END LOOP;
END $$;

-- Picker assignment must ignore automatic rows that may legitimately exist first.
CREATE OR REPLACE FUNCTION public.rpc_assign_wms_for_work_order_v2(
  p_work_order_id UUID,p_picker_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_role TEXT; v_existing INT; v_has_items BOOLEAN; v_pick_norm INT;
  v_pick_spare INT; v_system INT; v_sub_skip INT; v_picker_ok BOOLEAN; v_work_order_name TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id=auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','store','manager','production') THEN
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

  SELECT COUNT(*) INTO v_existing FROM public.wms_orders
  WHERE work_order_id=p_work_order_id AND status<>'cancelled'
    AND (fulfillment_mode='warehouse_pick' OR fulfillment_mode IS NULL);
  IF v_existing>0 THEN
    RETURN jsonb_build_object('success',false,'error','ใบงานนี้ถูกมอบหมาย Picker ในระบบ WMS แล้ว');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.or_orders o JOIN public.or_order_items oi ON oi.order_id=o.id
    WHERE o.work_order_id=p_work_order_id AND NOT COALESCE(oi.is_detail_row,false)
  ) INTO v_has_items;
  IF NOT v_has_items THEN RETURN jsonb_build_object('success',false,'error','ไม่พบรายการสินค้าหลักในใบงานนี้'); END IF;

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
      AND NOT EXISTS (SELECT 1 FROM public.wms_orders w WHERE w.source_order_item_id=oi.id AND w.status<>'cancelled')
  ), ins AS (
    INSERT INTO public.wms_orders(work_order_id,order_id,source_order_id,source_order_item_id,
      product_code,product_name,location,qty,unit_name,status,assigned_to,fulfillment_mode)
    SELECT p_work_order_id,v_work_order_name,source_order_id,source_order_item_id,
      COALESCE(NULLIF(BTRIM(product_code),''),product_name,'N/A'),product_name,COALESCE(loc,''),sum_q,
      unit_name,'pending',p_picker_id,'warehouse_pick'
    FROM base RETURNING id
  ) SELECT COUNT(*) INTO v_pick_norm FROM ins;

  WITH spare AS (
    SELECT p.rubber_code rc,SUM(COALESCE(oi.quantity,1)::NUMERIC) sum_q
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id=o.id
    JOIN public.pr_products p ON p.id=oi.product_id
    WHERE o.work_order_id=p_work_order_id AND NOT COALESCE(oi.is_detail_row,false)
      AND NULLIF(BTRIM(COALESCE(p.rubber_code::TEXT,'')),'') IS NOT NULL
      AND public.fn_wms_item_fulfillment_mode(p.id,p.product_category::TEXT)='warehouse_pick'
    GROUP BY p.rubber_code
  ), ins2 AS (
    INSERT INTO public.wms_orders(work_order_id,order_id,source_order_id,source_order_item_id,
      product_code,product_name,location,qty,unit_name,status,assigned_to,fulfillment_mode)
    SELECT p_work_order_id,v_work_order_name,NULL,NULL,'SPARE_PART',rc::TEXT,'อะไหล่',sum_q,'ชิ้น',
      'pending',p_picker_id,'warehouse_pick' FROM spare RETURNING id
  ) SELECT COUNT(*) INTO v_pick_spare FROM ins2;

  PERFORM public.fn_wms_try_auto_consume_non_pick(v_work_order_name);
  SELECT COUNT(*) INTO v_system FROM public.wms_orders
    WHERE work_order_id=p_work_order_id AND fulfillment_mode='system_complete' AND status='correct';
  SELECT COUNT(*) INTO v_sub_skip FROM public.wms_orders
    WHERE work_order_id=p_work_order_id AND fulfillment_mode='sub_warehouse_skip' AND status='correct';
  RETURN jsonb_build_object('success',true,'work_order_id',p_work_order_id,'work_order_name',v_work_order_name,
    'warehouse_pick_main',COALESCE(v_pick_norm,0),'warehouse_pick_spare',COALESCE(v_pick_spare,0),
    'system_complete',COALESCE(v_system,0),'sub_warehouse_skip',COALESCE(v_sub_skip,0));
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_assign_wms_for_work_order_v2(UUID,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_assign_wms_for_work_order_v2(UUID,UUID) TO authenticated;

-- "ผลิตใช้ไป": normal Picker rows use the first-check timestamp. Automatic
-- rows in an all-auto work order have no summary, so use their completion time.
CREATE OR REPLACE FUNCTION public.rpc_get_wms_correct_qty_by_product(
  p_from TIMESTAMPTZ,p_to TIMESTAMPTZ
) RETURNS TABLE(product_code TEXT,correct_qty NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH usage AS (
    SELECT w.product_code,w.qty,
      COALESCE(s.checked_at,
        CASE WHEN w.fulfillment_mode IN ('system_complete','sub_warehouse_skip') THEN w.end_time END
      ) AS used_at
    FROM public.wms_orders w
    LEFT JOIN LATERAL (
      SELECT ws.checked_at FROM public.wms_order_summaries ws
      WHERE ws.order_id=w.order_id ORDER BY ws.checked_at LIMIT 1
    ) s ON TRUE
    WHERE w.status='correct'
  )
  SELECT u.product_code,COALESCE(SUM(u.qty),0)::NUMERIC
  FROM usage u
  WHERE u.used_at>=p_from AND u.used_at<=p_to
  GROUP BY u.product_code
  ORDER BY u.product_code;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_wms_correct_qty_by_product(TIMESTAMPTZ,TIMESTAMPTZ) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_wms_correct_qty_by_product(TIMESTAMPTZ,TIMESTAMPTZ) TO authenticated;

CREATE OR REPLACE FUNCTION public.rpc_get_sub_warehouse_daily_stock_sheet(
  p_sub_warehouse_id UUID,p_date DATE
) RETURNS TABLE(
  product_id UUID,product_code TEXT,product_name TEXT,unit_name TEXT,
  received_opening NUMERIC,replenish_day NUMERIC,reduce_day NUMERIC,
  wms_opening NUMERIC,wms_day NUMERIC,balance_opening NUMERIC,balance_eod NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH bounds AS (
    SELECT
      make_timestamptz(EXTRACT(YEAR FROM p_date)::INT,EXTRACT(MONTH FROM p_date)::INT,
        EXTRACT(DAY FROM p_date)::INT,0,0,0,'Asia/Bangkok') AS day_start,
      make_timestamptz(EXTRACT(YEAR FROM p_date)::INT,EXTRACT(MONTH FROM p_date)::INT,
        EXTRACT(DAY FROM p_date)::INT,0,0,0,'Asia/Bangkok')+INTERVAL '1 day' AS day_end_excl
  ), groups_scope AS (
    SELECT g.id FROM public.wh_sub_wms_map_groups g
    WHERE g.sub_warehouse_id IS NULL OR g.sub_warehouse_id=p_sub_warehouse_id
  ), wms_usage AS (
    SELECT w.product_code,w.qty,
      COALESCE(s.checked_at,
        CASE WHEN w.fulfillment_mode IN ('system_complete','sub_warehouse_skip') THEN w.end_time END
      ) AS used_at
    FROM public.wms_orders w
    LEFT JOIN LATERAL (
      SELECT ws.checked_at FROM public.wms_order_summaries ws
      WHERE ws.order_id=w.order_id ORDER BY ws.checked_at LIMIT 1
    ) s ON TRUE
    WHERE w.status='correct'
  ), group_wms_open AS (
    SELECT src.group_id,COALESCE(SUM(u.qty),0)::NUMERIC qty
    FROM public.wh_sub_wms_map_sources src
    JOIN groups_scope gs ON gs.id=src.group_id
    JOIN public.pr_products ps ON ps.id=src.product_id
    JOIN wms_usage u ON u.product_code::TEXT=ps.product_code::TEXT
    CROSS JOIN bounds b
    WHERE u.used_at<b.day_start GROUP BY src.group_id
  ), group_wms_day AS (
    SELECT src.group_id,COALESCE(SUM(u.qty),0)::NUMERIC qty
    FROM public.wh_sub_wms_map_sources src
    JOIN groups_scope gs ON gs.id=src.group_id
    JOIN public.pr_products ps ON ps.id=src.product_id
    JOIN wms_usage u ON u.product_code::TEXT=ps.product_code::TEXT
    CROSS JOIN bounds b
    WHERE u.used_at>=b.day_start AND u.used_at<b.day_end_excl GROUP BY src.group_id
  ), spare_group AS (
    SELECT sp.product_id,sp.group_id FROM public.wh_sub_wms_map_spares sp
    JOIN groups_scope gs ON gs.id=sp.group_id
  ), products AS (
    SELECT sp.product_id,p.product_code,p.product_name,p.unit_name
    FROM public.wh_sub_warehouse_products sp
    JOIN public.pr_products p ON p.id=sp.product_id
    WHERE sp.sub_warehouse_id=p_sub_warehouse_id
  ), recv_open AS (
    SELECT m.product_id,COALESCE(SUM(m.qty_delta),0)::NUMERIC qty
    FROM public.wh_sub_warehouse_stock_moves m CROSS JOIN bounds b
    WHERE m.sub_warehouse_id=p_sub_warehouse_id AND m.created_at<b.day_start
    GROUP BY m.product_id
  ), recv_day AS (
    SELECT m.product_id,
      COALESCE(SUM(CASE WHEN m.qty_delta>0 THEN m.qty_delta ELSE 0 END),0)::NUMERIC replenish,
      COALESCE(SUM(CASE WHEN m.qty_delta<0 THEN m.qty_delta ELSE 0 END),0)::NUMERIC reduce_sum
    FROM public.wh_sub_warehouse_stock_moves m CROSS JOIN bounds b
    WHERE m.sub_warehouse_id=p_sub_warehouse_id
      AND m.created_at>=b.day_start AND m.created_at<b.day_end_excl
    GROUP BY m.product_id
  ), wms_open AS (
    SELECT u.product_code::TEXT,COALESCE(SUM(u.qty),0)::NUMERIC qty
    FROM wms_usage u CROSS JOIN bounds b WHERE u.used_at<b.day_start GROUP BY u.product_code
  ), wms_day_tbl AS (
    SELECT u.product_code::TEXT,COALESCE(SUM(u.qty),0)::NUMERIC qty
    FROM wms_usage u CROSS JOIN bounds b
    WHERE u.used_at>=b.day_start AND u.used_at<b.day_end_excl GROUP BY u.product_code
  )
  SELECT pr.product_id,pr.product_code,pr.product_name,pr.unit_name,
    COALESCE(ro.qty,0)::NUMERIC,COALESCE(rd.replenish,0)::NUMERIC,
    COALESCE(rd.reduce_sum,0)::NUMERIC,
    (CASE WHEN sg.group_id IS NOT NULL THEN COALESCE(gwo.qty,0) ELSE COALESCE(wo.qty,0) END)::NUMERIC,
    (CASE WHEN sg.group_id IS NOT NULL THEN COALESCE(gwd.qty,0) ELSE COALESCE(wd.qty,0) END)::NUMERIC,
    (COALESCE(ro.qty,0)-CASE WHEN sg.group_id IS NOT NULL THEN COALESCE(gwo.qty,0) ELSE COALESCE(wo.qty,0) END)::NUMERIC,
    ((COALESCE(ro.qty,0)+COALESCE(rd.replenish,0)+COALESCE(rd.reduce_sum,0))
      -(CASE WHEN sg.group_id IS NOT NULL THEN COALESCE(gwo.qty,0) ELSE COALESCE(wo.qty,0) END)
      -(CASE WHEN sg.group_id IS NOT NULL THEN COALESCE(gwd.qty,0) ELSE COALESCE(wd.qty,0) END))::NUMERIC
  FROM products pr
  LEFT JOIN spare_group sg ON sg.product_id=pr.product_id
  LEFT JOIN group_wms_open gwo ON gwo.group_id=sg.group_id
  LEFT JOIN group_wms_day gwd ON gwd.group_id=sg.group_id
  LEFT JOIN recv_open ro ON ro.product_id=pr.product_id
  LEFT JOIN recv_day rd ON rd.product_id=pr.product_id
  LEFT JOIN wms_open wo ON wo.product_code=pr.product_code
  LEFT JOIN wms_day_tbl wd ON wd.product_code=pr.product_code
  ORDER BY pr.product_code;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_sub_warehouse_daily_stock_sheet(UUID,DATE) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_sub_warehouse_daily_stock_sheet(UUID,DATE) TO authenticated;

-- Keep the manual/bulk repair path consistent with assignment and anomaly rules.
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
    public.fn_wms_item_fulfillment_mode(p.id,p.product_category::TEXT) fulfillment_mode
  INTO v_item
  FROM public.or_order_items oi
  JOIN public.or_orders o ON o.id=oi.order_id
  JOIN public.pr_products p ON p.id=oi.product_id
  WHERE oi.id=p_order_item_id AND NOT COALESCE(oi.is_detail_row,false)
  FOR UPDATE OF oi;

  IF v_item.id IS NULL OR v_item.work_order_id IS NULL THEN
    RAISE EXCEPTION 'ไม่พบรายการหรือรายการยังไม่มีใบงาน';
  END IF;
  SELECT COALESCE(SUM(qty),0) INTO v_existing FROM public.wms_orders
  WHERE source_order_item_id=p_order_item_id AND status<>'cancelled';
  v_missing:=v_item.qty-v_existing;
  IF v_missing<=0 THEN
    RETURN jsonb_build_object('success',true,'created_qty',0,'message','รายการตรงกันแล้ว');
  END IF;
  IF public.fn_wms_item_has_legacy_stock_conflict(p_order_item_id) THEN
    RAISE EXCEPTION 'พบ WMS/Movement รุ่นเก่าหรือยอด Movement ไม่สัมพันธ์ ระบบบล็อกเพื่อป้องกันตัดซ้ำ';
  END IF;

  v_mode:=v_item.fulfillment_mode;
  IF v_mode='warehouse_pick' THEN
    SELECT assigned_to INTO v_picker FROM public.wms_orders
    WHERE work_order_id=v_item.work_order_id
      AND (fulfillment_mode='warehouse_pick' OR fulfillment_mode IS NULL)
      AND status<>'cancelled' AND assigned_to IS NOT NULL
    ORDER BY created_at DESC LIMIT 1;
    IF v_picker IS NULL THEN
      RAISE EXCEPTION 'ไม่พบผู้หยิบของของใบงาน กรุณามอบหมาย Picker ก่อน';
    END IF;
  END IF;

  INSERT INTO public.wms_orders(work_order_id,order_id,source_order_id,source_order_item_id,
    product_code,product_name,location,qty,unit_name,status,assigned_to,fulfillment_mode)
  VALUES(v_item.work_order_id,v_item.work_order_name,v_item.order_id,v_item.id,v_item.product_code,
    v_item.product_name,v_item.location,v_missing,v_item.unit_name,'pending',v_picker,v_mode);

  IF v_mode IN ('system_complete','sub_warehouse_skip') THEN
    UPDATE public.wms_orders SET status='correct',end_time=NOW()
    WHERE source_order_item_id=v_item.id AND status='pending' AND fulfillment_mode=v_mode;
  END IF;
  RETURN jsonb_build_object('success',true,'created_qty',v_missing,'mode',v_mode);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_repair_wms_missing_item(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_repair_wms_missing_item(UUID) TO authenticated,service_role;

-- One transaction: a plan failure now rolls the work-order header and order links back.
CREATE OR REPLACE FUNCTION public.rpc_create_work_order_with_plan(
  p_work_order_name TEXT,p_order_ids UUID[],p_plan_job_id TEXT,p_plan_date TEXT,
  p_cut TEXT,p_qty JSONB,p_order_index INTEGER
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_role TEXT; v_work_order_id UUID; v_requested INT; v_locked INT; v_auto_end TIMESTAMPTZ;
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

  UPDATE public.or_orders SET
    work_order_id=v_work_order_id,work_order_name=BTRIM(p_work_order_name),
    plan_released_from_work_order=NULL,plan_released_from_work_order_id=NULL,plan_released_at=NULL,
    status=CASE WHEN status='ย้ายจากใบงาน' THEN 'ใบสั่งงาน' ELSE status END
  WHERE id=ANY(p_order_ids);

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

-- Repair active headers left without plan_jobs by the previous non-atomic client flow.
WITH missing AS (
  SELECT wo.id,wo.work_order_name,wo.created_at,
    ROW_NUMBER() OVER (ORDER BY wo.created_at,wo.id) AS seq
  FROM public.or_work_orders wo
  WHERE wo.status='กำลังผลิต'
    AND EXISTS (SELECT 1 FROM public.or_orders o WHERE o.work_order_id=wo.id)
    AND NOT EXISTS (SELECT 1 FROM public.plan_jobs pj WHERE pj.work_order_id=wo.id)
), base_index AS (
  SELECT COALESCE(MAX(order_index),-1) AS max_idx FROM public.plan_jobs
), quantities AS (
  SELECT m.id,
    jsonb_build_object(
      'STAMP',COUNT(*) FILTER (WHERE UPPER(COALESCE(p.product_category,'')) LIKE '%STAMP%'),
      'STK',COUNT(*) FILTER (WHERE UPPER(COALESCE(p.product_category,'')) LIKE '%STK%'),
      'CTT',COUNT(*) FILTER (WHERE UPPER(COALESCE(p.product_category,'')) LIKE '%UV%' OR UPPER(COALESCE(p.product_category,'')) LIKE '%SUBLIMATION%'),
      'LASER',COUNT(*) FILTER (WHERE UPPER(COALESCE(p.product_category,'')) LIKE '%LASER%'),
      'TUBE',COUNT(*) FILTER (WHERE UPPER(COALESCE(p.product_category,'')) LIKE '%TUBE%'),
      'ETC',COUNT(*) FILTER (WHERE UPPER(COALESCE(p.product_category,'')) IN ('CALENDAR','ETC','INK')),
      'PACK',COUNT(DISTINCT o.id)
    ) AS qty
  FROM missing m
  JOIN public.or_orders o ON o.work_order_id=m.id
  LEFT JOIN public.or_order_items oi ON oi.order_id=o.id AND NOT COALESCE(oi.is_detail_row,false)
  LEFT JOIN public.pr_products p ON p.id=oi.product_id
  GROUP BY m.id
)
INSERT INTO public.plan_jobs(id,date,name,work_order_id,cut,qty,tracks,line_assignments,
  manual_plan_starts,locked_plans,order_index)
SELECT 'Jrepair'||SUBSTRING(REPLACE(m.id::TEXT,'-','') FROM 1 FOR 20),
  ((m.created_at AT TIME ZONE 'Asia/Bangkok')::DATE)::TEXT,m.work_order_name,m.id,
  TO_CHAR(m.created_at AT TIME ZONE 'Asia/Bangkok','HH24:MI'),q.qty,'{}','{}','{}','{}',
  b.max_idx+m.seq
FROM missing m CROSS JOIN base_index b JOIN quantities q ON q.id=m.id
ON CONFLICT(id) DO NOTHING;

-- Backfilled all-auto jobs have already completed the warehouse hand-off.
DO $$
DECLARE r RECORD; v_end TIMESTAMPTZ;
BEGIN
  FOR r IN
    SELECT pj.work_order_id
    FROM public.plan_jobs pj
    WHERE pj.work_order_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.or_orders o JOIN public.or_order_items oi ON oi.order_id=o.id
        JOIN public.pr_products p ON p.id=oi.product_id
        WHERE o.work_order_id=pj.work_order_id AND NOT COALESCE(oi.is_detail_row,false)
          AND public.fn_wms_item_fulfillment_mode(p.id,p.product_category::TEXT)='warehouse_pick'
      )
      AND EXISTS (SELECT 1 FROM public.wms_orders w WHERE w.work_order_id=pj.work_order_id
        AND w.fulfillment_mode IN ('system_complete','sub_warehouse_skip') AND w.status='correct')
  LOOP
    SELECT MAX(w.end_time) INTO v_end FROM public.wms_orders w WHERE w.work_order_id=r.work_order_id;
    v_end:=COALESCE(v_end,NOW());
    PERFORM public.merge_plan_tracks_by_work_order_id(r.work_order_id,'เบิก',jsonb_build_object(
      'หยิบของ',jsonb_build_object('start_if_null',v_end,'end',v_end),
      'ส่งมอบ',jsonb_build_object('start_if_null',v_end,'end',v_end)
    ));
  END LOOP;
END $$;

COMMIT;
