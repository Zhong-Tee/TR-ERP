-- Prevent Packing from starting/shipping before Picker + warehouse review are
-- complete, expose per-bill readiness, and detect work orders with no WMS rows.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_wms_order_ready_for_packing(p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.or_order_items oi
    JOIN public.pr_products p ON p.id=oi.product_id
    WHERE oi.order_id=p_order_id
      AND NOT COALESCE(oi.is_detail_row,false)
      AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action,'')),'') IS NULL
      AND public.fn_wms_item_fulfillment_mode(p.id,p.product_category::TEXT)='warehouse_pick'
      AND COALESCE((
        SELECT SUM(w.qty)
        FROM public.wms_orders w
        WHERE w.source_order_item_id=oi.id
          AND w.fulfillment_mode='warehouse_pick'
          AND w.status='correct'
      ),0) < COALESCE(oi.quantity,1)::NUMERIC
  );
$$;

REVOKE ALL ON FUNCTION public.fn_wms_order_ready_for_packing(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wms_order_ready_for_packing(UUID) TO authenticated,service_role;

COMMENT ON FUNCTION public.fn_wms_order_ready_for_packing(UUID) IS
  'True when every active order line requiring the main Picker has WMS status correct for the full quantity.';

CREATE OR REPLACE FUNCTION public.rpc_get_packing_wms_readiness(p_work_order_id UUID)
RETURNS TABLE(
  order_id UUID,
  picker_required_qty NUMERIC,
  picker_correct_qty NUMERIC,
  picker_missing_qty NUMERIC,
  ready BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH picker_items AS (
    SELECT o.id AS order_id,oi.id AS order_item_id,COALESCE(oi.quantity,1)::NUMERIC AS expected_qty
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id=o.id
    JOIN public.pr_products p ON p.id=oi.product_id
    WHERE o.work_order_id=p_work_order_id
      AND o.status<>'ยกเลิก'
      AND NOT COALESCE(oi.is_detail_row,false)
      AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action,'')),'') IS NULL
      AND public.fn_wms_item_fulfillment_mode(p.id,p.product_category::TEXT)='warehouse_pick'
  ), per_item AS (
    SELECT pi.order_id,pi.order_item_id,pi.expected_qty,
      COALESCE(SUM(w.qty) FILTER (WHERE w.fulfillment_mode='warehouse_pick' AND w.status='correct'),0)::NUMERIC AS correct_qty
    FROM picker_items pi
    LEFT JOIN public.wms_orders w ON w.source_order_item_id=pi.order_item_id
    GROUP BY pi.order_id,pi.order_item_id,pi.expected_qty
  ), per_order AS (
    SELECT order_id,SUM(expected_qty)::NUMERIC AS required_qty,
      SUM(LEAST(correct_qty,expected_qty))::NUMERIC AS correct_qty,
      SUM(GREATEST(expected_qty-correct_qty,0))::NUMERIC AS missing_qty
    FROM per_item GROUP BY order_id
  )
  SELECT o.id,COALESCE(po.required_qty,0),COALESCE(po.correct_qty,0),COALESCE(po.missing_qty,0),
    COALESCE(po.missing_qty,0)=0
  FROM public.or_orders o
  LEFT JOIN per_order po ON po.order_id=o.id
  WHERE o.work_order_id=p_work_order_id AND o.status<>'ยกเลิก'
  ORDER BY o.bill_no,o.id;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_packing_wms_readiness(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_packing_wms_readiness(UUID) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.rpc_get_packing_wms_item_readiness(p_work_order_id UUID)
RETURNS TABLE(
  order_item_id UUID,
  order_id UUID,
  picker_required BOOLEAN,
  picker_correct_qty NUMERIC,
  expected_qty NUMERIC,
  ready BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH active_items AS (
    SELECT oi.id AS order_item_id,o.id AS order_id,
      COALESCE(oi.quantity,1)::NUMERIC AS expected_qty,
      CASE
        WHEN p.id IS NULL THEN FALSE
        ELSE public.fn_wms_item_fulfillment_mode(p.id,p.product_category::TEXT)='warehouse_pick'
      END AS picker_required
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id=o.id
    LEFT JOIN public.pr_products p ON p.id=oi.product_id
    WHERE o.work_order_id=p_work_order_id
      AND o.status<>'ยกเลิก'
      AND NOT COALESCE(oi.is_detail_row,false)
      AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action,'')),'') IS NULL
  ), per_item AS (
    SELECT ai.order_item_id,ai.order_id,ai.picker_required,ai.expected_qty,
      COALESCE(SUM(w.qty) FILTER (
        WHERE w.fulfillment_mode='warehouse_pick' AND w.status='correct'
      ),0)::NUMERIC AS correct_qty
    FROM active_items ai
    LEFT JOIN public.wms_orders w ON w.source_order_item_id=ai.order_item_id
    GROUP BY ai.order_item_id,ai.order_id,ai.picker_required,ai.expected_qty
  )
  SELECT pi.order_item_id,pi.order_id,pi.picker_required,pi.correct_qty,pi.expected_qty,
    (NOT pi.picker_required OR pi.correct_qty>=pi.expected_qty) AS ready
  FROM per_item pi
  ORDER BY pi.order_id,pi.order_item_id;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_packing_wms_item_readiness(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_packing_wms_item_readiness(UUID) TO authenticated,service_role;

COMMENT ON FUNCTION public.rpc_get_packing_wms_item_readiness(UUID) IS
  'Returns WMS readiness per active product line for the Packing item-level badge.';

CREATE OR REPLACE FUNCTION public.tr_guard_shipping_until_wms_ready()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.status='จัดส่งแล้ว'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.work_order_id IS NOT NULL
     AND NOT public.fn_wms_order_ready_for_packing(NEW.id) THEN
    RAISE EXCEPTION 'จัดส่งไม่ได้: บิล % ยังไม่ได้หยิบและตรวจสินค้าใน WMS ครบ',
      COALESCE(NULLIF(BTRIM(NEW.bill_no),''),NEW.id::TEXT);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_shipping_until_wms_ready ON public.or_orders;
CREATE TRIGGER guard_shipping_until_wms_ready
BEFORE UPDATE OF status ON public.or_orders
FOR EACH ROW EXECUTE FUNCTION public.tr_guard_shipping_until_wms_ready();

COMMENT ON FUNCTION public.tr_guard_shipping_until_wms_ready() IS
  'Blocks every shipping path, including direct updates, while Picker-required order lines are not WMS correct.';

-- The previous version required at least one WMS row in the work order. That
-- hid the most severe case: a shipped Picker work order with zero WMS rows.
CREATE OR REPLACE FUNCTION public.rpc_get_wms_stock_anomalies(p_from_date DATE,p_to_date DATE)
RETURNS TABLE(
  order_item_id UUID, order_id UUID, bill_no TEXT, entry_date DATE, work_order_id UUID,
  work_order_name TEXT, product_code TEXT, product_name TEXT, unit_name TEXT,
  expected_qty NUMERIC, wms_qty NUMERIC, correct_qty NUMERIC, deducted_qty NUMERIC,
  anomaly_type TEXT, repairable BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH base AS (
    SELECT oi.id order_item_id,o.id order_id,o.bill_no,o.entry_date,o.work_order_id,o.work_order_name,
      p.product_code::TEXT,oi.product_name,COALESCE(NULLIF(BTRIM(p.unit_name::TEXT),''),'ชิ้น') unit_name,
      COALESCE(oi.quantity,1)::NUMERIC expected_qty
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id=o.id
    JOIN public.pr_products p ON p.id=oi.product_id
    WHERE o.entry_date BETWEEN p_from_date AND p_to_date
      AND EXISTS (SELECT 1 FROM public.us_users au WHERE au.id=auth.uid()
        AND au.role IN ('superadmin','admin','store','manager'))
      AND o.status='จัดส่งแล้ว' AND NOT COALESCE(oi.is_detail_row,false)
      AND COALESCE(oi.cancellation_stock_action,'')<>'recalled'
      AND o.work_order_id IS NOT NULL
  ), wms_agg AS (
    SELECT w.source_order_item_id,
      SUM(w.qty) FILTER (WHERE w.status<>'cancelled') wms_qty,
      SUM(w.qty) FILTER (WHERE w.status='correct') correct_qty
    FROM public.wms_orders w WHERE w.source_order_item_id IS NOT NULL
    GROUP BY w.source_order_item_id
  ), movement_agg AS (
    SELECT w.source_order_item_id,
      SUM(-m.qty) FILTER (WHERE m.movement_type IN ('pick','pick_reversal')) stock_qty
    FROM public.wms_orders w
    JOIN public.inv_stock_movements m ON m.ref_type='wms_orders' AND m.ref_id=w.id
    WHERE w.source_order_item_id IS NOT NULL
    GROUP BY w.source_order_item_id
  ), agg AS (
    SELECT b.*,COALESCE(w.wms_qty,0) wms_qty,COALESCE(w.correct_qty,0) correct_qty,
      COALESCE(m.stock_qty,0) deducted_qty,
      public.fn_wms_item_has_legacy_stock_conflict(b.order_item_id) legacy_conflict
    FROM base b
    LEFT JOIN wms_agg w ON w.source_order_item_id=b.order_item_id
    LEFT JOIN movement_agg m ON m.source_order_item_id=b.order_item_id
  )
  SELECT a.order_item_id,a.order_id,a.bill_no,a.entry_date,a.work_order_id,a.work_order_name,
    a.product_code,a.product_name,a.unit_name,a.expected_qty,a.wms_qty,a.correct_qty,a.deducted_qty,
    CASE WHEN a.legacy_conflict THEN 'legacy_conflict'
         WHEN a.wms_qty<a.expected_qty THEN 'missing_wms'
         WHEN a.wms_qty>a.expected_qty THEN 'excess_wms'
         WHEN a.correct_qty<>a.expected_qty THEN 'not_correct'
         WHEN a.correct_qty<>a.deducted_qty THEN 'stock_movement_mismatch'
         ELSE 'unknown' END,
    (a.wms_qty<a.expected_qty AND NOT a.legacy_conflict)
  FROM agg a
  WHERE a.wms_qty<>a.expected_qty OR a.correct_qty<>a.expected_qty
    OR a.correct_qty<>a.deducted_qty OR a.legacy_conflict
  ORDER BY a.entry_date DESC,a.bill_no,a.product_code;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_wms_stock_anomalies(DATE,DATE) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_wms_stock_anomalies(DATE,DATE) TO authenticated,service_role;

COMMIT;
