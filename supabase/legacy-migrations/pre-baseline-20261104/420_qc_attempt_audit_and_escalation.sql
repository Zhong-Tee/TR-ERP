-- Preserve every QC attempt and limit normal rechecks to two rounds.
BEGIN;

ALTER TABLE public.qc_records
  ADD COLUMN IF NOT EXISTS workflow_status TEXT,
  ADD COLUMN IF NOT EXISTS attempt_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_result_at TIMESTAMPTZ;

UPDATE public.qc_records SET last_result_at = created_at WHERE last_result_at IS NULL;
ALTER TABLE public.qc_records ALTER COLUMN last_result_at SET DEFAULT now();

UPDATE public.qc_records
SET workflow_status = CASE
  WHEN status = 'pass' THEN 'passed'
  WHEN is_rejected AND COALESCE(retry_count, 1) > 2 THEN 'escalated'
  WHEN is_rejected THEN 'waiting_recheck'
  ELSE 'pending'
END
WHERE workflow_status IS NULL;

ALTER TABLE public.qc_records ALTER COLUMN workflow_status SET DEFAULT 'pending';
ALTER TABLE public.qc_records ALTER COLUMN workflow_status SET NOT NULL;
ALTER TABLE public.qc_records DROP CONSTRAINT IF EXISTS qc_records_workflow_status_check;
ALTER TABLE public.qc_records ADD CONSTRAINT qc_records_workflow_status_check
  CHECK (workflow_status IN ('pending', 'passed', 'waiting_recheck', 'escalated', 'closed'));

CREATE TABLE IF NOT EXISTS public.qc_record_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  qc_record_id UUID NOT NULL REFERENCES public.qc_records(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES public.qc_sessions(id) ON DELETE CASCADE,
  item_uid TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  attempt_type TEXT NOT NULL CHECK (attempt_type IN ('initial', 'recheck', 'special_recheck')),
  result TEXT NOT NULL CHECK (result IN ('pass', 'fail')),
  fail_reason TEXT,
  qc_by TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (qc_record_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_qc_attempts_item_time
  ON public.qc_record_attempts(item_uid, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_qc_attempts_session
  ON public.qc_record_attempts(session_id, completed_at);

ALTER TABLE public.qc_record_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "QC users can view attempt audit" ON public.qc_record_attempts;
CREATE POLICY "QC users can view attempt audit" ON public.qc_record_attempts
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'production', 'packing_staff')
  ));
DROP POLICY IF EXISTS "QC operators can create attempt audit" ON public.qc_record_attempts;
DROP POLICY IF EXISTS "QC operators can manage attempt audit" ON public.qc_record_attempts;
CREATE POLICY "QC operators can manage attempt audit" ON public.qc_record_attempts
  FOR ALL TO authenticated USING (EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND role IN ('production', 'packing_staff')
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND role IN ('production', 'packing_staff')
  ));

-- Seed one best-effort attempt for legacy records; old overwritten rounds cannot be reconstructed.
INSERT INTO public.qc_record_attempts (
  qc_record_id, session_id, item_uid, attempt_no, attempt_type, result,
  fail_reason, qc_by, started_at, completed_at, duration_seconds
)
SELECT r.id, r.session_id, r.item_uid, GREATEST(COALESCE(r.retry_count, 1), 1),
       CASE WHEN COALESCE(r.retry_count, 1) = 1 THEN 'initial' ELSE 'recheck' END,
       r.status, r.fail_reason, r.qc_by,
       COALESCE(r.created_at - make_interval(secs => GREATEST(COALESCE(r.reject_duration, 0), 0)), r.created_at),
       r.created_at, GREATEST(COALESCE(r.reject_duration, 0), 0)
FROM public.qc_records r
WHERE r.status IN ('pass', 'fail')
ON CONFLICT (qc_record_id, attempt_no) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.qc_escalation_decisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  qc_record_id UUID NOT NULL REFERENCES public.qc_records(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('special_recheck', 'produce_new', 'scrap', 'return_source')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  decided_by TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.qc_escalation_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "QC users can view escalation decisions" ON public.qc_escalation_decisions
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.us_users WHERE id = auth.uid()
      AND role IN ('superadmin', 'admin', 'production', 'packing_staff')
  ));
CREATE POLICY "QC admins can decide escalations" ON public.qc_escalation_decisions
  FOR INSERT TO authenticated WITH CHECK (EXISTS (
    SELECT 1 FROM public.us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin')
  ));

