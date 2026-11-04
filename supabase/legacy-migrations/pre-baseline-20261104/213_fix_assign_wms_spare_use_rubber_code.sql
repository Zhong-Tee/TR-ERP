-- 213: แก้ rpc_assign_wms_for_work_order_v2 ให้สร้างรายการอะไหล่จาก pr_products.rubber_code
-- เดิมอ้าง product_code='SPARE_PART' ทำให้บางใบงาน (เช่น SPTR-270369-R1) ไม่สร้างแถวอะไหล่ใน wms_orders

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
  v_role            TEXT;
  v_existing        INT;
  v_has_items       BOOLEAN;
  v_pick_norm       INT;
  v_pick_spare      INT;
  v_system          INT;
  v_picker_ok       BOOLEAN;
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

  -- 1) หยิบ: รายการหลัก
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

  -- 2) หยิบ: อะไหล่ตาม rubber_code (ต่อบิล)
  WITH spare AS (
    SELECT
      o.id AS source_order_id,
      NULL::uuid AS source_order_item_id,
      p.rubber_code AS rc,
      sum(coalesce(oi.quantity, 1)::numeric) AS sum_q
    FROM or_orders o
    JOIN or_order_items oi ON oi.order_id = o.id
    JOIN pr_products p ON p.id = oi.product_id
    WHERE o.work_order_id = p_work_order_id
      AND p.rubber_code IS NOT NULL
      AND trim(p.rubber_code::text) <> ''
      AND fn_wms_is_pickable_category(p.product_category::text)
    GROUP BY o.id, p.rubber_code
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
      'SPARE_PART', 'หน้ายาง+โฟม ' || rc, 'อะไหล่',
      sum_q, 'ชิ้น',
      'pending', p_picker_id,
      'warehouse_pick'
    FROM spare
    RETURNING id
  )
  SELECT COUNT(*) INTO v_pick_spare FROM ins2;

  -- 3) non-pick auto consume
  PERFORM fn_wms_try_auto_consume_non_pick(v_work_order_name);
  SELECT COUNT(*) INTO v_system
  FROM wms_orders
  WHERE work_order_id = p_work_order_id
    AND fulfillment_mode = 'system_complete'
    AND status IN ('correct', 'system_complete');

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

