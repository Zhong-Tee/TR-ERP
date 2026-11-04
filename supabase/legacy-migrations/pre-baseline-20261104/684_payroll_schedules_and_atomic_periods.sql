BEGIN;
CREATE TABLE IF NOT EXISTS public.hr_pay_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID REFERENCES public.hr_companies(id),
  name TEXT NOT NULL CHECK(length(trim(name))>0), frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly','semimonthly','monthly','custom')),
  weekday INT NOT NULL DEFAULT 1 CHECK(weekday BETWEEN 1 AND 7),
  first_day INT NOT NULL DEFAULT 15 CHECK(first_day BETWEEN 1 AND 27),
  second_day INT CHECK(second_day BETWEEN 16 AND 31), payment_day INT CHECK(payment_day BETWEEN 1 AND 31),
  holiday_rule TEXT NOT NULL DEFAULT 'none' CHECK(holiday_rule IN ('none','previous','next')),
  deduction_policy TEXT NOT NULL DEFAULT 'last' CHECK(deduction_policy IN ('last','proportional')),
  cutoff_time TIME NOT NULL DEFAULT '18:00', is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(second_day IS NULL OR second_day>first_day)
);
INSERT INTO public.hr_pay_schedules(id,name,frequency) VALUES('00000000-0000-4000-8000-000000000001','รายเดือน วันที่ 1–สิ้นเดือน','monthly') ON CONFLICT(id) DO NOTHING;
ALTER TABLE public.hr_employees ADD COLUMN IF NOT EXISTS pay_schedule_id UUID REFERENCES public.hr_pay_schedules(id),
  ADD COLUMN IF NOT EXISTS pay_schedule_effective_date DATE;
CREATE TABLE IF NOT EXISTS public.hr_employee_pay_schedule_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID NOT NULL REFERENCES public.hr_employees(id),
  schedule_id UUID NOT NULL REFERENCES public.hr_pay_schedules(id), effective_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hr_pay_schedule_history_employee_date ON public.hr_employee_pay_schedule_history(employee_id,effective_date DESC,created_at DESC);
ALTER TABLE public.hr_pay_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_employee_pay_schedule_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_pay_schedules_read ON public.hr_pay_schedules;
CREATE POLICY hr_pay_schedules_read ON public.hr_pay_schedules FOR SELECT TO authenticated USING(public.hr_is_admin() OR public.hr_payroll_role_allowed() OR public.hr_my_employee_id() IS NOT NULL);
DROP POLICY IF EXISTS hr_pay_schedules_manage ON public.hr_pay_schedules;
CREATE POLICY hr_pay_schedules_manage ON public.hr_pay_schedules FOR ALL TO authenticated USING(public.hr_is_admin() OR public.hr_payroll_role_allowed()) WITH CHECK(public.hr_is_admin() OR public.hr_payroll_role_allowed());
DROP POLICY IF EXISTS hr_pay_schedule_history_read ON public.hr_employee_pay_schedule_history;
CREATE POLICY hr_pay_schedule_history_read ON public.hr_employee_pay_schedule_history FOR SELECT TO authenticated USING(public.hr_is_admin() OR public.hr_payroll_role_allowed() OR employee_id=public.hr_my_employee_id());
GRANT SELECT,INSERT,UPDATE ON public.hr_pay_schedules TO authenticated;
REVOKE INSERT,UPDATE,DELETE ON public.hr_employee_pay_schedule_history FROM authenticated,anon;
GRANT SELECT ON public.hr_employee_pay_schedule_history TO authenticated;

CREATE OR REPLACE FUNCTION public.hr_guard_pay_schedule_definition() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF (NEW.company_id,NEW.frequency,NEW.weekday,NEW.first_day,NEW.second_day,NEW.payment_day,NEW.holiday_rule,NEW.deduction_policy,NEW.cutoff_time)
    IS DISTINCT FROM (OLD.company_id,OLD.frequency,OLD.weekday,OLD.first_day,OLD.second_day,OLD.payment_day,OLD.holiday_rule,OLD.deduction_policy,OLD.cutoff_time)
    AND EXISTS(SELECT 1 FROM public.hr_employee_pay_schedule_history WHERE schedule_id=OLD.id) THEN
    RAISE EXCEPTION 'รอบนี้มีประวัติใช้งานแล้ว ให้สร้างรอบใหม่และกำหนดวันที่เริ่มมีผลแทน';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS hr_guard_pay_schedule_definition ON public.hr_pay_schedules;
