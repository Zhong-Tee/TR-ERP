-- ═══════════════════════════════════════════════════════════════════════════
-- 186: WMS แถวต่อบิล (source_order_id) + ย้ายไปใบสั่งงาน + status returned + Plan qty
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── or_orders: ประวัติย้ายจากใบงาน (Dashboard ป้าย "แก้ไข") ─────────────────
ALTER TABLE or_orders ADD COLUMN IF NOT EXISTS plan_released_from_work_order TEXT;
ALTER TABLE or_orders ADD COLUMN IF NOT EXISTS plan_released_at TIMESTAMPTZ;

COMMENT ON COLUMN or_orders.plan_released_from_work_order IS
  'ชื่อใบงานล่าสุดที่บิลนี้ถูก "ย้ายไปใบสั่งงาน" จากใบงานนั้น';

-- ─── or_work_orders: ใบงานถูกแก้ไข (บางบิลถูกย้ายออก) ───────────────────────
ALTER TABLE or_work_orders ADD COLUMN IF NOT EXISTS plan_wo_modified BOOLEAN NOT NULL DEFAULT false;

-- ─── plan_jobs: ป้ายยกเลิกการผลิต (มี timestamp แล้ว แต่ไม่มีบิลเหลือ) ───────
ALTER TABLE plan_jobs ADD COLUMN IF NOT EXISTS is_production_voided BOOLEAN NOT NULL DEFAULT false;

-- ─── wms_orders: อ้างอิงบิล / บรรทัดบิล ─────────────────────────────────────
ALTER TABLE wms_orders ADD COLUMN IF NOT EXISTS source_order_id UUID REFERENCES or_orders(id) ON DELETE SET NULL;
ALTER TABLE wms_orders ADD COLUMN IF NOT EXISTS source_order_item_id UUID REFERENCES or_order_items(id) ON DELETE SET NULL;
ALTER TABLE wms_orders ADD COLUMN IF NOT EXISTS plan_line_released BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_wms_orders_source_order_id ON wms_orders(source_order_id);

COMMENT ON COLUMN wms_orders.source_order_id IS 'บิล (or_orders) ที่รายการ WMS นี้ผูก';
COMMENT ON COLUMN wms_orders.plan_line_released IS 'true เมื่อบิลถูกย้ายออกจากใบงานแต่แถวค้างเพื่อคืนสต๊อก/แจ้งเตือน';

