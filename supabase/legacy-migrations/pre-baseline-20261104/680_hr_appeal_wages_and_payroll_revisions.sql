BEGIN;

-- A score waiver alone does not establish how many days of wages are payable.
-- These immutable approvals are explicit HR decisions, also for older appeals.
CREATE TABLE IF NOT EXISTS public.hr_daily_wage_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.hr_employees(id),
  work_date DATE NOT NULL,
  appeal_id UUID NOT NULL UNIQUE REFERENCES public.hr_score_appeals(id),
  payable_day NUMERIC(2,1) NOT NULL CHECK (payable_day IN (0.5, 1)),
  note TEXT NOT NULL CHECK (length(trim(note)) > 0),
  approved_by UUID REFERENCES public.us_users(id),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(employee_id, work_date)
);
ALTER TABLE public.hr_daily_wage_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_daily_wage_approvals_read ON public.hr_daily_wage_approvals;
CREATE POLICY hr_daily_wage_approvals_read ON public.hr_daily_wage_approvals
  FOR SELECT TO authenticated USING (
    public.hr_is_admin() OR public.hr_payroll_role_allowed() OR employee_id = public.hr_my_employee_id()
  );
REVOKE ALL ON public.hr_daily_wage_approvals FROM anon, authenticated;
GRANT SELECT ON public.hr_daily_wage_approvals TO authenticated;