CREATE TRIGGER hr_guard_pay_schedule_definition BEFORE UPDATE ON public.hr_pay_schedules FOR EACH ROW EXECUTE FUNCTION public.hr_guard_pay_schedule_definition();
CREATE OR REPLACE FUNCTION public.hr_record_pay_schedule() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE selected UUID := COALESCE(NEW.pay_schedule_id,'00000000-0000-4000-8000-000000000001'::uuid); effective DATE;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.pay_schedule_id,NEW.pay_schedule_effective_date,NEW.company_id) IS NOT DISTINCT FROM (OLD.pay_schedule_id,OLD.pay_schedule_effective_date,OLD.company_id) THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.hr_pay_schedules WHERE id=selected AND is_active AND (company_id IS NULL OR company_id=NEW.company_id)) THEN
    RAISE EXCEPTION 'รอบจ่ายไม่ได้อยู่ในบริษัทนี้หรือปิดใช้งานแล้ว';
  END IF;
  effective:=COALESCE(NEW.pay_schedule_effective_date,NEW.hire_date,(now() AT TIME ZONE 'Asia/Bangkok')::date);
  INSERT INTO public.hr_employee_pay_schedule_history(employee_id,schedule_id,effective_date) VALUES(NEW.id,selected,effective);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS hr_record_pay_schedule ON public.hr_employees;
CREATE TRIGGER hr_record_pay_schedule AFTER INSERT OR UPDATE ON public.hr_employees FOR EACH ROW EXECUTE FUNCTION public.hr_record_pay_schedule();
CREATE OR REPLACE FUNCTION public.hr_pay_schedule_at(p_employee UUID,p_date DATE) RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT COALESCE((SELECT schedule_id FROM public.hr_employee_pay_schedule_history WHERE employee_id=p_employee AND effective_date<=p_date ORDER BY effective_date DESC,created_at DESC,id DESC LIMIT 1),'00000000-0000-4000-8000-000000000001'::uuid)
$$;

ALTER TABLE public.hr_payroll_runs
  ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES public.hr_pay_schedules(id),
  ADD COLUMN IF NOT EXISTS period_start DATE, ADD COLUMN IF NOT EXISTS period_end DATE,
  ADD COLUMN IF NOT EXISTS schedule_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_tracking_state TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE public.hr_payroll_runs ALTER COLUMN payment_tracking_state SET DEFAULT 'managed';
ALTER TABLE public.hr_payroll_runs DROP CONSTRAINT IF EXISTS hr_payroll_runs_status_check;
ALTER TABLE public.hr_payroll_runs ADD CONSTRAINT hr_payroll_runs_status_check CHECK(status IN ('draft','confirmed','cancelled'));
ALTER TABLE public.hr_payroll_runs DROP CONSTRAINT IF EXISTS hr_payroll_runs_month_company_type_key;
CREATE UNIQUE INDEX IF NOT EXISTS hr_payroll_legacy_month_unique ON public.hr_payroll_runs(payroll_month,company_id,payroll_type) WHERE schedule_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hr_payroll_schedule_period_unique ON public.hr_payroll_runs(company_id,payroll_type,schedule_id,period_start,period_end) WHERE schedule_id IS NOT NULL;
ALTER TABLE public.hr_payroll_runs DROP CONSTRAINT IF EXISTS hr_payroll_period_bounds;
ALTER TABLE public.hr_payroll_runs ADD CONSTRAINT hr_payroll_period_bounds CHECK(schedule_id IS NULL OR (period_start IS NOT NULL AND period_end IS NOT NULL AND period_end>=period_start AND period_end-period_start<366));
ALTER TABLE public.hr_payroll_items ADD COLUMN IF NOT EXISTS earning_dates DATE[], ADD COLUMN IF NOT EXISTS deduction_allocations JSONB;

