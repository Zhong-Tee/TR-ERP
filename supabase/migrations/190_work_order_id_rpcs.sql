-- 190: RPC/Functions รุ่นใหม่ที่อ้างอิงใบงานด้วย work_order_id (UUID)

-- ─────────────────────────────────────────────────────────────────────────────
-- merge_plan_tracks_by_work_order_id
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION merge_plan_tracks_by_work_order_id(
  p_work_order_id UUID,
  p_dept     TEXT,
  p_patch    JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id TEXT;
  v_count  INT;
BEGIN
  IF p_work_order_id IS NULL THEN
    RAISE EXCEPTION 'ต้องระบุ work_order_id';
  END IF;

  SELECT count(*) INTO v_count
    FROM plan_jobs
   WHERE work_order_id = p_work_order_id;

  IF v_count = 0 THEN
    RAISE WARNING 'merge_plan_tracks_by_work_order_id: no plan_job with work_order_id=%', p_work_order_id;
    RETURN NULL;
  END IF;

  SELECT id INTO v_job_id
    FROM plan_jobs
   WHERE work_order_id = p_work_order_id
   ORDER BY date DESC
   LIMIT 1;

  RETURN merge_plan_tracks(v_job_id, p_dept, p_patch);
END;
$$;

REVOKE ALL ON FUNCTION merge_plan_tracks_by_work_order_id(UUID, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merge_plan_tracks_by_work_order_id(UUID, TEXT, JSONB) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- rpc_assign_wms_for_work_order_v2 (work_order_id based)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION rpc_assign_wms_for_work_order_v2(
  p_work_order_id UUID,
  p_picker_id     UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role           TEXT;
  v_existing       INT;
  v_has_items      BOOLEAN;
  v_pick_norm      INT;
  v_pick_spare     INT;
  v_system         INT;
  v_picker_ok      BOOLEAN;
  v_work_order_name TEXT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'store', 'manager', 'production') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์มอบหมาย WMS';
  END IF;

  IF p_work_order_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ต้องระบุใบงาน');
  END IF;

  SELECT work_order_name INTO v_work_order_name
  FROM or_work_orders
  WHERE id = p_work_order_id;

  IF v_work_order_name IS NULL OR trim(v_work_order_name) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ไม่พบใบงาน');
  END IF;

  SELECT EXISTS (SELECT 1 FROM us_users WHERE id = p_picker_id AND role = 'picker') INTO v_picker_ok;
  IF NOT coalesce(v_picker_ok, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'ต้องระบุผู้ใช้ role picker ที่ถูกต้อง');
  END IF;

  SELECT COUNT(*) INTO v_existing
  FROM wms_orders
  WHERE work_order_id = p_work_order_id
    AND status <> 'cancelled';

  IF v_existing > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'ใบงานนี้ถูกสร้างในระบบ WMS แล้ว');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM or_orders o
    JOIN or_order_items oi ON oi.order_id = o.id
    WHERE o.work_order_id = p_work_order_id
  ) INTO v_has_items;

  IF NOT v_has_items THEN
    RETURN jsonb_build_object('success', false, 'error', 'ไม่พบรายการสินค้าในใบงานนี้');
  END IF;

  -- 1) หยิบ: รายการหลัก (แยกต่อบิล/บรรทัด ตาม Phase 2)
  WITH base AS (
    SELECT
      o.id AS source_order_id,
      oi.id AS source_order_item_id,
      oi.product_id,
      max(oi.product_name::text) AS product_name,
      sum(coalesce(oi.quantity, 1)::numeric) AS sum_q,
      max(p.product_category)::text AS cat,
      max(p.product_code)::text AS product_code,
      max(p.storage_location)::text AS loc,
      max(coalesce(nullif(trim(p.unit_name::text), ''), 'ชิ้น')) AS unit_name
    FROM or_orders o
    JOIN or_order_items oi ON oi.order_id = o.id
    JOIN pr_products p ON p.id = oi.product_id
    WHERE o.work_order_id = p_work_order_id
      AND fn_wms_is_pickable_category(p.product_category::text)
    GROUP BY o.id, oi.id, oi.product_id
  ),
  ins AS (
    INSERT INTO wms_orders (
      work_order_id, order_id,
      source_order_id, source_order_item_id,
      product_code, product_name, location,
      qty, unit_name,
      status, assigned_to,
      fulfillment_mode
    )
    SELECT
      p_work_order_id, v_work_order_name,
      source_order_id, source_order_item_id,
      product_code, product_name, loc,
      -- CONDO STAMP: ceil(qty/5) สำหรับ SKU ชื่อ/หมวดที่ต้องการ (คง logic เดิม: ดู product_code)
      CASE
        WHEN upper(coalesce(product_code,'')) LIKE '%CONDO%' AND upper(coalesce(cat,'')) LIKE '%STAMP%' THEN CEIL(sum_q / 5.0)
        ELSE sum_q
      END::numeric AS qty,
      unit_name,
      'pending', p_picker_id,
      'warehouse_pick'
    FROM base
    GROUP BY source_order_id, source_order_item_id, product_code, product_name, loc, unit_name, cat, sum_q
    RETURNING id
  )
  SELECT COUNT(*) INTO v_pick_norm FROM ins;

  -- 2) หยิบ: SPARE_PART แยกต่อบิล (ถ้ามี)
  WITH spare AS (
    SELECT
      o.id AS source_order_id,
      oi.id AS source_order_item_id,
      sum(coalesce(oi.quantity, 1)::numeric) AS sum_q
    FROM or_orders o
    JOIN or_order_items oi ON oi.order_id = o.id
    JOIN pr_products p ON p.id = oi.product_id
    WHERE o.work_order_id = p_work_order_id
      AND upper(trim(coalesce(p.product_code::text,''))) = 'SPARE_PART'
    GROUP BY o.id, oi.id
  ),
  ins2 AS (
    INSERT INTO wms_orders (
      work_order_id, order_id,
      source_order_id, source_order_item_id,
      product_code, product_name, location,
      qty, unit_name,
      status, assigned_to,
      fulfillment_mode
    )
    SELECT
      p_work_order_id, v_work_order_name,
      source_order_id, source_order_item_id,
      'SPARE_PART', 'อะไหล่/อุปกรณ์เสริม', NULL,
      sum_q, 'ชิ้น',
      'pending', p_picker_id,
      'warehouse_pick'
    FROM spare
    RETURNING id
  )
  SELECT COUNT(*) INTO v_pick_spare FROM ins2;

  -- 3) ตัดสต๊อคอัตโนมัติสำหรับรายการ non-pick (ใช้ฟังก์ชันเดิม แต่ต้องให้มันอ้าง work_order_id)
  -- NOTE: จะ refactor fn_wms_try_auto_consume_non_pick_v2 ใน migration ถัดไปถ้าจำเป็น
  SELECT coalesce((fn_wms_try_auto_consume_non_pick(v_work_order_name)->>'system_complete')::int, 0) INTO v_system;

  RETURN jsonb_build_object(
    'success', true,
    'work_order_id', p_work_order_id,
    'work_order_name', v_work_order_name,
    'warehouse_pick_main', coalesce(v_pick_norm, 0),
    'warehouse_pick_spare', coalesce(v_pick_spare, 0),
    'system_complete', coalesce(v_system, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION rpc_assign_wms_for_work_order_v2(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_assign_wms_for_work_order_v2(UUID, UUID) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- rpc_plan_release_orders_to_workqueue_v2 (work_order_id based)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION rpc_plan_release_orders_to_workqueue_v2(
  p_work_order_id UUID,
  p_order_ids     UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     TEXT;
  v_wo_name  TEXT;
  v_uid      UUID;
  v_remain   INT;
  v_legacy   BOOLEAN;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'store', 'manager', 'production', 'admin-tr', 'admin_qc') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ย้ายบิลไปใบสั่งงาน';
  END IF;

  IF p_work_order_id IS NULL OR p_order_ids IS NULL OR array_length(p_order_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ข้อมูลไม่ครบ');
  END IF;

  SELECT work_order_name INTO v_wo_name
  FROM or_work_orders
  WHERE id = p_work_order_id;

  IF v_wo_name IS NULL OR trim(v_wo_name) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ไม่พบใบงาน');
  END IF;

  FOREACH v_uid IN ARRAY p_order_ids
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM or_orders o
      WHERE o.id = v_uid AND o.work_order_id = p_work_order_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'บิลไม่อยู่ในใบงานนี้');
    END IF;
  END LOOP;

  SELECT EXISTS (
    SELECT 1 FROM wms_orders w
    WHERE w.work_order_id = p_work_order_id
      AND w.source_order_id IS NULL
      AND w.status NOT IN ('cancelled', 'returned')
  ) INTO v_legacy;

  IF v_legacy THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'wms_legacy',
      'error', 'ใบงานนี้ได้มีการเบิกสินค้าไปแล้ว ติดต่อหัวหน้างานเพื่อทำการยกเลิกบิล หากต้องการเปลี่ยนแปลง'
    );
  END IF;

  UPDATE wms_orders w
  SET plan_line_released = true
  WHERE w.work_order_id = p_work_order_id
    AND w.source_order_id = ANY (p_order_ids)
    AND w.status IN ('picked', 'correct', 'system_complete')
    AND w.status NOT IN ('cancelled', 'returned');

  DELETE FROM wms_orders w
  WHERE w.work_order_id = p_work_order_id
    AND w.source_order_id = ANY (p_order_ids)
    AND w.status = 'pending';

  UPDATE or_orders o
  SET
    work_order_id = NULL,
    work_order_name = NULL,
    status = 'ใบสั่งงาน',
    plan_released_from_work_order = v_wo_name,
    plan_released_at = NOW(),
    updated_at = NOW()
  WHERE o.id = ANY (p_order_ids)
    AND o.work_order_id = p_work_order_id;

  SELECT COUNT(*) INTO v_remain
  FROM or_orders o
  WHERE o.work_order_id = p_work_order_id;

  IF v_remain = 0 THEN
    DELETE FROM wms_orders w
    WHERE w.work_order_id = p_work_order_id
      AND NOT (
        w.plan_line_released = true
        AND w.status IN ('picked', 'correct', 'system_complete')
      );
    -- plan_jobs: ถ้ามี track start ให้ void, ไม่งั้นลบ
    IF EXISTS (SELECT 1 FROM plan_jobs pj WHERE pj.work_order_id = p_work_order_id AND fn_plan_job_has_any_track_start(pj.name)) THEN
      UPDATE plan_jobs
      SET
        qty = fn_plan_qty_json_for_work_order(v_wo_name),
        is_production_voided = true
      WHERE work_order_id = p_work_order_id;
      DELETE FROM or_work_orders WHERE id = p_work_order_id;
    ELSE
      DELETE FROM plan_jobs WHERE work_order_id = p_work_order_id;
      DELETE FROM or_work_orders WHERE id = p_work_order_id;
    END IF;
  ELSE
    UPDATE or_work_orders wo
    SET
      order_count = v_remain,
      plan_wo_modified = true
    WHERE wo.id = p_work_order_id;

    UPDATE plan_jobs pj
    SET qty = fn_plan_qty_json_for_work_order(v_wo_name)
    WHERE pj.work_order_id = p_work_order_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'work_order_id', p_work_order_id,
    'work_order_name', v_wo_name,
    'remaining_bills', v_remain
  );
END;
$$;

REVOKE ALL ON FUNCTION rpc_plan_release_orders_to_workqueue_v2(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_plan_release_orders_to_workqueue_v2(UUID, UUID[]) TO authenticated;

