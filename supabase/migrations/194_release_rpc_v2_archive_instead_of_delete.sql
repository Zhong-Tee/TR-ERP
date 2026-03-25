-- 194: ป้องกัน work_order_id กลายเป็น NULL หลังย้ายบิลหมด
-- เดิม: ลบ or_work_orders -> FK (ON DELETE SET NULL) ทำให้ wms_orders/plan_jobs หลุด work_order_id
-- ใหม่: ไม่ลบ or_work_orders แต่ mark status เป็น "ยกเลิก" แทน

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
    plan_released_from_work_order_id = p_work_order_id,
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

    IF EXISTS (
      SELECT 1
      FROM plan_jobs pj
      WHERE pj.work_order_id = p_work_order_id
        AND fn_plan_job_has_any_track_start(pj.name)
    ) THEN
      UPDATE plan_jobs
      SET
        qty = fn_plan_qty_json_for_work_order(v_wo_name),
        is_production_voided = true
      WHERE work_order_id = p_work_order_id;
    ELSE
      DELETE FROM plan_jobs WHERE work_order_id = p_work_order_id;
    END IF;

    -- สำคัญ: ไม่ลบ or_work_orders เพื่อไม่ให้ FK set null ที่ wms_orders/plan_jobs
    UPDATE or_work_orders
    SET
      status = 'ยกเลิก',
      order_count = 0,
      plan_wo_modified = true
    WHERE id = p_work_order_id;
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

