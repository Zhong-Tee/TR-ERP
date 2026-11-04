-- Give QC a stable per-order-line/per-unit identity without changing the
-- existing order, WMS, FIFO or printed barcode identifiers.
BEGIN;

ALTER TABLE public.qc_sessions
  ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.qc_records
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.or_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS order_item_id UUID REFERENCES public.or_order_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_index INTEGER,
  ADD COLUMN IF NOT EXISTS result_source TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE public.qc_records
  DROP CONSTRAINT IF EXISTS qc_records_status_check;
ALTER TABLE public.qc_records
  ADD CONSTRAINT qc_records_status_check
  CHECK (status IN ('pass', 'fail', 'pending', 'skipped'));

ALTER TABLE public.qc_records
  DROP CONSTRAINT IF EXISTS qc_records_unit_index_check;
ALTER TABLE public.qc_records
  ADD CONSTRAINT qc_records_unit_index_check
  CHECK (unit_index IS NULL OR unit_index >= 1);

ALTER TABLE public.qc_records
  DROP CONSTRAINT IF EXISTS qc_records_result_source_check;
ALTER TABLE public.qc_records
  ADD CONSTRAINT qc_records_result_source_check
  CHECK (result_source IN ('manual', 'recheck', 'skip', 'legacy'));

-- Historical skip rows were stored as pass + a remark. Preserve their audit
-- meaning, but do not guess stable identities for old/edited bills.
UPDATE public.qc_records
SET status = 'skipped',
    result_source = 'skip',
    workflow_status = 'closed',
    is_rejected = false,
    resolved_at = COALESCE(resolved_at, last_result_at, created_at)
WHERE status = 'pass' AND remark = 'ข้ามการ QC';

UPDATE public.qc_sessions s
SET skipped_count = x.skipped_count,
    pass_count = GREATEST(COALESCE(s.pass_count, 0) - x.skipped_count, 0)
FROM (
  SELECT session_id, COALESCE(sum(COALESCE(qty, 1)), 0)::INTEGER AS skipped_count
  FROM public.qc_records
  WHERE status = 'skipped'
  GROUP BY session_id
) x
WHERE s.id = x.session_id;

CREATE INDEX IF NOT EXISTS idx_qc_records_stable_identity
  ON public.qc_records(order_item_id, unit_index, last_result_at DESC)
  WHERE order_item_id IS NOT NULL AND unit_index IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS qc_records_session_stable_unit_key
  ON public.qc_records(session_id, order_item_id, unit_index);

CREATE UNIQUE INDEX IF NOT EXISTS qc_sessions_one_open_per_work_order
  ON public.qc_sessions(filename)
  WHERE end_time IS NULL;

CREATE OR REPLACE FUNCTION public.tr_qc_records_mark_recheck_source()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(NEW.retry_count, 1) > COALESCE(OLD.retry_count, 1) THEN
    NEW.result_source := 'recheck';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS qc_records_mark_recheck_source ON public.qc_records;
CREATE TRIGGER qc_records_mark_recheck_source
BEFORE UPDATE ON public.qc_records
FOR EACH ROW EXECUTE FUNCTION public.tr_qc_records_mark_recheck_source();

CREATE OR REPLACE FUNCTION public.qc_finish_session(p_session_id UUID)
RETURNS public.qc_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.qc_sessions;
  v_work_order_name TEXT;
  v_total INTEGER;
  v_passed INTEGER;
  v_failed INTEGER;
  v_now TIMESTAMPTZ := now();
  v_duration_seconds NUMERIC;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid()
      AND role IN ('superadmin', 'admin', 'production', 'packing_staff')
  ) THEN
    RAISE EXCEPTION 'Not authorized to finish QC';
  END IF;

  SELECT * INTO v_session
  FROM public.qc_sessions
  WHERE id = p_session_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'QC session not found'; END IF;
  IF v_session.end_time IS NOT NULL THEN RETURN v_session; END IF;

  v_work_order_name := NULLIF(trim(regexp_replace(v_session.filename, '^WO-', '')), '');
  IF v_work_order_name IS NULL THEN RAISE EXCEPTION 'Invalid QC work order'; END IF;

  WITH active_units AS (
    SELECT oi.id AS order_item_id, unit_no AS unit_index
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id = o.id
    CROSS JOIN LATERAL generate_series(
      1,
      LEAST(GREATEST(COALESCE(floor(oi.quantity)::INTEGER, 1), 1), 9999)
    ) unit_no
    WHERE o.work_order_name = v_work_order_name
      AND COALESCE(o.status, '') <> 'ยกเลิก'
      AND NULLIF(trim(COALESCE(oi.cancellation_stock_action, '')), '') IS NULL
  ), current_results AS (
    SELECT u.order_item_id, u.unit_index, r.status
    FROM active_units u
    LEFT JOIN public.qc_records r
      ON r.session_id = p_session_id
     AND r.order_item_id = u.order_item_id
     AND r.unit_index = u.unit_index
  )
  SELECT count(*)::INTEGER,
         count(*) FILTER (WHERE status = 'pass')::INTEGER,
         count(*) FILTER (WHERE status = 'fail')::INTEGER
  INTO v_total, v_passed, v_failed
  FROM current_results;

  IF v_total <= 0 THEN RAISE EXCEPTION 'QC session has no active items'; END IF;
  IF v_passed <> v_total OR v_failed <> 0 THEN
    RAISE EXCEPTION 'QC results are incomplete: % of % item(s) passed', v_passed, v_total;
  END IF;

  v_duration_seconds := GREATEST(extract(epoch FROM (v_now - v_session.start_time)), 0);
  UPDATE public.qc_sessions
  SET end_time = v_now,
      total_items = v_total,
      pass_count = v_passed,
      fail_count = 0,
      skipped_count = 0,
      kpi_score = CASE WHEN v_total > 0 THEN v_duration_seconds / v_total ELSE 0 END
  WHERE id = p_session_id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$$;

REVOKE ALL ON FUNCTION public.qc_finish_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_finish_session(UUID) TO authenticated;

-- Closing QC is allowed only when every unit was explicitly passed or skipped.
-- This changes no WMS/FIFO trigger and does not touch or_order_items identifiers.
CREATE OR REPLACE FUNCTION public.tr_qc_sessions_sync_qc_plan_on_close()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo TEXT;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_patch JSONB;
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.end_time IS NOT NULL OR NEW.end_time IS NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.total_items, 0) <= 0
     OR COALESCE(NEW.pass_count, 0) + COALESCE(NEW.skipped_count, 0) <> NEW.total_items
     OR COALESCE(NEW.fail_count, 0) <> 0 THEN
    RETURN NEW;
  END IF;

  v_wo := NULLIF(trim(COALESCE(NEW.filename, '')), '');
  IF v_wo IS NULL OR v_wo NOT LIKE 'WO-%' THEN RETURN NEW; END IF;
  v_wo := NULLIF(trim(substr(v_wo, 4)), '');
  IF v_wo IS NULL THEN RETURN NEW; END IF;

  v_start := COALESCE(NEW.start_time, now());
  v_end := NEW.end_time;
  v_patch := jsonb_build_object(
    'เริ่มQC', jsonb_build_object('start_if_null', to_jsonb(v_start), 'end', to_jsonb(v_end)),
    'เสร็จแล้ว', jsonb_build_object('start_if_null', to_jsonb(v_start), 'end', to_jsonb(v_end))
  );
  PERFORM public.merge_plan_tracks_by_name(v_wo, 'QC', v_patch);
  RETURN NEW;
END;
$$;

COMMIT;