CREATE TABLE IF NOT EXISTS public.hr_payroll_wage_reservations (
  company_id UUID NOT NULL REFERENCES public.hr_companies(id), employee_id UUID NOT NULL REFERENCES public.hr_employees(id),
  work_date DATE NOT NULL, payroll_run_id UUID NOT NULL REFERENCES public.hr_payroll_runs(id),
  payroll_item_id UUID NOT NULL REFERENCES public.hr_payroll_items(id),
  PRIMARY KEY(company_id,employee_id,work_date)
);
CREATE TABLE IF NOT EXISTS public.hr_payroll_monthly_allocations (
  payroll_item_id UUID NOT NULL REFERENCES public.hr_payroll_items(id), payroll_run_id UUID NOT NULL REFERENCES public.hr_payroll_runs(id),
  company_id UUID NOT NULL REFERENCES public.hr_companies(id), employee_id UUID NOT NULL REFERENCES public.hr_employees(id),
  earning_month DATE NOT NULL, amounts JSONB NOT NULL, PRIMARY KEY(payroll_item_id,earning_month)
);
ALTER TABLE public.hr_payroll_wage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_payroll_monthly_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_payroll_reservations_read ON public.hr_payroll_wage_reservations;
CREATE POLICY hr_payroll_reservations_read ON public.hr_payroll_wage_reservations FOR SELECT TO authenticated USING(public.hr_payroll_role_allowed());
DROP POLICY IF EXISTS hr_payroll_allocations_read ON public.hr_payroll_monthly_allocations;
CREATE POLICY hr_payroll_allocations_read ON public.hr_payroll_monthly_allocations FOR SELECT TO authenticated USING(public.hr_payroll_role_allowed());
REVOKE ALL ON public.hr_payroll_wage_reservations,public.hr_payroll_monthly_allocations FROM authenticated,anon;
GRANT SELECT ON public.hr_payroll_wage_reservations,public.hr_payroll_monthly_allocations TO authenticated;

CREATE OR REPLACE FUNCTION public.hr_payroll_claim_dates(p_item JSONB,p_start DATE,p_end DATE) RETURNS DATE[] LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE result DATE[];
BEGIN
  IF jsonb_typeof(p_item->'earning_dates')='array' THEN
    SELECT array_agg(DISTINCT value::date) INTO result FROM jsonb_array_elements_text(p_item->'earning_dates');
  ELSIF p_item->>'pay_type'='daily' AND jsonb_typeof(p_item->'daily_wage_details')='array' AND jsonb_array_length(p_item->'daily_wage_details')>0 THEN
    SELECT array_agg(DISTINCT (d->>'workDate')::date) INTO result FROM jsonb_array_elements(p_item->'daily_wage_details') d;
  ELSIF jsonb_typeof(p_item->'monthly_wage_details')='array' AND jsonb_array_length(p_item->'monthly_wage_details')>0 THEN
    SELECT array_agg(DISTINCT day::date) INTO result FROM jsonb_array_elements(p_item->'monthly_wage_details') d
      CROSS JOIN LATERAL generate_series((d->>'startDate')::date,(d->>'endDate')::date,interval '1 day') day;
  ELSE SELECT array_agg(day::date) INTO result FROM generate_series(p_start,p_end,interval '1 day') day;
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(result) day WHERE day<p_start OR day>p_end) THEN RAISE EXCEPTION 'วันที่ค่าจ้างอยู่นอกช่วงงวด'; END IF;
  RETURN COALESCE(result,ARRAY[]::date[]);
END;
$$;

-- Preserve legacy financial rows. Stop, rather than choosing an arbitrary owner,
-- if existing confirmed payroll already contains overlapping paid dates.
DO $$ DECLARE r RECORD; d DATE; amounts JSONB; BEGIN
  FOR r IN SELECT i.*,p.company_id,p.payroll_month FROM public.hr_payroll_items i JOIN public.hr_payroll_runs p ON p.id=i.payroll_run_id
    WHERE p.status='confirmed' AND NOT EXISTS(SELECT 1 FROM public.hr_payroll_monthly_allocations a WHERE a.payroll_item_id=i.id) LOOP
    FOREACH d IN ARRAY public.hr_payroll_paid_dates(to_jsonb(r),r.payroll_month) LOOP
      IF EXISTS(SELECT 1 FROM public.hr_payroll_wage_reservations WHERE company_id=r.company_id AND employee_id=r.employee_id AND work_date=d AND payroll_item_id<>r.id) THEN
        RAISE EXCEPTION 'พบข้อมูลยืนยันซ้ำเดิมของพนักงาน % วันที่ % กรุณาทบทวนก่อนติดตั้งระบบรอบจ่าย',r.employee_code,d;
      END IF;
      INSERT INTO public.hr_payroll_wage_reservations VALUES(r.company_id,r.employee_id,d,r.payroll_run_id,r.id) ON CONFLICT DO NOTHING;
    END LOOP;
    SELECT jsonb_object_agg(key,value) INTO amounts FROM jsonb_each(to_jsonb(r)) WHERE key=ANY(ARRAY['base_salary','position_allowance','overtime_pay','other_income','personal_tax','social_security','ewf','savings','student_loan','company_loan','leave_deduction','other_deduction']);
    INSERT INTO public.hr_payroll_monthly_allocations VALUES(r.id,r.payroll_run_id,r.company_id,r.employee_id,r.payroll_month,amounts) ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.hr_payroll_run_version() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.version:=OLD.version+1; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS zzz_hr_payroll_run_version ON public.hr_payroll_runs;