-- Atomic recheck prevents two browser sessions from completing the same round twice.
CREATE OR REPLACE FUNCTION public.qc_submit_recheck(
  p_record_id UUID, p_result TEXT, p_fail_reason TEXT, p_qc_by TEXT
) RETURNS public.qc_records
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_record public.qc_records;
  v_now TIMESTAMPTZ := now();
  v_attempt INTEGER;
  v_duration INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.us_users WHERE id = auth.uid() AND role IN ('production', 'packing_staff')) THEN
    RAISE EXCEPTION 'Not authorized to perform QC';
  END IF;
  IF p_result NOT IN ('pass', 'fail') THEN RAISE EXCEPTION 'Invalid QC result'; END IF;
  IF p_result = 'fail' AND NULLIF(trim(COALESCE(p_fail_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Fail reason is required';
  END IF;

  SELECT * INTO v_record FROM public.qc_records WHERE id = p_record_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'QC record not found'; END IF;
  IF NOT v_record.is_rejected OR v_record.workflow_status NOT IN ('waiting_recheck') THEN
    RAISE EXCEPTION 'This item is no longer waiting for recheck';
  END IF;

  v_attempt := COALESCE(v_record.retry_count, 1) + 1;
  v_duration := GREATEST(floor(extract(epoch FROM (v_now - COALESCE(v_record.attempt_started_at, v_record.created_at))))::INTEGER, 0);

  INSERT INTO public.qc_record_attempts (
    qc_record_id, session_id, item_uid, attempt_no, attempt_type, result,
    fail_reason, qc_by, started_at, completed_at, duration_seconds
  ) VALUES (
    v_record.id, v_record.session_id, v_record.item_uid, v_attempt,
    CASE WHEN v_attempt > 3 THEN 'special_recheck' ELSE 'recheck' END,
    p_result, CASE WHEN p_result = 'fail' THEN p_fail_reason ELSE NULL END,
    p_qc_by, COALESCE(v_record.attempt_started_at, v_record.created_at), v_now, v_duration
  );

  UPDATE public.qc_records SET
    status = p_result,
    fail_reason = CASE WHEN p_result = 'fail' THEN p_fail_reason ELSE NULL END,
    is_rejected = (p_result = 'fail'),
    retry_count = v_attempt,
    workflow_status = CASE
      WHEN p_result = 'pass' THEN 'passed'
      WHEN v_attempt >= 3 THEN 'escalated'
      ELSE 'waiting_recheck'
    END,
    qc_by = p_qc_by,
    last_result_at = v_now,
    reject_duration = v_duration,
    resolved_at = CASE WHEN p_result = 'pass' THEN v_now ELSE NULL END,
    attempt_started_at = CASE WHEN p_result = 'fail' THEN v_now ELSE NULL END
  WHERE id = p_record_id RETURNING * INTO v_record;
  RETURN v_record;
END;
$$;

CREATE OR REPLACE FUNCTION public.qc_resolve_escalation(
  p_record_id UUID, p_decision TEXT, p_reason TEXT, p_decided_by TEXT
) RETURNS public.qc_records
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_record public.qc_records; v_now TIMESTAMPTZ := now();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin')) THEN
    RAISE EXCEPTION 'Only admin can resolve escalated QC items';
  END IF;
  IF p_decision NOT IN ('special_recheck', 'produce_new', 'scrap', 'return_source') THEN
    RAISE EXCEPTION 'Invalid escalation decision';
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Decision reason is required'; END IF;
  SELECT * INTO v_record FROM public.qc_records WHERE id = p_record_id FOR UPDATE;
  IF NOT FOUND OR v_record.workflow_status <> 'escalated' THEN RAISE EXCEPTION 'Item is not escalated'; END IF;

  INSERT INTO public.qc_escalation_decisions(qc_record_id, decision, reason, decided_by)
  VALUES (p_record_id, p_decision, trim(p_reason), p_decided_by);

  UPDATE public.qc_records SET
    workflow_status = CASE WHEN p_decision = 'special_recheck' THEN 'waiting_recheck' ELSE 'closed' END,
    is_rejected = (p_decision = 'special_recheck'),
    attempt_started_at = CASE WHEN p_decision = 'special_recheck' THEN v_now ELSE NULL END,
    resolved_at = CASE WHEN p_decision = 'special_recheck' THEN NULL ELSE v_now END
  WHERE id = p_record_id RETURNING * INTO v_record;
  RETURN v_record;
END;
$$;

GRANT EXECUTE ON FUNCTION public.qc_submit_recheck(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.qc_resolve_escalation(UUID, TEXT, TEXT, TEXT) TO authenticated;

COMMIT;
