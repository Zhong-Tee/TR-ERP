-- ═══════════════════════════════════════════════════════════════════════════
-- 159: WMS fulfillment_mode + rpc_assign_wms_for_work_order
-- มอบหมายใบงาน: หยิบ (warehouse_pick) + ตัดสต๊อกอัตโนมัติ (insert system_complete → UPDATE correct)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── หมวดหมู่ที่ต้องหยิบ — ตรงกับ NewOrdersSection / wmsUtils ─────────────────
CREATE OR REPLACE FUNCTION fn_wms_is_pickable_category(p_cat TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    upper(trim(coalesce(p_cat, ''))) LIKE '%STAMP%'
    OR upper(trim(coalesce(p_cat, ''))) LIKE '%LASER%'
    OR upper(trim(coalesce(p_cat, ''))) IN ('CALENDAR', 'ETC', 'INK'),
    false
  );
$$;

COMMENT ON FUNCTION fn_wms_is_pickable_category IS
  'STAMP/LASER (substring), CALENDAR/ETC/INK (exact) — ตรงกับ WMS NewOrdersSection';

ALTER TABLE wms_orders
  ADD COLUMN IF NOT EXISTS fulfillment_mode TEXT NOT NULL DEFAULT 'warehouse_pick';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wms_orders_fulfillment_mode_check'
  ) THEN
    ALTER TABLE wms_orders
      ADD CONSTRAINT wms_orders_fulfillment_mode_check
      CHECK (fulfillment_mode IN ('warehouse_pick', 'system_complete'));
  END IF;
END $$;

COMMENT ON COLUMN wms_orders.fulfillment_mode IS
  'warehouse_pick=หยิบจริง (แสดง Picker), system_complete=ตัดสต๊อกอัตโนมัติหลังมอบหมาย';

