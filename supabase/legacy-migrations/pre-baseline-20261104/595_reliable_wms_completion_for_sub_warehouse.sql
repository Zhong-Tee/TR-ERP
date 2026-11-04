-- Make sub-warehouse usage independent from the browser-only KPI summary.
--
-- wms_order_summaries is still the authoritative first-check KPI record, but
-- it can be absent when the final browser request fails.  Persist a separate
-- work-order completion timestamp in the database and use it only as the
-- reporting fallback.  This never creates or changes inventory movements.

BEGIN;

ALTER TABLE public.or_work_orders
  ADD COLUMN IF NOT EXISTS wms_review_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.or_work_orders.wms_review_completed_at IS
  'Database-stamped WMS review completion time; fallback for operational reports when the browser KPI summary is missing.';

CREATE OR REPLACE FUNCTION public.fn_stamp_wms_review_completed_at(
  p_work_order_id UUID
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total INTEGER := 0;
  v_incomplete INTEGER := 0;
  v_completed_at TIMESTAMPTZ;
BEGIN
  IF p_work_order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE w.status NOT IN ('correct', 'wrong', 'not_find', 'out_of_stock', 'returned')
    ),
    MAX(COALESCE(w.end_time, w.created_at))
  INTO v_total, v_incomplete, v_completed_at
  FROM public.wms_orders w
  WHERE w.work_order_id = p_work_order_id
    AND (w.fulfillment_mode = 'warehouse_pick' OR w.fulfillment_mode IS NULL)
    AND (
      w.status <> 'cancelled'
      OR (w.status = 'cancelled' AND w.stock_action = 'recalled')
    );

  IF v_total = 0 OR v_incomplete > 0 THEN
    RETURN NULL;
  END IF;

  v_completed_at := COALESCE(v_completed_at, NOW());

  UPDATE public.or_work_orders wo
  SET wms_review_completed_at = COALESCE(wo.wms_review_completed_at, v_completed_at)
  WHERE wo.id = p_work_order_id
  RETURNING wo.wms_review_completed_at INTO v_completed_at;

  RETURN v_completed_at;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_stamp_wms_review_completed_at(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.trg_stamp_wms_review_completed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.work_order_id IS NOT NULL THEN
    PERFORM public.fn_stamp_wms_review_completed_at(NEW.work_order_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_wms_review_completed_at ON public.wms_orders;
CREATE TRIGGER trg_stamp_wms_review_completed_at
AFTER UPDATE OF status, stock_action, end_time, fulfillment_mode
ON public.wms_orders
FOR EACH ROW
WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  OR OLD.stock_action IS DISTINCT FROM NEW.stock_action
  OR OLD.end_time IS DISTINCT FROM NEW.end_time
  OR OLD.fulfillment_mode IS DISTINCT FROM NEW.fulfillment_mode
)
EXECUTE FUNCTION public.trg_stamp_wms_review_completed_at();

-- Repair every already-completed work order, including SPTR-210969-R1.  The
-- function refuses incomplete reviews, so this is safe to run for all rows.
DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT DISTINCT w.work_order_id
    FROM public.wms_orders w
    WHERE w.work_order_id IS NOT NULL
  LOOP
    PERFORM public.fn_stamp_wms_review_completed_at(target.work_order_id);
  END LOOP;
END;
$$;

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
        summary.checked_at,
        completion.completed_at,
        CASE
          WHEN w.fulfillment_mode IN ('system_complete', 'sub_warehouse_skip') THEN w.end_time
        END
      ) AS used_at,
      CASE
        WHEN requisition.id IS NOT NULL OR UPPER(BTRIM(COALESCE(w.order_id, ''))) LIKE 'REQ-%'
          THEN 'requisition'
        WHEN w.work_order_id IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM public.or_orders sales_order
            WHERE BTRIM(COALESCE(sales_order.work_order_name, '')) = BTRIM(COALESCE(w.order_id, ''))
          ) THEN 'work_order'
        ELSE 'other'
      END AS usage_source
    FROM public.wms_orders w
    LEFT JOIN public.wms_requisitions requisition ON requisition.requisition_id = w.order_id
    LEFT JOIN LATERAL (
      SELECT ws.checked_at
      FROM public.wms_order_summaries ws
      WHERE BTRIM(ws.order_id) = BTRIM(w.order_id)
      ORDER BY ws.checked_at
      LIMIT 1
    ) summary ON TRUE
    LEFT JOIN LATERAL (
      SELECT wo.wms_review_completed_at AS completed_at
      FROM public.or_work_orders wo
      WHERE wo.id = w.work_order_id
         OR (w.work_order_id IS NULL AND BTRIM(wo.work_order_name) = BTRIM(w.order_id))
      ORDER BY (wo.id = w.work_order_id) DESC, wo.created_at DESC
      LIMIT 1
    ) completion ON TRUE
    WHERE w.status = 'correct'
  )
  SELECT
    usage.product_code,
    COALESCE(SUM(usage.qty), 0)::NUMERIC,
    COALESCE(SUM(usage.qty) FILTER (WHERE usage.usage_source = 'work_order'), 0)::NUMERIC,
    COALESCE(SUM(usage.qty) FILTER (WHERE usage.usage_source = 'requisition'), 0)::NUMERIC,
    COALESCE(SUM(usage.qty) FILTER (WHERE usage.usage_source = 'other'), 0)::NUMERIC
  FROM usage
  WHERE usage.used_at >= p_from AND usage.used_at <= p_to
  GROUP BY usage.product_code
  ORDER BY usage.product_code;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_wms_usage_breakdown_by_product(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_wms_usage_breakdown_by_product(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- Keep the legacy UI fallback consistent with the breakdown RPC.  Without
-- this replacement a transient failure of the primary RPC would hide the
-- same completed warehouse-pick rows again.
-- The historical function used a different OUT row type in some databases;
-- PostgreSQL requires dropping it before that signature can be replaced.
DROP FUNCTION IF EXISTS public.rpc_get_wms_correct_qty_by_product(TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.rpc_get_wms_correct_qty_by_product(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
) RETURNS TABLE(product_code TEXT, correct_qty NUMERIC)
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
        summary.checked_at,
        completion.completed_at,
        CASE
          WHEN w.fulfillment_mode IN ('system_complete', 'sub_warehouse_skip') THEN w.end_time
        END
      ) AS used_at
    FROM public.wms_orders w
    LEFT JOIN LATERAL (
      SELECT ws.checked_at
      FROM public.wms_order_summaries ws
      WHERE BTRIM(ws.order_id) = BTRIM(w.order_id)
      ORDER BY ws.checked_at
      LIMIT 1
    ) summary ON TRUE
    LEFT JOIN LATERAL (
      SELECT wo.wms_review_completed_at AS completed_at
      FROM public.or_work_orders wo
      WHERE wo.id = w.work_order_id
         OR (w.work_order_id IS NULL AND BTRIM(wo.work_order_name) = BTRIM(w.order_id))
      ORDER BY (wo.id = w.work_order_id) DESC, wo.created_at DESC
      LIMIT 1
    ) completion ON TRUE
    WHERE w.status = 'correct'
  )
  SELECT usage.product_code, COALESCE(SUM(usage.qty), 0)::NUMERIC
  FROM usage
  WHERE usage.used_at >= p_from AND usage.used_at <= p_to
  GROUP BY usage.product_code
  ORDER BY usage.product_code;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_wms_correct_qty_by_product(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_wms_correct_qty_by_product(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

CREATE OR REPLACE FUNCTION public.rpc_get_sub_warehouse_daily_stock_sheet(
  p_sub_warehouse_id UUID, p_date DATE
) RETURNS TABLE(
  product_id UUID, product_code TEXT, product_name TEXT, unit_name TEXT,
  received_opening NUMERIC, replenish_day NUMERIC, reduce_day NUMERIC,
  wms_opening NUMERIC, wms_day NUMERIC, balance_opening NUMERIC, balance_eod NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH bounds AS (
    SELECT
      make_timestamptz(EXTRACT(YEAR FROM p_date)::INT,EXTRACT(MONTH FROM p_date)::INT,
        EXTRACT(DAY FROM p_date)::INT,0,0,0,'Asia/Bangkok') AS day_start,
      make_timestamptz(EXTRACT(YEAR FROM p_date)::INT,EXTRACT(MONTH FROM p_date)::INT,
        EXTRACT(DAY FROM p_date)::INT,0,0,0,'Asia/Bangkok')+INTERVAL '1 day' AS day_end_excl
  ), groups_scope AS (
    SELECT map_group.id FROM public.wh_sub_wms_map_groups map_group
    WHERE map_group.sub_warehouse_id IS NULL OR map_group.sub_warehouse_id=p_sub_warehouse_id
  ), wms_usage AS (
    SELECT wms.product_code,wms.qty,
      COALESCE(
        summary.checked_at,
        completion.completed_at,
        CASE WHEN wms.fulfillment_mode IN ('system_complete','sub_warehouse_skip') THEN wms.end_time END
      ) AS used_at,
      CASE
        WHEN requisition.id IS NOT NULL OR UPPER(BTRIM(COALESCE(wms.order_id,''))) LIKE 'REQ-%' THEN 'requisition'
        WHEN wms.work_order_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM public.or_orders sales_order
          WHERE BTRIM(COALESCE(sales_order.work_order_name,''))=BTRIM(COALESCE(wms.order_id,''))
        ) THEN 'work_order'
        ELSE 'other'
      END AS usage_source
    FROM public.wms_orders wms
    LEFT JOIN public.wms_requisitions requisition ON requisition.requisition_id=wms.order_id
    LEFT JOIN LATERAL (
      SELECT wms_summary.checked_at FROM public.wms_order_summaries wms_summary
      WHERE BTRIM(wms_summary.order_id)=BTRIM(wms.order_id)
      ORDER BY wms_summary.checked_at LIMIT 1
    ) summary ON TRUE
    LEFT JOIN LATERAL (
      SELECT work_order.wms_review_completed_at AS completed_at
      FROM public.or_work_orders work_order
      WHERE work_order.id=wms.work_order_id
         OR (wms.work_order_id IS NULL AND BTRIM(work_order.work_order_name)=BTRIM(wms.order_id))
      ORDER BY (work_order.id=wms.work_order_id) DESC,work_order.created_at DESC
      LIMIT 1
    ) completion ON TRUE
    WHERE wms.status='correct'
  ), group_wms_open AS (
    SELECT source.group_id,COALESCE(SUM(usage.qty),0)::NUMERIC qty
    FROM public.wh_sub_wms_map_sources source
    JOIN groups_scope ON groups_scope.id=source.group_id
    JOIN public.pr_products product_source ON product_source.id=source.product_id
    JOIN wms_usage usage ON usage.product_code::TEXT=product_source.product_code::TEXT
    CROSS JOIN bounds
    WHERE usage.usage_source='work_order' AND usage.used_at<bounds.day_start
    GROUP BY source.group_id
  ), group_wms_day AS (
    SELECT source.group_id,COALESCE(SUM(usage.qty),0)::NUMERIC qty
    FROM public.wh_sub_wms_map_sources source
    JOIN groups_scope ON groups_scope.id=source.group_id
    JOIN public.pr_products product_source ON product_source.id=source.product_id
    JOIN wms_usage usage ON usage.product_code::TEXT=product_source.product_code::TEXT
    CROSS JOIN bounds
    WHERE usage.usage_source='work_order'
      AND usage.used_at>=bounds.day_start AND usage.used_at<bounds.day_end_excl
    GROUP BY source.group_id
  ), spare_group AS (
    SELECT spare.product_id,spare.group_id FROM public.wh_sub_wms_map_spares spare
    JOIN groups_scope ON groups_scope.id=spare.group_id
  ), products AS (
    SELECT assigned.product_id,product.product_code,product.product_name,product.unit_name
    FROM public.wh_sub_warehouse_products assigned
    JOIN public.pr_products product ON product.id=assigned.product_id
    WHERE assigned.sub_warehouse_id=p_sub_warehouse_id
  ), recv_open AS (
    SELECT movement.product_id,COALESCE(SUM(movement.qty_delta),0)::NUMERIC qty
    FROM public.wh_sub_warehouse_stock_moves movement CROSS JOIN bounds
    WHERE movement.sub_warehouse_id=p_sub_warehouse_id AND movement.created_at<bounds.day_start
    GROUP BY movement.product_id
  ), recv_day AS (
    SELECT movement.product_id,
      COALESCE(SUM(CASE WHEN movement.qty_delta>0 THEN movement.qty_delta ELSE 0 END),0)::NUMERIC replenish,
      COALESCE(SUM(CASE WHEN movement.qty_delta<0 THEN movement.qty_delta ELSE 0 END),0)::NUMERIC reduce_sum
    FROM public.wh_sub_warehouse_stock_moves movement CROSS JOIN bounds
    WHERE movement.sub_warehouse_id=p_sub_warehouse_id
      AND movement.created_at>=bounds.day_start AND movement.created_at<bounds.day_end_excl
    GROUP BY movement.product_id
  ), wms_open AS (
    SELECT usage.product_code::TEXT,COALESCE(SUM(usage.qty),0)::NUMERIC qty
    FROM wms_usage usage CROSS JOIN bounds
    WHERE usage.usage_source='work_order' AND usage.used_at<bounds.day_start
    GROUP BY usage.product_code
  ), wms_day_tbl AS (
    SELECT usage.product_code::TEXT,COALESCE(SUM(usage.qty),0)::NUMERIC qty
    FROM wms_usage usage CROSS JOIN bounds
    WHERE usage.usage_source='work_order'
      AND usage.used_at>=bounds.day_start AND usage.used_at<bounds.day_end_excl
    GROUP BY usage.product_code
  )
  SELECT product_row.product_id,product_row.product_code,product_row.product_name,product_row.unit_name,
    COALESCE(recv_open.qty,0)::NUMERIC,COALESCE(recv_day.replenish,0)::NUMERIC,
    COALESCE(recv_day.reduce_sum,0)::NUMERIC,
    (CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_open.qty,0) ELSE COALESCE(wms_open.qty,0) END)::NUMERIC,
    (CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_day.qty,0) ELSE COALESCE(wms_day.qty,0) END)::NUMERIC,
    (COALESCE(recv_open.qty,0)-CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_open.qty,0) ELSE COALESCE(wms_open.qty,0) END)::NUMERIC,
    ((COALESCE(recv_open.qty,0)+COALESCE(recv_day.replenish,0)+COALESCE(recv_day.reduce_sum,0))
      -(CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_open.qty,0) ELSE COALESCE(wms_open.qty,0) END)
      -(CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_day.qty,0) ELSE COALESCE(wms_day.qty,0) END))::NUMERIC
  FROM products product_row
  LEFT JOIN spare_group ON spare_group.product_id=product_row.product_id
  LEFT JOIN group_wms_open group_open ON group_open.group_id=spare_group.group_id
  LEFT JOIN group_wms_day group_day ON group_day.group_id=spare_group.group_id
  LEFT JOIN recv_open ON recv_open.product_id=product_row.product_id
  LEFT JOIN recv_day ON recv_day.product_id=product_row.product_id
  LEFT JOIN wms_open ON wms_open.product_code=product_row.product_code
  LEFT JOIN wms_day_tbl wms_day ON wms_day.product_code=product_row.product_code
  ORDER BY product_row.product_code;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_sub_warehouse_daily_stock_sheet(UUID,DATE) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_sub_warehouse_daily_stock_sheet(UUID,DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