CREATE OR REPLACE FUNCTION public.hr_score_review_appeal_payroll(
  p_appeal UUID, p_payable_day NUMERIC DEFAULT 0, p_note TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_appeal public.hr_score_appeals;
  v_existing public.hr_daily_wage_approvals;
BEGIN
  IF NOT public.hr_is_admin() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ตัดสินคำทักท้วง'; END IF;
  IF p_payable_day IS NULL OR p_payable_day NOT IN (0, 0.5, 1) THEN
    RAISE EXCEPTION 'กรุณาเลือกคืนคะแนนอย่างเดียว เต็มวัน หรือครึ่งวัน';
  END IF;
  SELECT * INTO v_appeal FROM public.hr_score_appeals WHERE id=p_appeal FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำทักท้วง'; END IF;
  IF v_appeal.status NOT IN ('pending','accepted') THEN RAISE EXCEPTION 'คำทักท้วงนี้ถูกปฏิเสธแล้ว'; END IF;
  IF p_payable_day > 0 THEN
    -- Only base absence events may establish attendance, never a repeat penalty.
    IF v_appeal.event_code NOT IN ('absent','absent_pending_leave') THEN
      RAISE EXCEPTION 'รับรองค่าจ้างได้เฉพาะคำทักท้วงขาดงานต้นทาง';
    END IF;
    IF NULLIF(trim(p_note),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุหลักฐานหรือเหตุผลรับรองค่าจ้าง'; END IF;
    -- Serialize different appeals for the same employee/date as well.
    PERFORM pg_advisory_xact_lock(hashtextextended(v_appeal.employee_id::text || ':' || v_appeal.event_date::text, 0));
    SELECT * INTO v_existing FROM public.hr_daily_wage_approvals
      WHERE employee_id=v_appeal.employee_id AND work_date=v_appeal.event_date;
    IF FOUND THEN RAISE EXCEPTION 'วันที่นี้ได้รับรองค่าจ้างแล้ว กรุณาตรวจประวัติเดิม'; END IF;
  END IF;
  IF v_appeal.status='pending' THEN
    PERFORM public.hr_score_accept_appeal(p_appeal, p_note);
  ELSIF p_payable_day=0 THEN
    RAISE EXCEPTION 'คำทักท้วงนี้คืนคะแนนแล้ว';
  END IF;
  IF p_payable_day > 0 THEN
    INSERT INTO public.hr_daily_wage_approvals(employee_id,work_date,appeal_id,payable_day,note,approved_by)
    VALUES(v_appeal.employee_id,v_appeal.event_date,p_appeal,p_payable_day,trim(p_note),auth.uid());
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_score_review_appeal_payroll(UUID,NUMERIC,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_score_review_appeal_payroll(UUID,NUMERIC,TEXT) TO authenticated;

-- Snapshot each confirmed version before opening it for a correction. No
-- historical amount is silently overwritten, and the reason/actor are retained.
CREATE TABLE IF NOT EXISTS public.hr_payroll_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id UUID NOT NULL REFERENCES public.hr_payroll_runs(id),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  run_before JSONB NOT NULL,
  items_before JSONB NOT NULL,
  created_by UUID REFERENCES public.us_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  transaction_id BIGINT NOT NULL DEFAULT txid_current()
);
ALTER TABLE public.hr_payroll_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_payroll_revisions_read ON public.hr_payroll_revisions;
CREATE POLICY hr_payroll_revisions_read ON public.hr_payroll_revisions FOR SELECT TO authenticated
  USING(public.hr_payroll_role_allowed());
REVOKE ALL ON public.hr_payroll_revisions FROM anon, authenticated;
GRANT SELECT ON public.hr_payroll_revisions TO authenticated;

CREATE OR REPLACE FUNCTION public.hr_reopen_daily_payroll(p_run UUID,p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_run public.hr_payroll_runs;
BEGIN
  IF NOT public.hr_payroll_role_allowed() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ปรับปรุงงวดเงินเดือน'; END IF;
  IF NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลปรับปรุงยอด'; END IF;
  SELECT * INTO v_run FROM public.hr_payroll_runs WHERE id=p_run FOR UPDATE;
  IF NOT FOUND OR v_run.status <> 'confirmed' OR v_run.payroll_type <> 'daily' THEN
    RAISE EXCEPTION 'เปิดปรับปรุงได้เฉพาะงวดค่าจ้างรายวันที่ยืนยันแล้ว';
  END IF;
  INSERT INTO public.hr_payroll_revisions(payroll_run_id,reason,run_before,items_before,created_by)
    SELECT p_run,trim(p_reason),to_jsonb(v_run),
      COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.employee_code),'[]'::jsonb),auth.uid()
    FROM public.hr_payroll_items i WHERE i.payroll_run_id=p_run;
  UPDATE public.hr_payroll_runs SET status='draft',confirmed_at=NULL,confirmed_by=NULL,updated_at=now() WHERE id=p_run;
  UPDATE public.hr_payroll_items SET reviewed_at=NULL,reviewed_by=NULL WHERE payroll_run_id=p_run;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_reopen_daily_payroll(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_reopen_daily_payroll(UUID,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.hr_payroll_guard_confirmed_run()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF OLD.status='confirmed' THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'งวดที่ยืนยันแล้วต้องเก็บไว้ตรวจย้อนหลัง'; END IF;
    IF NEW.status <> 'draft'
      OR (to_jsonb(NEW)-ARRAY['status','confirmed_at','confirmed_by','updated_at'])
         IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','confirmed_at','confirmed_by','updated_at'])
      OR NOT EXISTS(SELECT 1 FROM public.hr_payroll_revisions r WHERE r.payroll_run_id=OLD.id
        AND r.transaction_id=txid_current() AND r.created_by IS NOT DISTINCT FROM auth.uid()) THEN
      RAISE EXCEPTION 'งวดนี้ยืนยันแล้ว กรุณาเปิดปรับปรุงยอดพร้อมระบุเหตุผลก่อน';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS hr_payroll_guard_confirmed_run ON public.hr_payroll_runs;
CREATE TRIGGER hr_payroll_guard_confirmed_run BEFORE UPDATE OR DELETE ON public.hr_payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.hr_payroll_guard_confirmed_run();

CREATE OR REPLACE FUNCTION public.hr_payroll_guard_confirmed_item()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_status TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO v_status FROM public.hr_payroll_runs WHERE id=OLD.payroll_run_id FOR UPDATE;
    IF v_status='confirmed' THEN RAISE EXCEPTION 'ยอดยืนยันแล้ว กรุณาเปิดปรับปรุงงวดก่อน'; END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT status INTO v_status FROM public.hr_payroll_runs WHERE id=NEW.payroll_run_id FOR UPDATE;
    IF v_status='confirmed' THEN RAISE EXCEPTION 'ยอดยืนยันแล้ว กรุณาเปิดปรับปรุงงวดก่อน'; END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS hr_payroll_guard_confirmed_item ON public.hr_payroll_items;
CREATE TRIGGER hr_payroll_guard_confirmed_item BEFORE INSERT OR UPDATE OR DELETE ON public.hr_payroll_items
  FOR EACH ROW EXECUTE FUNCTION public.hr_payroll_guard_confirmed_item();

-- Apply the ceiling on writes too, including RPC callers outside this UI.
CREATE OR REPLACE FUNCTION public.hr_score_period_ceiling()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  NEW.total_points := LEAST(NEW.base_points,NEW.total_points);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS hr_score_period_ceiling ON public.hr_score_periods;
CREATE TRIGGER hr_score_period_ceiling BEFORE INSERT OR UPDATE ON public.hr_score_periods
  FOR EACH ROW EXECUTE FUNCTION public.hr_score_period_ceiling();

CREATE TABLE IF NOT EXISTS public.hr_score_correction_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.hr_employees(id),
  period DATE NOT NULL,
  reason TEXT NOT NULL,
  before_data JSONB NOT NULL,
  after_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.hr_score_correction_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_score_correction_audit_read ON public.hr_score_correction_audit;
CREATE POLICY hr_score_correction_audit_read ON public.hr_score_correction_audit FOR SELECT TO authenticated
  USING(public.hr_is_admin() OR public.hr_payroll_role_allowed());
REVOKE ALL ON public.hr_score_correction_audit FROM anon, authenticated;
GRANT SELECT ON public.hr_score_correction_audit TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
