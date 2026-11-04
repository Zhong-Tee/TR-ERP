BEGIN;
ALTER TABLE public.hr_interviews
  ADD COLUMN IF NOT EXISTS followup_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (followup_status IN ('pending', 'confirmed', 'started', 'declined')),
  ADD COLUMN IF NOT EXISTS start_date DATE,
  ADD COLUMN IF NOT EXISTS contact_note TEXT,
  ADD COLUMN IF NOT EXISTS application_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS appointment_history JSONB NOT NULL DEFAULT '[]'::JSONB;

UPDATE public.hr_interviews i SET application_snapshot = jsonb_build_object(
  'applied_position', c.applied_position, 'applied_department_id', c.applied_department_id,
  'custom_field_1', c.custom_field_1, 'custom_field_2', c.custom_field_2,
  'portfolio_url', c.portfolio_url
) FROM public.hr_candidates c WHERE c.id = i.candidate_id AND i.application_snapshot = '{}'::JSONB;

-- Preserve applicants already marked as hired by the previous screen.
UPDATE public.hr_interviews i SET followup_status = 'started'
FROM public.hr_candidates c
WHERE c.id = i.candidate_id AND c.status = 'hired'
  AND i.status IN ('attended', 'completed')
  AND i.id = (SELECT latest.id FROM public.hr_interviews latest
    WHERE latest.candidate_id = c.id ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1);

CREATE OR REPLACE FUNCTION public.hr_interview_preserve_history()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.interview_date IS DISTINCT FROM NEW.interview_date OR OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.appointment_history := OLD.appointment_history || jsonb_build_array(jsonb_build_object(
      'date', OLD.interview_date, 'status', OLD.status,
      'reason', coalesce(NEW.notes, ''), 'changed_at', now()
    ));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_hr_interview_preserve_history BEFORE UPDATE ON public.hr_interviews
FOR EACH ROW EXECUTE FUNCTION public.hr_interview_preserve_history();

-- Keep interview follow-up and the latest applicant status in one transaction.
CREATE OR REPLACE FUNCTION public.hr_save_interview_followup(
  p_interview_id UUID, p_status TEXT, p_start_date DATE, p_note TEXT
)
RETURNS public.hr_interviews LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE
  v_interview public.hr_interviews;
  v_recommendation TEXT;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('pending', 'confirmed', 'started', 'declined') THEN
    RAISE EXCEPTION 'ผลการติดต่อไม่ถูกต้อง';
  END IF;
  SELECT * INTO v_interview FROM public.hr_interviews WHERE id = p_interview_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบนัดสัมภาษณ์'; END IF;
  SELECT recommendation INTO v_recommendation FROM public.hr_interview_scores
  WHERE interview_id = p_interview_id ORDER BY created_at DESC, id DESC LIMIT 1;
  IF v_interview.status NOT IN ('attended', 'completed') OR v_recommendation IS DISTINCT FROM 'hire' THEN
    RAISE EXCEPTION 'ติดตามเริ่มงานได้เฉพาะผู้ผ่านสัมภาษณ์';
  END IF;
  IF p_status IN ('confirmed', 'started') AND p_start_date IS NULL THEN
    RAISE EXCEPTION 'กรุณาระบุวันเริ่มงาน';
  END IF;
  UPDATE public.hr_interviews SET followup_status = p_status, start_date = p_start_date,
    contact_note = nullif(btrim(p_note), '') WHERE id = p_interview_id RETURNING * INTO v_interview;
  IF p_interview_id = (SELECT id FROM public.hr_interviews WHERE candidate_id = v_interview.candidate_id
    ORDER BY created_at DESC, id DESC LIMIT 1) THEN
    UPDATE public.hr_candidates SET status = CASE p_status
      WHEN 'started' THEN 'hired' WHEN 'declined' THEN 'withdrawn' ELSE 'passed' END
    WHERE id = v_interview.candidate_id;
  END IF;
  RETURN v_interview;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_save_interview_followup(UUID,TEXT,DATE,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_save_interview_followup(UUID,TEXT,DATE,TEXT) TO authenticated;
COMMIT;
