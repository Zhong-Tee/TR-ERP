-- Read summaries only. Existing table RLS and legacy counting semantics remain in force.
BEGIN;
CREATE OR REPLACE FUNCTION public.rpc_plan_work_order_metrics(p_work_order_ids uuid[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  WITH requested AS (
    SELECT DISTINCT id FROM unnest(p_work_order_ids) AS ids(id) WHERE id IS NOT NULL
  ), orders AS MATERIALIZED (
    SELECT o.id, o.work_order_id, o.status FROM public.or_orders o
    JOIN requested r ON r.id = o.work_order_id
  ), bills AS (
    SELECT work_order_id, count(*) AS bill_count FROM orders
    WHERE status <> 'ยกเลิก' GROUP BY work_order_id
  ), categories AS (
    -- Match the existing category loader: all orders and item rows, including
    -- cancelled/detail rows; positive finite quantities, otherwise one unit.
    SELECT o.work_order_id,
      btrim(p.product_category::text, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') AS category,
      sum(CASE WHEN i.quantity > 0 AND i.quantity::text NOT IN ('NaN','Infinity','-Infinity')
        THEN i.quantity ELSE 1 END) AS qty
    FROM orders o JOIN public.or_order_items i ON i.order_id = o.id
    JOIN public.v_cost_safe_pr_products p ON p.id = i.product_id
    WHERE i.product_id IS NOT NULL
    GROUP BY o.work_order_id, category
  ), quantities AS (
    SELECT work_order_id, jsonb_object_agg(category, qty) AS category_qty
    FROM categories WHERE category <> '' AND category IS NOT NULL GROUP BY work_order_id
  )
  SELECT coalesce(jsonb_object_agg(r.id::text, jsonb_build_object(
    'bill_count', coalesce(b.bill_count, 0), 'category_qty', coalesce(q.category_qty, '{}'::jsonb)
  )), '{}'::jsonb)
  FROM requested r LEFT JOIN bills b ON b.work_order_id = r.id
  LEFT JOIN quantities q ON q.work_order_id = r.id;
$$;

CREATE OR REPLACE FUNCTION public.rpc_wms_assigned_names(p_work_order_names text[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  WITH requested AS (
    SELECT DISTINCT name FROM unnest(p_work_order_names) names(name) WHERE name IS NOT NULL
  ), headers AS MATERIALIZED (
    SELECT id, btrim(work_order_name) AS name FROM public.or_work_orders
    WHERE btrim(work_order_name) IN (SELECT name FROM requested)
  ), candidates AS MATERIALIZED (
    SELECT w.work_order_id, btrim(w.order_id) AS legacy_name FROM public.wms_orders w
    WHERE (w.fulfillment_mode = 'warehouse_pick' OR w.fulfillment_mode IS NULL)
      AND w.status <> 'cancelled'
      AND (btrim(w.order_id) IN (SELECT name FROM requested)
        OR w.work_order_id IN (SELECT id FROM headers))
  ), assigned AS (
    SELECT legacy_name AS name FROM candidates
    UNION
    SELECT h.name FROM candidates c JOIN headers h ON h.id = c.work_order_id
  )
  SELECT coalesce(jsonb_agg(name ORDER BY name), '[]'::jsonb)
  FROM requested WHERE name IN (SELECT name FROM assigned);
$$;

REVOKE ALL ON FUNCTION public.rpc_plan_work_order_metrics(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_wms_assigned_names(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_plan_work_order_metrics(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_wms_assigned_names(text[]) TO authenticated;
COMMIT;
