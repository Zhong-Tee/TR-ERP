BEGIN;

-- NULL identifies historical rows where enrollment was not recorded. Do not
-- infer their enrollment from today's employee settings or change their money.
ALTER TABLE public.hr_payroll_items ADD COLUMN IF NOT EXISTS social_security_enabled BOOLEAN;
COMMENT ON COLUMN public.hr_payroll_items.social_security_enabled IS
  'Enrollment snapshot for this payroll; NULL means legacy/unknown, grouped by recorded deduction only';

CREATE OR REPLACE FUNCTION public.hr_payroll_snapshot_social_security()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.social_security_enabled IS NULL THEN
    SELECT e.social_security_enabled INTO NEW.social_security_enabled
      FROM public.hr_employees e WHERE e.id=NEW.employee_id;
  END IF;
  IF NEW.social_security_enabled IS FALSE THEN NEW.social_security := 0; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS hr_payroll_snapshot_social_security ON public.hr_payroll_items;
CREATE TRIGGER hr_payroll_snapshot_social_security BEFORE INSERT OR UPDATE ON public.hr_payroll_items
  FOR EACH ROW EXECUTE FUNCTION public.hr_payroll_snapshot_social_security();

CREATE OR REPLACE FUNCTION public.hr_reopen_monthly_payroll(p_run UUID,p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_run public.hr_payroll_runs;
BEGIN
  IF NOT public.hr_payroll_role_allowed() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ปรับปรุงงวดเงินเดือน'; END IF;
  IF NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลปรับปรุงยอด'; END IF;
  SELECT * INTO v_run FROM public.hr_payroll_runs WHERE id=p_run FOR UPDATE;
  IF NOT FOUND OR v_run.status <> 'confirmed' OR v_run.payroll_type <> 'permanent' THEN
    RAISE EXCEPTION 'เปิดปรับปรุงได้เฉพาะงวดเงินเดือนรายเดือนที่ยืนยันแล้ว';
  END IF;
  INSERT INTO public.hr_payroll_revisions(payroll_run_id,reason,run_before,items_before,created_by)
    SELECT p_run,trim(p_reason),to_jsonb(v_run),
      COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.employee_code),'[]'::jsonb),auth.uid()
    FROM public.hr_payroll_items i WHERE i.payroll_run_id=p_run;
  UPDATE public.hr_payroll_runs SET status='draft',confirmed_at=NULL,confirmed_by=NULL,updated_at=now() WHERE id=p_run;
  UPDATE public.hr_payroll_items SET reviewed_at=NULL,reviewed_by=NULL WHERE payroll_run_id=p_run;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_reopen_monthly_payroll(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_reopen_monthly_payroll(UUID,TEXT) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
