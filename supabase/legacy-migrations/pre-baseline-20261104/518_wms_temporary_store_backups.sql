-- สิทธิ์พนักงาน Store สำรองแบบชั่วคราวราย User
-- ให้เฉพาะ role production, qc_staff, packing_staff ใช้งาน WMS เมนู
-- "ใบงานใหม่" และ "ตรวจสินค้า" โดยไม่เปลี่ยน role หลัก

BEGIN;

CREATE TABLE IF NOT EXISTS public.wms_store_backup_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES public.us_users(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  granted_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wms_store_backup_valid_period CHECK (ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS idx_wms_store_backup_active_period
  ON public.wms_store_backup_assignments (user_id, is_active, starts_at, ends_at);

ALTER TABLE public.wms_store_backup_assignments ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.wms_store_backup_assignments
TO authenticated;

CREATE OR REPLACE FUNCTION public.is_current_wms_store_backup()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.wms_store_backup_assignments assignment
    JOIN public.us_users app_user ON app_user.id = assignment.user_id
    WHERE assignment.user_id = auth.uid()
      AND assignment.is_active = true
      AND NOW() BETWEEN assignment.starts_at AND assignment.ends_at
      AND app_user.is_active IS DISTINCT FROM false
      AND app_user.role IN ('production', 'qc_staff', 'packing_staff')
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_wms_store_backups()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid()
      AND is_active IS DISTINCT FROM false
      AND role IN ('superadmin', 'admin', 'store')
  );
$$;

REVOKE ALL ON FUNCTION public.is_current_wms_store_backup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_manage_wms_store_backups() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_current_wms_store_backup() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_wms_store_backups() TO authenticated;

DROP POLICY IF EXISTS "Store backup assignments readable" ON public.wms_store_backup_assignments;
CREATE POLICY "Store backup assignments readable"
  ON public.wms_store_backup_assignments FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.can_manage_wms_store_backups());

DROP POLICY IF EXISTS "Store backup assignments insertable" ON public.wms_store_backup_assignments;
CREATE POLICY "Store backup assignments insertable"
  ON public.wms_store_backup_assignments FOR INSERT TO authenticated
  WITH CHECK (
    public.can_manage_wms_store_backups()
    AND EXISTS (
      SELECT 1 FROM public.us_users target
      WHERE target.id = user_id
        AND target.is_active IS DISTINCT FROM false
        AND target.role IN ('production', 'qc_staff', 'packing_staff')
    )
  );

DROP POLICY IF EXISTS "Store backup assignments updatable" ON public.wms_store_backup_assignments;
CREATE POLICY "Store backup assignments updatable"
  ON public.wms_store_backup_assignments FOR UPDATE TO authenticated
  USING (public.can_manage_wms_store_backups())
  WITH CHECK (
    public.can_manage_wms_store_backups()
    AND EXISTS (
      SELECT 1 FROM public.us_users target
      WHERE target.id = user_id
        AND target.is_active IS DISTINCT FROM false
        AND target.role IN ('production', 'qc_staff', 'packing_staff')
    )
  );

DROP POLICY IF EXISTS "Store backup assignments deletable" ON public.wms_store_backup_assignments;
CREATE POLICY "Store backup assignments deletable"
  ON public.wms_store_backup_assignments FOR DELETE TO authenticated
  USING (public.can_manage_wms_store_backups());

-- ผู้จัดการสิทธิ์ต้องค้นหาพนักงานที่เลือกได้ และผู้สำรองต้องเห็นรายชื่อ Picker
DROP POLICY IF EXISTS "Store backup managers can view eligible users" ON public.us_users;
CREATE POLICY "Store backup managers can view eligible users"
  ON public.us_users FOR SELECT TO authenticated
  USING (
    public.can_manage_wms_store_backups()
    AND is_active IS DISTINCT FROM false
    AND role IN ('production', 'qc_staff', 'packing_staff')
  );

DROP POLICY IF EXISTS "Active store backups can view pickers" ON public.us_users;
CREATE POLICY "Active store backups can view pickers"
  ON public.us_users FOR SELECT TO authenticated
  USING (public.is_current_wms_store_backup() AND role = 'picker' AND is_active IS DISTINCT FROM false);

