-- Cancel seven confirmed orphan FSPTR headers. Headers are retained as audit
-- records, matching the application's normal work-order cancellation flow.

BEGIN;

DO $$
DECLARE
  v_names TEXT[] := ARRAY[
    'FSPTR-030969-R1',
    'FSPTR-030969-R2',
    'FSPTR-030969-R3',
    'FSPTR-030969-R4',
    'FSPTR-030969-R5',
    'FSPTR-030969-R6',
    'FSPTR-030969-R7'
  ];
  v_ids UUID[];
  v_count INTEGER;
BEGIN
  SELECT ARRAY_AGG(wo.id ORDER BY wo.work_order_name), COUNT(*)::INTEGER
  INTO v_ids, v_count
  FROM public.or_work_orders wo
  WHERE wo.work_order_name = ANY(v_names)
    AND wo.status IS DISTINCT FROM U&'\0E22\0E01\0E40\0E25\0E34\0E01';

  IF COALESCE(v_count, 0) <> 7 THEN
    RAISE EXCEPTION 'Expected 7 active FSPTR orphan headers, found %', COALESCE(v_count, 0);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.or_orders o
    WHERE o.work_order_id = ANY(v_ids)
       OR o.work_order_name = ANY(v_names)
  ) THEN
    RAISE EXCEPTION 'FSPTR cleanup aborted: at least one target still owns an order';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.wms_orders w
    WHERE w.work_order_id = ANY(v_ids)
      AND w.status NOT IN ('cancelled', 'returned')
  ) THEN
    RAISE EXCEPTION 'FSPTR cleanup aborted: at least one target has active WMS activity';
  END IF;

  -- Started plans remain as voided audit history; plans never started are removed.
  UPDATE public.plan_jobs pj
  SET is_production_voided = TRUE,
      qty = '{}'::JSONB
  WHERE (pj.work_order_id = ANY(v_ids) OR pj.name = ANY(v_names))
    AND public.fn_plan_job_has_any_track_start(pj.name);

  DELETE FROM public.plan_jobs pj
  WHERE (pj.work_order_id = ANY(v_ids) OR pj.name = ANY(v_names))
    AND NOT public.fn_plan_job_has_any_track_start(pj.name);

  UPDATE public.or_work_orders wo
  SET status = U&'\0E22\0E01\0E40\0E25\0E34\0E01',
      order_count = 0,
      plan_wo_modified = TRUE,
      updated_at = NOW()
  WHERE wo.id = ANY(v_ids);
END;
$$;

COMMIT;