CREATE TRIGGER zzz_hr_payroll_run_version BEFORE UPDATE ON public.hr_payroll_runs FOR EACH ROW EXECUTE FUNCTION public.hr_payroll_run_version();

-- Membership is now per earning date, so distinct weekly/daily windows can
-- legitimately belong to the same employee in the same calendar month.
CREATE OR REPLACE FUNCTION public.hr_payroll_monthly_membership() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.hr_payroll_runs; other RECORD; dates DATE[];
BEGIN
  SELECT * INTO r FROM public.hr_payroll_runs WHERE id=NEW.payroll_run_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(r.company_id::text || ':payroll',0));
  IF r.payroll_type NOT IN ('permanent','monthly_uninsured') THEN RETURN NEW; END IF;
  IF NEW.pay_type='daily' OR (NEW.social_security_enabled IS NOT NULL AND NEW.social_security_enabled<>(r.payroll_type='permanent')) THEN RAISE EXCEPTION 'สถานะ สปส. ไม่ตรงกับกลุ่มเงินเดือน'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.hr_employees WHERE id=NEW.employee_id AND company_id=r.company_id) THEN RAISE EXCEPTION 'พนักงานไม่ได้อยู่ในบริษัทของงวด'; END IF;
  dates:=public.hr_payroll_claim_dates(to_jsonb(NEW),COALESCE(r.period_start,r.payroll_month),COALESCE(r.period_end,(r.payroll_month+interval '1 month - 1 day')::date));
  FOR other IN SELECT i.id,x.id run_id,x.status,x.schedule_id,x.payroll_type,x.payroll_month,
      COALESCE(x.period_start,x.payroll_month) start_date,COALESCE(x.period_end,(x.payroll_month+interval '1 month - 1 day')::date) end_date,to_jsonb(i) item
    FROM public.hr_payroll_items i JOIN public.hr_payroll_runs x ON x.id=i.payroll_run_id
    WHERE i.employee_id=NEW.employee_id AND x.company_id=r.company_id AND x.id<>r.id AND x.status<>'cancelled'
      AND x.payroll_type IN ('permanent','monthly_uninsured')
      AND COALESCE(x.period_start,x.payroll_month)<=COALESCE(r.period_end,(r.payroll_month+interval '1 month - 1 day')::date)
      AND COALESCE(x.period_end,(x.payroll_month+interval '1 month - 1 day')::date)>=COALESCE(r.period_start,r.payroll_month) LOOP
    IF public.hr_payroll_claim_dates(other.item,other.start_date,other.end_date) && dates THEN
      IF other.status='confirmed' THEN RAISE EXCEPTION 'พนักงานคนนี้ยืนยันค่าจ้างช่วงวันเดียวกันแล้ว'; END IF;
      IF TG_OP='UPDATE' AND other.id=OLD.id THEN CONTINUE; END IF;
      IF other.schedule_id IS NULL AND r.schedule_id IS NULL AND other.payroll_month=r.payroll_month AND other.payroll_type<>r.payroll_type THEN
        DELETE FROM public.hr_payroll_items WHERE id=other.id;
      ELSE RAISE EXCEPTION 'มีงวดร่างซ้อนช่วงวัน กรุณาทบทวนหรือยกเลิกร่างเดิมก่อน'; END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.hr_payroll_confirm_no_overlap() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE i RECORD; d DATE; dates DATE[]; allocation JSONB; month DATE; field TEXT; total NUMERIC; previous NUMERIC; limit_amount NUMERIC; wage NUMERIC; emp public.hr_employees; schedule public.hr_pay_schedules;
  start_date DATE:=COALESCE(NEW.period_start,NEW.payroll_month); end_date DATE:=COALESCE(NEW.period_end,(NEW.payroll_month+interval '1 month - 1 day')::date);
  money_keys TEXT[]:=ARRAY['base_salary','position_allowance','overtime_pay','other_income','personal_tax','social_security','ewf','savings','student_loan','company_loan','leave_deduction','other_deduction'];