-- ═══════════════════════════════════════════════════════════════════════════
-- rpc_assign_wms_for_work_order
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION rpc_assign_wms_for_work_order(
  p_work_order_name TEXT,
  p_picker_id       UUID
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
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN (
    'superadmin', 'admin', 'store', 'manager', 'production'
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์มอบหมาย WMS (ต้องเป็น superadmin / admin / store / manager / production)';
  END IF;

  IF p_work_order_name IS NULL OR trim(p_work_order_name) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ต้องระบุใบงาน');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM us_users WHERE id = p_picker_id AND role = 'picker'
  ) INTO v_picker_ok;

  IF NOT coalesce(v_picker_ok, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'ต้องระบุผู้ใช้ role picker ที่ถูกต้อง');
  END IF;

  SELECT COUNT(*) INTO v_existing
  FROM wms_orders
  WHERE order_id = p_work_order_name
    AND status <> 'cancelled';

  IF v_existing > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'ใบงานนี้ถูกสร้างในระบบ WMS แล้ว'
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM or_orders o
    JOIN or_order_items oi ON oi.order_id = o.id
    WHERE o.work_order_name = p_work_order_name
  ) INTO v_has_items;

  IF NOT v_has_items THEN
    RETURN jsonb_build_object('success', false, 'error', 'ไม่พบรายการสินค้าในใบงานนี้');
  END IF;

  -- 1) หยิบ: รายการหลัก (รวม CONDO STAMP)
  WITH base AS (
    SELECT
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
    WHERE o.work_order_name = p_work_order_name
      AND fn_wms_is_pickable_category(p.product_category::text)
    GROUP BY oi.product_id
  )
  INSERT INTO wms_orders (
    order_id, product_code, product_name, location, qty, unit_name,
    assigned_to, status, fulfillment_mode
  )
  SELECT
    trim(p_work_order_name),
    coalesce(nullif(trim(product_code), ''), product_name, 'N/A'),
    product_name,
    coalesce(loc, ''),
    CASE
      WHEN upper(coalesce(cat, '')) LIKE '%CONDO STAMP%'
        THEN ceil(sum_q / 5)::int
      ELSE sum_q::int
    END,
    unit_name,
    p_picker_id,
    'pending',
    'warehouse_pick'
  FROM base;

  GET DIAGNOSTICS v_pick_norm = ROW_COUNT;

  -- 2) หยิบ: อะไหล่ตาม rubber_code
  WITH spare_src AS (
    SELECT
      p.rubber_code AS rc,
      sum(coalesce(oi.quantity, 1)::numeric) AS spare_qty
    FROM or_orders o
    JOIN or_order_items oi ON oi.order_id = o.id
    JOIN pr_products p ON p.id = oi.product_id
    WHERE o.work_order_name = p_work_order_name
      AND p.rubber_code IS NOT NULL
      AND trim(p.rubber_code::text) <> ''
      AND fn_wms_is_pickable_category(p.product_category::text)
    GROUP BY p.rubber_code
  )
  INSERT INTO wms_orders (
    order_id, product_code, product_name, location, qty, unit_name,
    assigned_to, status, fulfillment_mode
  )
  SELECT
    trim(p_work_order_name),
    'SPARE_PART',
    'หน้ายาง+โฟม ' || rc,
    'อะไหล่',
    spare_qty::int,
    'ชิ้น',
    p_picker_id,
    'pending',
    'warehouse_pick'
  FROM spare_src;

  GET DIAGNOSTICS v_pick_spare = ROW_COUNT;

  -- 3) ไม่ต้องหยิบ: ตัดสต๊อก — INSERT pending แล้ว UPDATE correct (ให้ trigger ตัดสต๊อก)
  WITH base_np AS (
    SELECT
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
    WHERE o.work_order_name = p_work_order_name
      AND NOT fn_wms_is_pickable_category(p.product_category::text)
      AND coalesce(oi.is_free, false) = false
      AND oi.product_id IS NOT NULL
      AND p.product_code IS NOT NULL
      AND trim(p.product_code::text) <> ''
    GROUP BY oi.product_id
  ),
  ins AS (
    INSERT INTO wms_orders (
      order_id, product_code, product_name, location, qty, unit_name,
      assigned_to, status, fulfillment_mode
    )
    SELECT
      trim(p_work_order_name),
      trim(product_code),
      product_name,
      coalesce(loc, ''),
      CASE
        WHEN upper(coalesce(cat, '')) LIKE '%CONDO STAMP%'
          THEN ceil(sum_q / 5)::int
        ELSE sum_q::int
      END,
      unit_name,
      p_picker_id,
      'pending',
      'system_complete'
    FROM base_np
    RETURNING id
  )
  UPDATE wms_orders w
  SET status = 'correct'
  FROM ins
  WHERE w.id = ins.id;

  GET DIAGNOSTICS v_system = ROW_COUNT;

  IF (coalesce(v_pick_norm, 0) + coalesce(v_pick_spare, 0) + coalesce(v_system, 0)) = 0 THEN
    -- ลบแถวที่อาจค้าง (ไม่ควรมี) แล้วคืน error
    DELETE FROM wms_orders WHERE order_id = trim(p_work_order_name);
    RETURN jsonb_build_object(
      'success', false,
      'error',
      'ไม่มีรายการที่สร้าง WMS ได้ (ตรวจสอบ product_id / สินค้าฟรี / รหัสสินค้า)'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'work_order_name', trim(p_work_order_name),
    'warehouse_pick_main', coalesce(v_pick_norm, 0),
    'warehouse_pick_spare', coalesce(v_pick_spare, 0),
    'system_complete', coalesce(v_system, 0)
  );
END;
$$;

COMMENT ON FUNCTION rpc_assign_wms_for_work_order IS
  'มอบหมายใบงาน WMS: แถวหยิบ pending + แถวไม่หยิบตัดสต๊อกอัตโนมัติ (system_complete)';

REVOKE ALL ON FUNCTION rpc_assign_wms_for_work_order(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_assign_wms_for_work_order(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_assign_wms_for_work_order(TEXT, UUID) TO service_role;
