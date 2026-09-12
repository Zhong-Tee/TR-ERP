BEGIN;

-- Keep the existing balance RPC untouched. This companion RPC exposes where
-- each WMS deduction came from and classifies historical rows from both the
-- requisition table and the legacy REQ-* reference format.
CREATE OR REPLACE FUNCTION public.rpc_get_wms_usage_breakdown_by_product(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
) RETURNS TABLE(
  product_code TEXT,
  correct_qty NUMERIC,
  work_order_qty NUMERIC,
  requisition_qty NUMERIC,
  other_qty NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH usage AS (
    SELECT
      w.product_code,
      COALESCE(w.qty, 0)::NUMERIC AS qty,
      COALESCE(
        s.checked_at,
        CASE
          WHEN w.fulfillment_mode IN ('system_complete', 'sub_warehouse_skip') THEN w.end_time
        END
      ) AS used_at,
      CASE
        WHEN r.id IS NOT NULL OR UPPER(BTRIM(COALESCE(w.order_id, ''))) LIKE 'REQ-%'
          THEN 'requisition'
        WHEN w.work_order_id IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM public.or_orders o
            WHERE BTRIM(COALESCE(o.work_order_name, '')) = BTRIM(COALESCE(w.order_id, ''))
          )
          THEN 'work_order'
        ELSE 'other'
      END AS usage_source
    FROM public.wms_orders w
    LEFT JOIN public.wms_requisitions r
      ON r.requisition_id = w.order_id
    LEFT JOIN LATERAL (
      SELECT ws.checked_at
      FROM public.wms_order_summaries ws
      WHERE ws.order_id = w.order_id
      ORDER BY ws.checked_at
      LIMIT 1
    ) s ON TRUE
    WHERE w.status = 'correct'
  )
  SELECT
    u.product_code,
    COALESCE(SUM(u.qty), 0)::NUMERIC AS correct_qty,
    COALESCE(SUM(u.qty) FILTER (WHERE u.usage_source = 'work_order'), 0)::NUMERIC AS work_order_qty,
    COALESCE(SUM(u.qty) FILTER (WHERE u.usage_source = 'requisition'), 0)::NUMERIC AS requisition_qty,
    COALESCE(SUM(u.qty) FILTER (WHERE u.usage_source = 'other'), 0)::NUMERIC AS other_qty
  FROM usage u
  WHERE u.used_at >= p_from
    AND u.used_at <= p_to
  GROUP BY u.product_code
  ORDER BY u.product_code;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_wms_usage_breakdown_by_product(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_wms_usage_breakdown_by_product(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

COMMIT;