BEGIN
  IF NEW.status<>'confirmed' OR OLD.status='confirmed' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text || ':payroll',0));
  SELECT * INTO schedule FROM public.hr_pay_schedules WHERE id=COALESCE(NEW.schedule_id,'00000000-0000-4000-8000-000000000001');
  IF (NEW.schedule_id IS NOT NULL OR NEW.payment_tracking_state='managed') AND (now() AT TIME ZONE 'Asia/Bangkok')<(end_date+schedule.cutoff_time) THEN RAISE EXCEPTION 'ยังไม่ถึงเวลาปิดงวดค่าจ้าง'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.hr_payroll_items WHERE payroll_run_id=NEW.id) THEN RAISE EXCEPTION 'ไม่สามารถยืนยันงวดที่ไม่มีพนักงาน'; END IF;
  FOR i IN SELECT * FROM public.hr_payroll_items WHERE payroll_run_id=NEW.id LOOP
    IF i.reviewed_at IS NULL OR COALESCE(i.unresolved_attendance_days,0)>0 THEN RAISE EXCEPTION 'กรุณาตรวจสลิปและเวลาเข้าออกให้ครบก่อนยืนยัน'; END IF;
    dates:=public.hr_payroll_claim_dates(to_jsonb(i),start_date,end_date);
    IF cardinality(dates)=0 THEN RAISE EXCEPTION 'ไม่พบวันที่สิทธิ์ค่าจ้างของพนักงาน %',i.employee_code; END IF;
    FOREACH d IN ARRAY dates LOOP
      IF public.hr_pay_schedule_at(i.employee_id,d)<>COALESCE(NEW.schedule_id,'00000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'รอบจ่ายของพนักงาน % เปลี่ยนแล้ว ให้จัดทำจากเมนูรอบจ่ายและโหลดใหม่',i.employee_code; END IF;
      IF EXISTS(SELECT 1 FROM public.hr_payroll_wage_reservations WHERE company_id=NEW.company_id AND employee_id=i.employee_id AND work_date=d AND payroll_item_id<>i.id) THEN RAISE EXCEPTION 'พนักงาน % มีค่าจ้างยืนยันแล้ววันที่ % กรุณาปรับปรุงรายการเดิมเพื่อไม่ให้จ่ายซ้ำ',i.employee_code,d; END IF;
      INSERT INTO public.hr_payroll_wage_reservations VALUES(NEW.company_id,i.employee_id,d,NEW.id,i.id) ON CONFLICT DO NOTHING;
    END LOOP;
    allocation:=i.deduction_allocations;
    IF allocation IS NULL THEN allocation:=jsonb_build_object(to_char(NEW.payroll_month,'YYYY-MM'),to_jsonb(i)); END IF;
    IF jsonb_typeof(allocation)<>'object' OR NOT EXISTS(SELECT 1 FROM jsonb_each(allocation)) THEN RAISE EXCEPTION 'ไม่พบการจัดสรรยอดตามเดือน'; END IF;
    FOREACH field IN ARRAY money_keys LOOP
      SELECT COALESCE(sum(COALESCE((value->>field)::numeric,0)),0) INTO total FROM jsonb_each(allocation);
      IF round(total,2)<>round(COALESCE((to_jsonb(i)->>field)::numeric,0),2) THEN RAISE EXCEPTION 'ยอดจัดสรร % ไม่ตรงกับสลิป',field; END IF;
    END LOOP;
    FOR month,allocation IN SELECT (key||'-01')::date,value FROM jsonb_each(allocation) LOOP
      IF month<date_trunc('month',start_date)::date OR month>date_trunc('month',end_date)::date THEN RAISE EXCEPTION 'เดือนจัดสรรอยู่นอกงวด'; END IF;
      SELECT * INTO emp FROM public.hr_employees WHERE id=i.employee_id;
      IF NEW.schedule_id IS NOT NULL THEN
        IF i.social_security_enabled=false AND COALESCE((allocation->>'social_security')::numeric,0)<>0 THEN RAISE EXCEPTION 'พนักงานไม่เข้า สปส. ต้องไม่หักประกันสังคม'; END IF;
        FOREACH field IN ARRAY ARRAY['personal_tax','savings','student_loan','company_loan'] LOOP
          SELECT COALESCE(sum(COALESCE((amounts->>field)::numeric,0)),0) INTO previous FROM public.hr_payroll_effective_monthly_allocations WHERE company_id=NEW.company_id AND employee_id=i.employee_id AND earning_month=month AND payroll_item_id<>i.id;
          limit_amount:=CASE field WHEN 'personal_tax' THEN COALESCE(emp.monthly_personal_tax,0) WHEN 'savings' THEN COALESCE(emp.monthly_savings,0) WHEN 'student_loan' THEN COALESCE(emp.monthly_student_loan,0) ELSE COALESCE(emp.monthly_company_loan,0) END;
          IF COALESCE((allocation->>field)::numeric,0)>0 AND previous+(allocation->>field)::numeric>GREATEST(previous,limit_amount)+0.001 THEN RAISE EXCEPTION 'ยอดหัก % เกินกำหนดรายเดือน กรุณาโหลดข้อมูลล่าสุด',field; END IF;
        END LOOP;
        FOREACH field IN ARRAY ARRAY['savings','company_loan'] LOOP
          SELECT COALESCE(sum(COALESCE((amounts->>field)::numeric,0)),0) INTO previous FROM public.hr_payroll_effective_monthly_allocations WHERE company_id=NEW.company_id AND employee_id=i.employee_id AND payroll_item_id<>i.id;
          IF field='savings' THEN limit_amount:=CASE WHEN emp.savings_maximum IS NULL THEN NULL ELSE GREATEST(0,emp.savings_maximum-COALESCE(emp.savings_opening_balance,0)) END;
          ELSE limit_amount:=GREATEST(0,COALESCE(emp.company_loan_opening_balance,0)); END IF;
          IF limit_amount IS NOT NULL AND COALESCE((allocation->>field)::numeric,0)>0 AND previous+(allocation->>field)::numeric>GREATEST(previous,limit_amount)+0.001 THEN RAISE EXCEPTION 'ยอดหัก % เกินยอดคงเหลือ',field; END IF;
        END LOOP;
        SELECT COALESCE(sum(COALESCE((amounts->>'social_security')::numeric,0)),0),COALESCE(sum(COALESCE((amounts->>'base_salary')::numeric,0)),0)
          INTO previous,wage FROM public.hr_payroll_effective_monthly_allocations WHERE company_id=NEW.company_id AND employee_id=i.employee_id AND earning_month=month AND payroll_item_id<>i.id;
        SELECT round(LEAST(wage+COALESCE((allocation->>'base_salary')::numeric,0),maximum_wage_base)*contribution_rate/100,2) INTO limit_amount FROM public.hr_social_security_settings WHERE id=true;
        IF COALESCE((allocation->>'social_security')::numeric,0)>0 AND previous+(allocation->>'social_security')::numeric>GREATEST(previous,COALESCE(limit_amount,round(LEAST(wage+COALESCE((allocation->>'base_salary')::numeric,0),17500)*0.05,2)))+0.001 THEN RAISE EXCEPTION 'ยอด สปส. เกินยอดสะสมรายเดือน กรุณาโหลดข้อมูลใหม่'; END IF;
        SELECT COALESCE(sum(COALESCE((amounts->>'ewf')::numeric,0)),0),COALESCE(sum(COALESCE((amounts->>'base_salary')::numeric,0)+COALESCE((amounts->>'position_allowance')::numeric,0)),0)
          INTO previous,wage FROM public.hr_payroll_effective_monthly_allocations WHERE company_id=NEW.company_id AND employee_id=i.employee_id AND earning_month=month AND payroll_item_id<>i.id;
        limit_amount:=CASE WHEN upper(trim(i.employee_code))='EMP00001' OR EXISTS(SELECT 1 FROM public.hr_companies WHERE id=NEW.company_id AND ewf_enabled=false) THEN 0
          ELSE round((wage+COALESCE((allocation->>'base_salary')::numeric,0)+COALESCE((allocation->>'position_allowance')::numeric,0))*0.0025,2) END;
        IF COALESCE((allocation->>'ewf')::numeric,0)>0 AND previous+(allocation->>'ewf')::numeric>GREATEST(previous,limit_amount)+0.001 THEN RAISE EXCEPTION 'ยอด EWF เกินยอดสะสมรายเดือน กรุณาโหลดข้อมูลใหม่'; END IF;
      END IF;
      INSERT INTO public.hr_payroll_monthly_allocations VALUES(i.id,NEW.id,NEW.company_id,i.employee_id,month,allocation)
        ON CONFLICT(payroll_item_id,earning_month) DO UPDATE SET amounts=EXCLUDED.amounts;
    END LOOP;
  END LOOP;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.hr_save_payroll_period(p_run JSONB,p_items JSONB,p_confirm BOOLEAN DEFAULT false,p_expected_version INT DEFAULT 0)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.hr_payroll_runs; company UUID:=(p_run->>'company_id')::uuid; selected_schedule UUID:=NULLIF(p_run->>'schedule_id','')::uuid;
  start_date DATE:=(p_run->>'period_start')::date; end_date DATE:=(p_run->>'period_end')::date;
  kind TEXT:=p_run->>'payroll_type'; item JSONB; payload JSONB; columns TEXT; assignments TEXT; result JSONB; finance_key TEXT; definition public.hr_pay_schedules; first_date DATE; last_date DATE; previous_last DATE; cutoff DATE; second_cutoff DATE;
  safe_keys TEXT[]:=ARRAY['payroll_run_id','employee_id','employee_code','employee_name','employee_nickname','department_position','base_salary','position_allowance','ot_normal_hours','ot_holiday_hours','overtime_pay','pay_type','daily_rate','full_days','half_days','paid_holiday_days','unpaid_leave_days','payable_days','unresolved_attendance_days','daily_wage_details','personal_tax','social_security','ewf','savings','student_loan','company_loan','leave_deduction','other_income','other_deduction','income_opening_balance','personal_tax_opening_balance','social_security_opening_balance','ewf_opening_balance','student_loan_opening_balance','savings_opening_balance','company_loan_opening_balance','company_loan_opening_installments','reviewed_at','reviewed_by','company_snapshot','social_security_enabled','monthly_rate','monthly_payable_days','monthly_wage_details','earning_dates','deduction_allocations'];
BEGIN
  IF NOT public.hr_payroll_role_allowed() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์จัดทำเงินเดือน'; END IF;
  IF company IS NULL OR kind IS NULL OR kind NOT IN ('permanent','monthly_uninsured','daily') OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
    OR p_expected_version IS NULL OR p_expected_version<0 THEN RAISE EXCEPTION 'ข้อมูลงวดไม่ถูกต้อง'; END IF;
  IF start_date IS NULL OR end_date IS NULL OR end_date<start_date OR end_date-start_date>=366 THEN RAISE EXCEPTION 'ช่วงวันที่งวดไม่ถูกต้อง'; END IF;
  IF selected_schedule IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.hr_pay_schedules WHERE id=selected_schedule AND is_active AND (company_id IS NULL OR company_id=company)) THEN RAISE EXCEPTION 'รอบจ่ายปิดใช้งานหรืออยู่คนละบริษัท'; END IF;
  IF selected_schedule IS NOT NULL THEN
    SELECT * INTO definition FROM public.hr_pay_schedules WHERE id=selected_schedule;
    first_date:=date_trunc('month',end_date)::date; last_date:=(first_date+interval '1 month - 1 day')::date;
    previous_last:=first_date-1;
    cutoff:=first_date+LEAST(definition.first_day,extract(day FROM last_date)::int)-1;
    second_cutoff:=CASE WHEN definition.second_day IS NULL THEN last_date ELSE first_date+LEAST(definition.second_day,extract(day FROM last_date)::int)-1 END;
    IF (definition.frequency='daily' AND start_date<>end_date)
      OR (definition.frequency='weekly' AND (end_date-start_date<>6 OR extract(isodow FROM end_date+1)::int<>definition.weekday))
      OR (definition.frequency='monthly' AND (start_date<>first_date OR end_date<>last_date))
      OR (definition.frequency='semimonthly' AND NOT (
        (end_date=cutoff AND start_date=CASE WHEN definition.second_day IS NULL THEN first_date ELSE date_trunc('month',previous_last)::date+LEAST(definition.second_day,extract(day FROM previous_last)::int) END)
        OR (start_date=cutoff+1 AND end_date=second_cutoff))) THEN
      RAISE EXCEPTION 'ช่วงวันที่ไม่ตรงกับรอบจ่ายที่กำหนด';
    END IF;
  END IF;
  IF selected_schedule IS NULL AND (start_date<>date_trunc('month',start_date)::date OR end_date<>(start_date+interval '1 month - 1 day')::date) THEN RAISE EXCEPTION 'งวดเดิมต้องเป็นช่วงเดือนเต็ม'; END IF;
  IF jsonb_array_length(p_items)<>(SELECT count(DISTINCT value->>'employee_id') FROM jsonb_array_elements(p_items)) THEN RAISE EXCEPTION 'รายชื่อพนักงานซ้ำ'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(company::text || ':payroll',0));
  SELECT * INTO r FROM public.hr_payroll_runs WHERE company_id=company AND payroll_type=kind
    AND schedule_id IS NOT DISTINCT FROM selected_schedule
    AND COALESCE(period_start,payroll_month)=start_date AND COALESCE(period_end,(payroll_month+interval '1 month - 1 day')::date)=end_date FOR UPDATE;
  IF FOUND THEN
    IF r.status='confirmed' THEN RAISE EXCEPTION 'งวดยืนยันแล้ว กรุณาเปิดปรับปรุงก่อน'; END IF;
    IF r.version<>p_expected_version THEN RAISE EXCEPTION 'ข้อมูลถูกแก้ไขโดยผู้ใช้อื่น กรุณาโหลดใหม่ก่อนบันทึก'; END IF;
    IF r.status='cancelled' THEN
      INSERT INTO public.hr_payroll_revisions(payroll_run_id,reason,run_before,items_before,created_by)
        SELECT r.id,'จัดทำใหม่หลังยกเลิกร่าง',to_jsonb(r),COALESCE(jsonb_agg(to_jsonb(i)),'[]'),auth.uid() FROM public.hr_payroll_items i WHERE i.payroll_run_id=r.id;
    END IF;
    UPDATE public.hr_payroll_runs SET status='draft',payment_date=NULLIF(p_run->>'payment_date','')::date,confirmed_at=NULL,confirmed_by=NULL,updated_at=now() WHERE id=r.id RETURNING * INTO r;
  ELSE
    IF p_expected_version<>0 THEN RAISE EXCEPTION 'ไม่พบงวดเดิม กรุณาโหลดใหม่'; END IF;
    INSERT INTO public.hr_payroll_runs(company_id,payroll_month,payroll_type,schedule_id,period_start,period_end,schedule_snapshot,payment_date,status)
      VALUES(company,date_trunc('month',start_date)::date,kind,selected_schedule,CASE WHEN selected_schedule IS NULL THEN NULL ELSE start_date END,
        CASE WHEN selected_schedule IS NULL THEN NULL ELSE end_date END,(SELECT to_jsonb(s) FROM public.hr_pay_schedules s WHERE id=COALESCE(selected_schedule,'00000000-0000-4000-8000-000000000001')),
        NULLIF(p_run->>'payment_date','')::date,'draft') RETURNING * INTO r;
  END IF;
  SELECT string_agg(quote_ident(attname),',' ORDER BY attnum),string_agg(format('%I=EXCLUDED.%I',attname,attname),',' ORDER BY attnum)
    INTO columns,assignments FROM pg_attribute WHERE attrelid='public.hr_payroll_items'::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' AND attname=ANY(safe_keys);
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.hr_employees WHERE id=(item->>'employee_id')::uuid AND company_id=company) THEN RAISE EXCEPTION 'พนักงานไม่ได้อยู่ในบริษัทนี้'; END IF;
    payload:='{}';
    FOREACH finance_key IN ARRAY ARRAY['base_salary','position_allowance','ot_normal_hours','ot_holiday_hours','overtime_pay','daily_rate','full_days','half_days','paid_holiday_days','unpaid_leave_days','payable_days','unresolved_attendance_days','personal_tax','social_security','ewf','savings','student_loan','company_loan','leave_deduction','other_income','other_deduction','income_opening_balance','personal_tax_opening_balance','social_security_opening_balance','ewf_opening_balance','student_loan_opening_balance','savings_opening_balance','company_loan_opening_balance','company_loan_opening_installments'] LOOP
      IF COALESCE(item->>finance_key,'0') IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'จำนวนเงินไม่ถูกต้อง'; END IF;
      payload:=payload||jsonb_build_object(finance_key,COALESCE((item->>finance_key)::numeric,0));
      IF (payload->>finance_key)::numeric<0 THEN RAISE EXCEPTION 'ยอดเงินและจำนวนวันต้องไม่ติดลบ'; END IF;
    END LOOP;
    payload:=item||payload||jsonb_build_object('payroll_run_id',r.id,'company_snapshot',(SELECT to_jsonb(c) FROM public.hr_companies c WHERE c.id=company),'pay_type',CASE WHEN kind='daily' THEN 'daily' ELSE 'permanent' END,'daily_wage_details',COALESCE(item->'daily_wage_details','[]'::jsonb));
    EXECUTE format('INSERT INTO public.hr_payroll_items(%s) SELECT %s FROM jsonb_populate_record(NULL::public.hr_payroll_items,$1) ON CONFLICT(payroll_run_id,employee_id) DO UPDATE SET %s',columns,columns,assignments) USING payload;
  END LOOP;
  DELETE FROM public.hr_payroll_items WHERE payroll_run_id=r.id AND employee_id NOT IN(SELECT (value->>'employee_id')::uuid FROM jsonb_array_elements(p_items));
  IF p_confirm THEN
    UPDATE public.hr_payroll_runs SET status='confirmed',confirmed_at=now(),confirmed_by=auth.uid(),updated_at=now() WHERE id=r.id RETURNING * INTO r;
  END IF;
  SELECT to_jsonb(r)||jsonb_build_object('company',(SELECT to_jsonb(c) FROM public.hr_companies c WHERE c.id=company),
    'items',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.employee_code) FROM public.hr_payroll_items i WHERE i.payroll_run_id=r.id),'[]')) INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hr_save_payroll_period(JSONB,JSONB,BOOLEAN,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_save_payroll_period(JSONB,JSONB,BOOLEAN,INT) TO authenticated;
REVOKE INSERT,UPDATE,DELETE ON public.hr_payroll_runs,public.hr_payroll_items FROM authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
