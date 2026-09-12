-- ═══════════════════════════════════════════════════════════════════════════
-- 161: ตัดสต๊อกอัตโนมัติเมื่อใบงานมีเฉพาะสินค้า "ไม่ต้องหยิบ" (ไม่มี Picker)
-- ลอจิก base_np / INSERT+UPDATE correct เดียวกับ rpc_assign_wms_for_work_order แต่ assigned_to NULL
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_wms_try_auto_consume_non_pick(p_work_order_name TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nm TEXT;
BEGIN
  v_nm := trim(both FROM coalesce(p_work_order_name, ''));
  IF v_nm = '' THEN
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

  IF NOT EXISTS (
    SELECT 1
    FROM or_work_orders wo
    WHERE trim(both FROM coalesce(wo.work_order_name, '')) = v_nm
      AND wo.status = 'กำลังผลิต'
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
      'system_complete'
    FROM base_np
    RETURNING id
  )
  UPDATE wms_orders w
  SET status = 'correct'
  FROM ins
  WHERE w.id = ins.id;
END;
$$;

REVOKE ALL ON FUNCTION fn_wms_try_auto_consume_non_pick(TEXT) FROM PUBLIC;

COMMENT ON FUNCTION fn_wms_try_auto_consume_non_pick IS
  'ใบกำลังผลิต, ยังไม่มี WMS, ไม่มีหมวดหยิบ — สร้าง system_complete แล้ว correct ให้ trigger ตัดสต๊อก';

CREATE OR REPLACE FUNCTION trg_or_work_orders_try_auto_non_pick()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.work_order_name IS NULL OR trim(both FROM NEW.work_order_name) = '' THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'กำลังผลิต' THEN
    PERFORM fn_wms_try_auto_consume_non_pick(NEW.work_order_name);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_or_work_orders_try_auto_non_pick ON or_work_orders;
CREATE TRIGGER trg_or_work_orders_try_auto_non_pick
  AFTER INSERT OR UPDATE OF status, work_order_name
  ON or_work_orders
  FOR EACH ROW
  EXECUTE FUNCTION trg_or_work_orders_try_auto_non_pick();

CREATE OR REPLACE FUNCTION trg_or_orders_try_auto_non_pick()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nm TEXT;
BEGIN
  v_nm := trim(both FROM coalesce(NEW.work_order_name, ''));
  IF v_nm = '' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND trim(both FROM coalesce(OLD.work_order_name, '')) IS NOT DISTINCT FROM v_nm THEN
    RETURN NEW;
  END IF;
  PERFORM fn_wms_try_auto_consume_non_pick(v_nm);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_or_orders_try_auto_non_pick ON or_orders;
CREATE TRIGGER trg_or_orders_try_auto_non_pick
  AFTER INSERT OR UPDATE OF work_order_name
  ON or_orders
  FOR EACH ROW
  EXECUTE FUNCTION trg_or_orders_try_auto_non_pick();

CREATE OR REPLACE FUNCTION trg_or_order_items_try_auto_non_pick()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nm TEXT;
BEGIN
  SELECT trim(both FROM coalesce(o.work_order_name, ''))
  INTO v_nm
  FROM or_orders o
  WHERE o.id = NEW.order_id
  LIMIT 1;

  IF v_nm = '' THEN
    RETURN NEW;
  END IF;

  PERFORM fn_wms_try_auto_consume_non_pick(v_nm);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_or_order_items_try_auto_non_pick ON or_order_items;
CREATE TRIGGER trg_or_order_items_try_auto_non_pick
  AFTER INSERT OR UPDATE OF product_id, quantity, is_free
  ON or_order_items
  FOR EACH ROW
  EXECUTE FUNCTION trg_or_order_items_try_auto_non_pick();