-- ─── ตรวจว่า Master Plan มีการเริ่ม timestamp ใน tracks หรือไม่ ────────────────
CREATE OR REPLACE FUNCTION fn_plan_job_has_any_track_start(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_tracks JSONB;
  d          RECORD;
  s          RECORD;
BEGIN
  SELECT pj.tracks INTO v_tracks
  FROM plan_jobs pj
  WHERE trim(both FROM pj.name) = trim(both FROM coalesce(p_name, ''))
  LIMIT 1;

  IF v_tracks IS NULL OR v_tracks = '{}'::jsonb THEN
    RETURN false;
  END IF;

  FOR d IN SELECT * FROM jsonb_each(v_tracks)
  LOOP
    CONTINUE WHEN d.value IS NULL OR jsonb_typeof(d.value) <> 'object';
    FOR s IN SELECT * FROM jsonb_each(d.value)
    LOOP
      CONTINUE WHEN s.value IS NULL OR jsonb_typeof(s.value) <> 'object';
      IF (s.value ? 'start') AND nullif(trim(s.value->>'start'), '') IS NOT NULL THEN
        RETURN true;
      END IF;
    END LOOP;
  END LOOP;

  RETURN false;
END;
$$;

-- ─── คำนวณ qty JSON สำหรับ plan_jobs จากบิลที่ยังผูก work_order_name ─────────
CREATE OR REPLACE FUNCTION fn_plan_qty_json_for_work_order(p_work_order_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_pack INT := 0;
  v_qty JSONB := '{"STAMP":0,"STK":0,"CTT":0,"LASER":0,"TUBE":0,"ETC":0,"PACK":0}'::jsonb;
  v_cat TEXT;
  v_bill_ids UUID[];
BEGIN
  SELECT array_agg(o.id) INTO v_bill_ids
  FROM or_orders o
  WHERE trim(both FROM coalesce(o.work_order_name, '')) = trim(both FROM coalesce(p_work_order_name, ''));

  v_pack := COALESCE(array_length(v_bill_ids, 1), 0);
  v_qty := jsonb_set(v_qty, '{PACK}', to_jsonb(v_pack));

  IF v_bill_ids IS NULL OR v_pack = 0 THEN
    RETURN v_qty;
  END IF;

  FOR r IN
    SELECT oi.product_id
    FROM or_order_items oi
    WHERE oi.order_id = ANY (v_bill_ids)
      AND oi.product_id IS NOT NULL
  LOOP
    SELECT upper(trim(coalesce(product_category, ''))) INTO v_cat
    FROM pr_products WHERE id = r.product_id;

    IF v_cat IS NULL THEN CONTINUE; END IF;

    IF v_cat LIKE '%STAMP%' THEN
      v_qty := jsonb_set(v_qty, '{STAMP}', to_jsonb((v_qty->>'STAMP')::int + 1));
    END IF;
    IF v_cat LIKE '%STK%' THEN
      v_qty := jsonb_set(v_qty, '{STK}', to_jsonb((v_qty->>'STK')::int + 1));
    END IF;
    IF v_cat LIKE '%UV%' OR v_cat LIKE '%SUBLIMATION%' THEN
      v_qty := jsonb_set(v_qty, '{CTT}', to_jsonb((v_qty->>'CTT')::int + 1));
    END IF;
    IF v_cat LIKE '%LASER%' THEN
      v_qty := jsonb_set(v_qty, '{LASER}', to_jsonb((v_qty->>'LASER')::int + 1));
    END IF;
    IF v_cat LIKE '%TUBE%' THEN
      v_qty := jsonb_set(v_qty, '{TUBE}', to_jsonb((v_qty->>'TUBE')::int + 1));
    END IF;
    IF v_cat IN ('CALENDAR', 'ETC', 'INK') THEN
      v_qty := jsonb_set(v_qty, '{ETC}', to_jsonb((v_qty->>'ETC')::int + 1));
    END IF;
  END LOOP;

  RETURN v_qty;
END;
$$;

-- ─── Trigger: คืนสต๊อกเมื่อ status = returned ────────────────────────────────
CREATE OR REPLACE FUNCTION inv_deduct_stock_on_wms_picked()
RETURNS TRIGGER AS $$
DECLARE
  v_product_id    UUID;
  v_movement_id   UUID;
  v_unit_mult     NUMERIC := 1;
  v_actual_qty    NUMERIC;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;

  SELECT id, COALESCE(unit_multiplier, 1)
  INTO v_product_id, v_unit_mult
  FROM pr_products
  WHERE product_code = NEW.product_code
  LIMIT 1;

  IF v_product_id IS NULL THEN RETURN NEW; END IF;

  v_actual_qty := NEW.qty * v_unit_mult;

  -- Reserve: status → picked
  IF NEW.status = 'picked'
     AND (OLD.status IS NULL OR OLD.status NOT IN ('picked', 'correct'))
  THEN
    UPDATE inv_stock_balances
      SET reserved = COALESCE(reserved, 0) + v_actual_qty
      WHERE product_id = v_product_id;
    IF NOT FOUND THEN
      INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES (v_product_id, 0, v_actual_qty, 0);
    END IF;
  END IF;

  -- Deduct: status → correct
  IF NEW.status = 'correct'
     AND (OLD.status IS NULL OR OLD.status <> 'correct')
  THEN
    UPDATE inv_stock_balances
      SET on_hand  = COALESCE(on_hand, 0) - v_actual_qty,
          reserved = GREATEST(COALESCE(reserved, 0) - v_actual_qty, 0)
      WHERE product_id = v_product_id;
    IF NOT FOUND THEN
      INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES (v_product_id, -v_actual_qty, 0, 0);
    END IF;

    INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note)
    VALUES (v_product_id, 'pick', -v_actual_qty, 'wms_orders', NEW.id, 'ตัดสต๊อคเมื่อตรวจสอบถูกต้อง')
    RETURNING id INTO v_movement_id;

    PERFORM fn_consume_stock_fifo(v_product_id, v_actual_qty, v_movement_id);
    PERFORM fn_recalc_product_landed_cost(v_product_id);
  END IF;

  -- Out of stock: ปลด reserve
  IF NEW.status = 'out_of_stock'
     AND OLD.status = 'picked'
  THEN
    UPDATE inv_stock_balances
      SET reserved = GREATEST(COALESCE(reserved, 0) - v_actual_qty, 0)
      WHERE product_id = v_product_id;
  END IF;

  -- คืนเข้าคลัง (released): ปลด reserve หรือ reverse FIFO
  IF NEW.status = 'returned' AND OLD.status IS DISTINCT FROM 'returned' THEN
    IF OLD.status = 'picked' THEN
      UPDATE inv_stock_balances
        SET reserved = GREATEST(COALESCE(reserved, 0) - v_actual_qty, 0)
        WHERE product_id = v_product_id;
    ELSIF OLD.status = 'correct' THEN
      PERFORM fn_reverse_wms_stock(NEW.id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── fn_wms_try_auto_consume_non_pick — แถวต่อบิล + source_order_id ─────────
CREATE OR REPLACE FUNCTION fn_wms_try_auto_consume_non_pick(p_work_order_name TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nm TEXT;
  v_expected_count INT := 0;
  v_linked_count   INT := 0;
BEGIN
  v_nm := trim(both FROM coalesce(p_work_order_name, ''));
  IF v_nm = '' THEN
    RETURN;
  END IF;

  SELECT COALESCE(wo.order_count, 0)
  INTO v_expected_count
  FROM or_work_orders wo
  WHERE trim(both FROM coalesce(wo.work_order_name, '')) = v_nm
    AND wo.status = 'กำลังผลิต'
  LIMIT 1;

  IF COALESCE(v_expected_count, 0) <= 0 THEN
    RETURN;
  END IF;

  SELECT COUNT(*)
  INTO v_linked_count
  FROM or_orders o
  WHERE trim(both FROM coalesce(o.work_order_name, '')) = v_nm;

  IF v_linked_count < v_expected_count THEN
    RETURN;
  END IF;

  UPDATE wms_orders
  SET status = 'correct'
  WHERE trim(both FROM coalesce(order_id, '')) = v_nm
    AND fulfillment_mode = 'system_complete'
    AND status = 'pending';

  IF FOUND THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM wms_orders w
    WHERE trim(both FROM coalesce(w.order_id, '')) = v_nm
      AND w.status <> 'cancelled'
  ) THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM or_orders o
    JOIN or_order_items oi ON oi.order_id = o.id
    JOIN pr_products p ON p.id = oi.product_id
    WHERE trim(both FROM coalesce(o.work_order_name, '')) = v_nm
      AND fn_wms_is_pickable_category(p.product_category::text)
  ) THEN
    RETURN;
  END IF;

  WITH base_np AS (
    SELECT
      o.id AS ord_id,
      oi.id AS ord_item_id,
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
    WHERE trim(both FROM coalesce(o.work_order_name, '')) = v_nm
      AND NOT fn_wms_is_pickable_category(p.product_category::text)
      AND oi.product_id IS NOT NULL
      AND p.product_code IS NOT NULL
      AND trim(p.product_code::text) <> ''
    GROUP BY o.id, oi.id, oi.product_id
  ),
  ins AS (
    INSERT INTO wms_orders (
      order_id, product_code, product_name, location, qty, unit_name,
      assigned_to, status, fulfillment_mode, source_order_id, source_order_item_id
    )
    SELECT
      v_nm,
      trim(product_code),
      product_name,
      coalesce(loc, ''),
      CASE
        WHEN upper(coalesce(cat, '')) LIKE '%CONDO STAMP%'
          THEN ceil(sum_q / 5)::int
        ELSE sum_q::int
      END,
      unit_name,
      NULL,
      'pending',
      'system_complete',
      ord_id,
      ord_item_id
    FROM base_np
    RETURNING id
  )
  UPDATE wms_orders w
  SET status = 'correct'
  FROM ins
  WHERE w.id = ins.id;
END;
$$;

-- ─── rpc_assign_wms_for_work_order — แถวต่อบิล ─────────────────────────────
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
  v_wo             TEXT;
BEGIN
  v_wo := trim(both FROM coalesce(p_work_order_name, ''));

  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN (
    'superadmin', 'admin', 'store', 'manager', 'production'
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์มอบหมาย WMS (ต้องเป็น superadmin / admin / store / manager / production)';
  END IF;

  IF v_wo = '' THEN
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
  WHERE trim(both FROM coalesce(order_id, '')) = v_wo
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
    WHERE o.work_order_name = v_wo
  ) INTO v_has_items;

  IF NOT v_has_items THEN
    RETURN jsonb_build_object('success', false, 'error', 'ไม่พบรายการสินค้าในใบงานนี้');
  END IF;

  WITH base AS (
    SELECT
      o.id AS ord_id,
      oi.id AS ord_item_id,
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
    WHERE o.work_order_name = v_wo
      AND fn_wms_is_pickable_category(p.product_category::text)
    GROUP BY o.id, oi.id, oi.product_id
  )
  INSERT INTO wms_orders (
    order_id, product_code, product_name, location, qty, unit_name,
    assigned_to, status, fulfillment_mode, source_order_id, source_order_item_id
  )
  SELECT
    v_wo,
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
    'warehouse_pick',
    ord_id,
    ord_item_id
  FROM base;

  GET DIAGNOSTICS v_pick_norm = ROW_COUNT;

  WITH spare_src AS (
    SELECT
      o.id AS ord_id,
      p.rubber_code AS rc,
      sum(coalesce(oi.quantity, 1)::numeric) AS spare_qty
    FROM or_orders o
    JOIN or_order_items oi ON oi.order_id = o.id
    JOIN pr_products p ON p.id = oi.product_id
    WHERE o.work_order_name = v_wo
      AND p.rubber_code IS NOT NULL
      AND trim(p.rubber_code::text) <> ''
      AND fn_wms_is_pickable_category(p.product_category::text)
    GROUP BY o.id, p.rubber_code
  )
  INSERT INTO wms_orders (
    order_id, product_code, product_name, location, qty, unit_name,
    assigned_to, status, fulfillment_mode, source_order_id
  )
  SELECT
    v_wo,
    'SPARE_PART',
    'หน้ายาง+โฟม ' || rc,
    'อะไหล่',
    spare_qty::int,
    'ชิ้น',
    p_picker_id,
    'pending',
    'warehouse_pick',
    ord_id
  FROM spare_src;

  GET DIAGNOSTICS v_pick_spare = ROW_COUNT;

  WITH base_np AS (
    SELECT
      o.id AS ord_id,
      oi.id AS ord_item_id,
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
    WHERE o.work_order_name = v_wo
      AND NOT fn_wms_is_pickable_category(p.product_category::text)
      AND oi.product_id IS NOT NULL
      AND p.product_code IS NOT NULL
      AND trim(p.product_code::text) <> ''
    GROUP BY o.id, oi.id, oi.product_id
  ),
  ins AS (
    INSERT INTO wms_orders (
      order_id, product_code, product_name, location, qty, unit_name,
      assigned_to, status, fulfillment_mode, source_order_id, source_order_item_id
    )
    SELECT
      v_wo,
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
      'system_complete',
      ord_id,
      ord_item_id
    FROM base_np
    RETURNING id
  )
  UPDATE wms_orders w
  SET status = 'correct'
  FROM ins
  WHERE w.id = ins.id;

  GET DIAGNOSTICS v_system = ROW_COUNT;

  IF (coalesce(v_pick_norm, 0) + coalesce(v_pick_spare, 0) + coalesce(v_system, 0)) = 0 THEN
    DELETE FROM wms_orders WHERE trim(both FROM coalesce(order_id, '')) = v_wo;
    RETURN jsonb_build_object(
      'success', false,
      'error',
      'ไม่มีรายการที่สร้าง WMS ได้ (ตรวจสอบ product_id / รหัสสินค้า)'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'work_order_name', v_wo,
    'warehouse_pick_main', coalesce(v_pick_norm, 0),
    'warehouse_pick_spare', coalesce(v_pick_spare, 0),
    'system_complete', coalesce(v_system, 0)
  );
END;
$$;

-- ─── ย้ายบิลไปคิวใบสั่งงาน (Plan → จัดการใบงาน) ─────────────────────────────
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
  v_block    BOOLEAN;
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

  SELECT EXISTS (
    SELECT 1
    FROM wms_orders w
    WHERE trim(both FROM coalesce(w.order_id, '')) = v_wo
      AND w.source_order_id = ANY (p_order_ids)
      AND w.status IN ('picked', 'correct')
  ) INTO v_block;

  IF v_block THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'wms_active',
      'error', 'บิลนี้มีการจัดสินค้าแล้ว หากต้องการเปลี่ยนแปลงให้ยกเลิกบิล'
    );
  END IF;

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
    DELETE FROM wms_orders WHERE trim(both FROM coalesce(order_id, '')) = v_wo;
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

REVOKE ALL ON FUNCTION fn_plan_qty_json_for_work_order(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION rpc_plan_release_orders_to_workqueue(TEXT, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_plan_release_orders_to_workqueue(TEXT, UUID[]) TO authenticated;

COMMENT ON FUNCTION rpc_plan_release_orders_to_workqueue IS
  'ย้ายบิลกลับคิว Plan→ใบสั่งงาน: ลบแถว WMS pending, อัปเดต or_orders + plan_jobs.qty';

