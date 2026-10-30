BEGIN;
ALTER TABLE public.hr_employees ADD COLUMN IF NOT EXISTS compensation_effective_date DATE;
ALTER TABLE public.hr_payroll_items
  ADD COLUMN IF NOT EXISTS monthly_rate NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS monthly_payable_days NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS monthly_wage_details JSONB;

-- Registry changes and the salary-history panel must produce the same timeline.
CREATE OR REPLACE FUNCTION public.hr_record_employee_compensation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE effective DATE;
BEGIN
  IF NEW.salary IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND (NEW.salary,NEW.contract_type,NEW.position_allowance,NEW.compensation_effective_date)
    IS NOT DISTINCT FROM (OLD.salary,OLD.contract_type,OLD.position_allowance,OLD.compensation_effective_date) THEN RETURN NEW; END IF;
  effective := COALESCE(NEW.compensation_effective_date,NEW.hire_date,(now() AT TIME ZONE 'Asia/Bangkok')::date);
  IF TG_OP='UPDATE' AND effective>(now() AT TIME ZONE 'Asia/Bangkok')::date THEN
    RAISE EXCEPTION 'ค่าจ้างล่วงหน้าให้เพิ่มผ่านประวัติเงินเดือน เพื่อคงค่าจ้างปัจจุบันไว้';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.hr_salary_history h WHERE h.employee_id=NEW.id
    AND h.effective_date=effective AND h.salary=NEW.salary
    AND h.pay_type=COALESCE(NEW.contract_type,'permanent')
    AND COALESCE(h.position_allowance,0)=COALESCE(NEW.position_allowance,0)
    AND NOT EXISTS(SELECT 1 FROM public.hr_salary_history later WHERE later.employee_id=NEW.id
      AND later.effective_date=effective AND (later.created_at,later.id)>(h.created_at,h.id))) THEN
    INSERT INTO public.hr_salary_history(employee_id,salary,position_allowance,pay_type,effective_date,note,created_at)
      VALUES(NEW.id,NEW.salary,CASE WHEN NEW.contract_type='daily' THEN 0 ELSE COALESCE(NEW.position_allowance,0) END,
        COALESCE(NEW.contract_type,'permanent'),effective,'ทะเบียนพนักงาน: บันทึกประเภทสัญญา/ค่าจ้างพร้อมวันที่มีผล',clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS hr_record_employee_compensation ON public.hr_employees;
CREATE TRIGGER hr_record_employee_compensation AFTER INSERT OR UPDATE ON public.hr_employees
  FOR EACH ROW EXECUTE FUNCTION public.hr_record_employee_compensation();

-- Dates, rather than today's contract type, determine whether two payrolls overlap.
CREATE OR REPLACE FUNCTION public.hr_payroll_paid_dates(item JSONB, month_start DATE)
RETURNS DATE[] LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE result DATE[]; month_end DATE := (date_trunc('month',month_start)+interval '1 month - 1 day')::date;
BEGIN
  IF COALESCE((item->>'base_salary')::numeric,0)=0 AND COALESCE((item->>'overtime_pay')::numeric,0)=0 THEN RETURN ARRAY[]::date[]; END IF;
  IF item->>'pay_type'='daily' AND jsonb_typeof(item->'daily_wage_details')='array' AND jsonb_array_length(item->'daily_wage_details')>0 THEN
    SELECT array_agg(DISTINCT (d->>'workDate')::date) INTO result FROM jsonb_array_elements(item->'daily_wage_details') d
      WHERE (COALESCE((d->>'amount')::numeric,0)>0 OR COALESCE((d->>'payableDay')::numeric,0)>0)
        AND (d->>'workDate')::date BETWEEN month_start AND month_end;
  ELSIF item->>'pay_type' IS DISTINCT FROM 'daily' AND jsonb_typeof(item->'monthly_wage_details')='array' AND jsonb_array_length(item->'monthly_wage_details')>0 THEN
    SELECT array_agg(DISTINCT day::date) INTO result FROM jsonb_array_elements(item->'monthly_wage_details') d
      CROSS JOIN LATERAL generate_series(GREATEST((d->>'startDate')::date,month_start),LEAST((d->>'endDate')::date,month_end),interval '1 day') day;
  ELSE
    -- A legacy paid item without a date breakdown occupies the whole month.
    SELECT array_agg(day::date) INTO result FROM generate_series(month_start,month_end,interval '1 day') day;
  END IF;
  IF COALESCE(array_length(result,1),0)=0 THEN
    SELECT array_agg(day::date) INTO result FROM generate_series(month_start,month_end,interval '1 day') day;
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_payroll_confirm_no_overlap()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE i RECORD; days DATE[];
BEGIN
  IF NEW.status<>'confirmed' OR OLD.status='confirmed' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text || ':' || NEW.payroll_month::text || ':monthly',0));
  FOR i IN SELECT * FROM public.hr_payroll_items WHERE payroll_run_id=NEW.id LOOP
    days := public.hr_payroll_paid_dates(to_jsonb(i),NEW.payroll_month);
    IF EXISTS(SELECT 1 FROM public.hr_payroll_items other JOIN public.hr_payroll_runs r ON r.id=other.payroll_run_id
      WHERE other.employee_id=i.employee_id AND r.id<>NEW.id AND r.company_id=NEW.company_id
        AND r.payroll_month=NEW.payroll_month AND r.status='confirmed'
        AND public.hr_payroll_paid_dates(to_jsonb(other),r.payroll_month) && days) THEN
      RAISE EXCEPTION 'พนักงาน % มีค่าจ้างยืนยันแล้วในช่วงวันเดียวกัน กรุณาปรับปรุงงวดเดิมก่อนเพื่อไม่ให้จ่ายซ้ำ',i.employee_code;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS aaa_hr_payroll_confirm_no_overlap ON public.hr_payroll_runs;