-- สิทธิ์ข้อมูลที่สองเมนูใช้งานจริง (เพิ่มเป็น policy แยก จึงไม่กระทบ policy เดิม)
DROP POLICY IF EXISTS "Store backups can view WMS orders" ON public.wms_orders;
CREATE POLICY "Store backups can view WMS orders"
  ON public.wms_orders FOR SELECT TO authenticated
  USING (public.is_current_wms_store_backup());

DROP POLICY IF EXISTS "Store backups can insert WMS orders" ON public.wms_orders;
CREATE POLICY "Store backups can insert WMS orders"
  ON public.wms_orders FOR INSERT TO authenticated
  WITH CHECK (public.is_current_wms_store_backup());

DROP POLICY IF EXISTS "Store backups can update WMS orders" ON public.wms_orders;
CREATE POLICY "Store backups can update WMS orders"
  ON public.wms_orders FOR UPDATE TO authenticated
  USING (public.is_current_wms_store_backup())
  WITH CHECK (public.is_current_wms_store_backup());

DROP POLICY IF EXISTS "Store backups can view WMS summaries" ON public.wms_order_summaries;
CREATE POLICY "Store backups can view WMS summaries"
  ON public.wms_order_summaries FOR SELECT TO authenticated
  USING (public.is_current_wms_store_backup());

DROP POLICY IF EXISTS "Store backups can insert WMS summaries" ON public.wms_order_summaries;
CREATE POLICY "Store backups can insert WMS summaries"
  ON public.wms_order_summaries FOR INSERT TO authenticated
  WITH CHECK (public.is_current_wms_store_backup());

DROP POLICY IF EXISTS "Store backups can update WMS summaries" ON public.wms_order_summaries;
CREATE POLICY "Store backups can update WMS summaries"
  ON public.wms_order_summaries FOR UPDATE TO authenticated
  USING (public.is_current_wms_store_backup())
  WITH CHECK (public.is_current_wms_store_backup());

DROP POLICY IF EXISTS "Store backups can view requisitions for review" ON public.wms_requisitions;
CREATE POLICY "Store backups can view requisitions for review"
  ON public.wms_requisitions FOR SELECT TO authenticated
  USING (public.is_current_wms_store_backup());

DROP POLICY IF EXISTS "Store backups can view requisition items for review" ON public.wms_requisition_items;
CREATE POLICY "Store backups can view requisition items for review"
  ON public.wms_requisition_items FOR SELECT TO authenticated
  USING (public.is_current_wms_store_backup());

-- รองรับ Store สำรองใน RPC มอบหมาย Picker รุ่นล่าสุด
CREATE OR REPLACE FUNCTION public.rpc_assign_wms_for_work_order_v2(
  p_work_order_id UUID,p_picker_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_role TEXT; v_existing INT; v_has_items BOOLEAN; v_pick_norm INT;
  v_pick_spare INT; v_system INT; v_sub_skip INT; v_picker_ok BOOLEAN; v_work_order_name TEXT;
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

-- บิลยกเลิกในหน้าตรวจสินค้าใช้ stock_action จึงต้องยอมรับ Store สำรองด้วย
CREATE OR REPLACE FUNCTION public.trg_guard_cancelled_stock_action_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_jwt_role text;
BEGIN
  IF NEW.stock_action IS NOT DISTINCT FROM OLD.stock_action THEN RETURN NEW; END IF;
  IF NEW.stock_action IN ('recalled', 'waste') THEN
    v_jwt_role := COALESCE(current_setting('request.jwt.claim.role', true), '');
    IF v_jwt_role = 'service_role' THEN RETURN NEW; END IF;
    SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
    IF COALESCE(v_role, '') NOT IN ('superadmin', 'admin', 'store')
       AND NOT public.is_current_wms_store_backup() THEN
      RAISE EXCEPTION 'ไม่มีสิทธิ์ปรับสต๊อคบิลยกเลิก (role: %)', COALESCE(v_role, 'unknown')
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
