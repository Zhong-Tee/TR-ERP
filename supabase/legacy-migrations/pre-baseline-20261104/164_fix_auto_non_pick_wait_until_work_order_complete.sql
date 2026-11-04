-- 164: Auto non-pick consume should wait until work order linkage is complete
-- Prevent partial auto-consume when only some orders have been linked to the work order.

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

  -- Wait until all expected orders are linked to this work order.
  IF v_linked_count < v_expected_count THEN
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