CREATE TRIGGER aaa_hr_payroll_confirm_no_overlap BEFORE UPDATE OF status ON public.hr_payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.hr_payroll_confirm_no_overlap();

CREATE TABLE IF NOT EXISTS public.hr_compensation_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID NOT NULL REFERENCES public.hr_employees(id),
  effective_date DATE NOT NULL, reason TEXT NOT NULL, before_data JSONB NOT NULL, after_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(employee_id,effective_date,reason)
);
ALTER TABLE public.hr_compensation_corrections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_compensation_corrections_read ON public.hr_compensation_corrections;
CREATE POLICY hr_compensation_corrections_read ON public.hr_compensation_corrections FOR SELECT TO authenticated
  USING(public.hr_is_admin() OR public.hr_payroll_role_allowed());
REVOKE ALL ON public.hr_compensation_corrections FROM anon,authenticated;
GRANT SELECT ON public.hr_compensation_corrections TO authenticated;

-- Explicit HR instruction: EMP00024 is monthly 18,000 from the hire date,
-- 19 October 2026. Append a correction; retain all previous salary records.
DO $$
DECLARE e public.hr_employees; before_record JSONB; old_history JSONB; r public.hr_payroll_runs;
  correction_reason TEXT := 'Migration 683: EMP00024 รายเดือน 18000 ตั้งแต่ 2026-10-19 ฐานหาร 30';
BEGIN
  SELECT * INTO e FROM public.hr_employees WHERE employee_code='EMP00024' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM public.hr_compensation_corrections WHERE employee_id=e.id AND reason=correction_reason) THEN RETURN; END IF;
  IF e.hire_date IS DISTINCT FROM DATE '2026-10-19' OR e.salary IS NULL OR e.salary NOT IN (600,18000) THEN
    RAISE EXCEPTION 'ข้อมูล EMP00024 เปลี่ยนจากที่ HR ยืนยัน กรุณาตรวจสอบก่อนปรับประวัติค่าจ้าง';
  END IF;
  IF EXISTS(SELECT 1 FROM public.hr_salary_history WHERE employee_id=e.id AND effective_date>'2026-10-19'
    AND effective_date<='2026-10-31' AND (pay_type<>'permanent' OR salary<>18000)) THEN
    RAISE EXCEPTION 'พบประวัติค่าจ้าง EMP00024 หลัง 19 ต.ค. ที่ขัดกับคำสั่ง กรุณาทบทวนก่อน';
  END IF;
  before_record := to_jsonb(e);
  SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.effective_date,h.created_at),'[]'::jsonb) INTO old_history
    FROM public.hr_salary_history h WHERE h.employee_id=e.id;
  INSERT INTO public.hr_salary_history(employee_id,salary,position_allowance,pay_type,effective_date,note,created_at)
    VALUES(e.id,18000,COALESCE(e.position_allowance,0),'permanent','2026-10-19',correction_reason,clock_timestamp());
  UPDATE public.hr_employees SET salary=18000,contract_type='permanent',compensation_effective_date='2026-10-19' WHERE id=e.id;
  FOR r IN SELECT run.* FROM public.hr_payroll_runs run WHERE run.payroll_month='2026-10-01'
    AND run.payroll_type='daily' AND run.status='draft'
    AND EXISTS(SELECT 1 FROM public.hr_payroll_items i WHERE i.payroll_run_id=run.id AND i.employee_id=e.id) FOR UPDATE LOOP
    INSERT INTO public.hr_payroll_revisions(payroll_run_id,reason,run_before,items_before,created_by)
      SELECT r.id,correction_reason,to_jsonb(r),jsonb_agg(to_jsonb(i) ORDER BY i.employee_code),auth.uid()
      FROM public.hr_payroll_items i WHERE i.payroll_run_id=r.id;
    DELETE FROM public.hr_payroll_items WHERE payroll_run_id=r.id AND employee_id=e.id;
  END LOOP;
  UPDATE public.hr_payroll_items i SET reviewed_at=NULL,reviewed_by=NULL
    FROM public.hr_payroll_runs parent WHERE parent.id=i.payroll_run_id AND i.employee_id=e.id
      AND parent.payroll_month='2026-10-01' AND parent.payroll_type IN ('permanent','monthly_uninsured') AND parent.status='draft';
  INSERT INTO public.hr_compensation_corrections(employee_id,effective_date,reason,before_data,after_data)
    VALUES(e.id,'2026-10-19',correction_reason,jsonb_build_object('employee',before_record,'salary_history',old_history),
      jsonb_build_object('salary',18000,'pay_type','permanent','divisor',30,'expected_calendar_days',13,'expected_base_salary',7800));
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
