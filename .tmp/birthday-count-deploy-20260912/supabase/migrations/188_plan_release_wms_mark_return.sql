-- 188: เมื่อย้ายบิลออกจากใบงาน — แถว WMS ที่หยิบ/ตรวจแล้วไม่บล็อกการย้าย
--      ตั้ง plan_line_released เพื่อให้หน้าตรวจสินค้ากด "คืนเข้าคลัง" (status returned)
--      และไม่ลบแถวเหล่านั้นเมื่อใบงานว่าง

CREATE OR REPLACE FUNCTION rpc_plan_release_orders_to_workqueue(
  p_work_order_name TEXT,
  p_order_ids       UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     TEXT;
  v_wo       TEXT;
  v_uid      UUID;
  v_remain   INT;
  v_legacy   BOOLEAN;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN (
    'superadmin', 'admin', 'store', 'manager', 'production', 'admin-tr', 'admin_qc'
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ย้ายบิลไปใบสั่งงาน';
  END IF;

  v_wo := trim(both FROM coalesce(p_work_order_name, ''));
  IF v_wo = '' OR p_order_ids IS NULL OR array_length(p_order_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ข้อมูลไม่ครบ');
  END IF;

  FOREACH v_uid IN ARRAY p_order_ids
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM or_orders o
      WHERE o.id = v_uid AND trim(both FROM coalesce(o.work_order_name, '')) = v_wo
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'บิลไม่อยู่ในใบงานนี้');
    END IF;
  END LOOP;

  SELECT EXISTS (
    SELECT 1 FROM wms_orders w
    WHERE trim(both FROM coalesce(w.order_id, '')) = v_wo
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
  WHERE trim(both FROM coalesce(w.order_id, '')) = v_wo
    AND w.source_order_id = ANY (p_order_ids)
    AND w.status IN ('picked', 'correct', 'system_complete')
    AND w.status NOT IN ('cancelled', 'returned');

  DELETE FROM wms_orders w
  WHERE trim(both FROM coalesce(w.order_id, '')) = v_wo
    AND w.source_order_id = ANY (p_order_ids)
    AND w.status = 'pending';

  UPDATE or_orders o
  SET
    work_order_name = NULL,
    status = 'ใบสั่งงาน',
    plan_released_from_work_order = v_wo,
    plan_released_at = NOW(),
    updated_at = NOW()
  WHERE o.id = ANY (p_order_ids)
    AND trim(both FROM coalesce(o.work_order_name, '')) = v_wo;

  SELECT COUNT(*) INTO v_remain
  FROM or_orders o
  WHERE trim(both FROM coalesce(o.work_order_name, '')) = v_wo;

  IF v_remain = 0 THEN
    DELETE FROM wms_orders w
    WHERE trim(both FROM coalesce(w.order_id, '')) = v_wo
      AND NOT (
        w.plan_line_released = true
        AND w.status IN ('picked', 'correct', 'system_complete')
      );
    IF fn_plan_job_has_any_track_start(v_wo) THEN
      UPDATE plan_jobs
      SET
        qty = fn_plan_qty_json_for_work_order(v_wo),
        is_production_voided = true
      WHERE trim(both FROM name) = v_wo;
      DELETE FROM or_work_orders WHERE trim(both FROM coalesce(work_order_name, '')) = v_wo;
    ELSE
      DELETE FROM plan_jobs WHERE trim(both FROM name) = v_wo;
      DELETE FROM or_work_orders WHERE trim(both FROM coalesce(work_order_name, '')) = v_wo;
    END IF;
  ELSE
    UPDATE or_work_orders wo
    SET
      order_count = v_remain,
      plan_wo_modified = true
    WHERE trim(both FROM coalesce(wo.work_order_name, '')) = v_wo;

    UPDATE plan_jobs pj
    SET qty = fn_plan_qty_json_for_work_order(v_wo)
    WHERE trim(both FROM pj.name) = v_wo;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'work_order_name', v_wo,
    'remaining_bills', v_remain
  );
END;
$$;

COMMENT ON FUNCTION rpc_plan_release_orders_to_workqueue IS
  'ย้ายบิลกลับคิว Plan→ใบสั่งงาน: ลบแถว WMS pending, ทำเครื่องหมายแถวหยิบ/ตรวจเพื่อคืนคลัง, อัปเดต or_orders + plan_jobs.qty';
