BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_get_sub_warehouse_other_wms_details(
  p_sub_warehouse_id UUID,
  p_product_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
) RETURNS TABLE(
  wms_order_id UUID,
  order_reference TEXT,
  product_code TEXT,
  product_name TEXT,
  qty NUMERIC,
  unit_name TEXT,
  used_at TIMESTAMPTZ,
  fulfillment_mode TEXT,
  picker_name TEXT,
  classification_reason TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH groups_scope AS (
    SELECT g.id
    FROM public.wh_sub_wms_map_groups g
    WHERE g.sub_warehouse_id IS NULL
       OR g.sub_warehouse_id = p_sub_warehouse_id
  ), matched_groups AS (
    SELECT DISTINCT sp.group_id
    FROM public.wh_sub_wms_map_spares sp
    JOIN groups_scope gs ON gs.id = sp.group_id
    WHERE sp.product_id = p_product_id
  ), target_codes AS (
    SELECT p.product_code::TEXT AS product_code
    FROM public.wh_sub_wms_map_sources src
    JOIN matched_groups mg ON mg.group_id = src.group_id
    JOIN public.pr_products p ON p.id = src.product_id
    UNION ALL
    SELECT p.product_code::TEXT
    FROM public.pr_products p
    WHERE p.id = p_product_id
      AND NOT EXISTS (SELECT 1 FROM matched_groups)
  ), usage AS (
    SELECT
      w.id,
      w.order_id,
      w.product_code,
      w.product_name,
      COALESCE(w.qty, 0)::NUMERIC AS qty,
      w.unit_name,
      COALESCE(
        s.checked_at,
        CASE
          WHEN w.fulfillment_mode IN ('system_complete', 'sub_warehouse_skip') THEN w.end_time
        END
      ) AS used_at,
      w.fulfillment_mode,
      picker.username::TEXT AS picker_name,
      r.id AS requisition_id,
      w.work_order_id,
      EXISTS (
        SELECT 1
        FROM public.or_orders o
        WHERE BTRIM(COALESCE(o.work_order_name, '')) = BTRIM(COALESCE(w.order_id, ''))
      ) AS has_work_order
    FROM public.wms_orders w
    JOIN target_codes tc ON tc.product_code = w.product_code::TEXT
    LEFT JOIN public.wms_requisitions r ON r.requisition_id = w.order_id
    LEFT JOIN public.us_users picker ON picker.id = w.assigned_to
    LEFT JOIN LATERAL (
      SELECT ws.checked_at
      FROM public.wms_order_summaries ws
      WHERE ws.order_id = w.order_id
      ORDER BY ws.checked_at
      LIMIT 1
    ) s ON TRUE
    WHERE auth.uid() IS NOT NULL
      AND w.status = 'correct'
  )
  SELECT
    u.id,
    u.order_id,
    u.product_code,
    u.product_name,
    u.qty,
    u.unit_name,
    u.used_at,
    u.fulfillment_mode,
    u.picker_name,
    CASE
      WHEN NULLIF(BTRIM(COALESCE(u.order_id, '')), '') IS NULL
        THEN 'ไม่มีเลขอ้างอิง WMS'
      ELSE 'ไม่พบใบงานหรือใบเบิกที่ตรงกับเลขอ้างอิง'
    END
  FROM usage u
  WHERE u.used_at >= p_from
    AND u.used_at <= p_to
    AND u.requisition_id IS NULL
    AND UPPER(BTRIM(COALESCE(u.order_id, ''))) NOT LIKE 'REQ-%'
    AND u.work_order_id IS NULL
    AND NOT u.has_work_order
  ORDER BY u.used_at DESC, u.order_id, u.product_code;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_sub_warehouse_other_wms_details(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

COMMIT;
