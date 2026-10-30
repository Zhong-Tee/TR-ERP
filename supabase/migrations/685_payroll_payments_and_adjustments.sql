BEGIN;
CREATE TABLE IF NOT EXISTS public.hr_payroll_payment_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), request_key UUID NOT NULL UNIQUE,
  company_id UUID NOT NULL REFERENCES public.hr_companies(id), payload JSONB NOT NULL,
  paid_date DATE NOT NULL, channel TEXT NOT NULL CHECK(channel IN ('bank','cash','other','offset')),
  reference TEXT NOT NULL CHECK(length(trim(reference))>0), evidence_url TEXT,
  created_by UUID NOT NULL REFERENCES public.us_users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(evidence_url IS NULL OR evidence_url ~ '^https://')
);
CREATE TABLE IF NOT EXISTS public.hr_payroll_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), request_key UUID NOT NULL UNIQUE,
  source_item_id UUID NOT NULL REFERENCES public.hr_payroll_items(id),
  company_id UUID NOT NULL REFERENCES public.hr_companies(id), employee_id UUID NOT NULL REFERENCES public.hr_employees(id),
  earning_month DATE NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason))>0),
  previous_amounts JSONB NOT NULL, corrected_amounts JSONB NOT NULL, deltas JSONB NOT NULL,
  deduction_allocations JSONB NOT NULL DEFAULT '{}',
  income_delta NUMERIC(12,2) NOT NULL, deduction_delta NUMERIC(12,2) NOT NULL, net_delta NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('approved','cancelled')),
  cancelled_reason TEXT, cancelled_by UUID REFERENCES public.us_users(id), cancelled_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES public.us_users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.hr_payroll_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), batch_id UUID NOT NULL REFERENCES public.hr_payroll_payment_batches(id),
  company_id UUID NOT NULL REFERENCES public.hr_companies(id), employee_id UUID NOT NULL REFERENCES public.hr_employees(id),
  payroll_item_id UUID UNIQUE REFERENCES public.hr_payroll_items(id), adjustment_id UUID UNIQUE REFERENCES public.hr_payroll_adjustments(id),
  amount NUMERIC(12,2) NOT NULL, snapshot JSONB NOT NULL,
  CHECK((payroll_item_id IS NOT NULL)::int+(adjustment_id IS NOT NULL)::int=1)
);
ALTER TABLE public.hr_payroll_payment_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_payroll_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_payroll_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_payroll_payment_batches_read ON public.hr_payroll_payment_batches;
CREATE POLICY hr_payroll_payment_batches_read ON public.hr_payroll_payment_batches FOR SELECT TO authenticated USING(public.hr_payroll_role_allowed());
DROP POLICY IF EXISTS hr_payroll_payments_read ON public.hr_payroll_payments;
CREATE POLICY hr_payroll_payments_read ON public.hr_payroll_payments FOR SELECT TO authenticated USING(public.hr_payroll_role_allowed());
DROP POLICY IF EXISTS hr_payroll_adjustments_read ON public.hr_payroll_adjustments;
CREATE POLICY hr_payroll_adjustments_read ON public.hr_payroll_adjustments FOR SELECT TO authenticated USING(public.hr_payroll_role_allowed());
REVOKE ALL ON public.hr_payroll_payment_batches,public.hr_payroll_adjustments,public.hr_payroll_payments FROM anon,authenticated;
GRANT SELECT ON public.hr_payroll_payment_batches,public.hr_payroll_adjustments,public.hr_payroll_payments TO authenticated;

CREATE OR REPLACE VIEW public.hr_payroll_effective_monthly_allocations WITH(security_invoker=true) AS
  SELECT a.*,a.payroll_item_id::text||':'||a.earning_month::text AS allocation_key FROM public.hr_payroll_monthly_allocations a
  UNION ALL
  SELECT a.source_item_id,i.payroll_run_id,a.company_id,a.employee_id,(m.key||'-01')::date,m.value,'adjustment:'||a.id::text||':'||m.key
    FROM public.hr_payroll_adjustments a JOIN public.hr_payroll_items i ON i.id=a.source_item_id
    CROSS JOIN LATERAL jsonb_each(a.deduction_allocations) m WHERE a.status='approved';
GRANT SELECT ON public.hr_payroll_effective_monthly_allocations TO authenticated;

CREATE OR REPLACE FUNCTION public.hr_guard_paid_payroll() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.status='confirmed' AND NEW.status='draft' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(OLD.company_id::text || ':payroll',0));
    IF EXISTS(SELECT 1 FROM public.hr_payroll_payments p JOIN public.hr_payroll_items i ON i.id=p.payroll_item_id WHERE i.payroll_run_id=OLD.id) THEN
      RAISE EXCEPTION 'มีรายการจ่ายเงินจริงแล้ว ให้สร้างรายการปรับเพิ่ม/ลดโดยอ้างอิงรายการเดิม';
    END IF;
    DELETE FROM public.hr_payroll_wage_reservations WHERE payroll_run_id=OLD.id;
    DELETE FROM public.hr_payroll_monthly_allocations WHERE payroll_run_id=OLD.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS aaa_hr_guard_paid_payroll ON public.hr_payroll_runs;
CREATE TRIGGER aaa_hr_guard_paid_payroll BEFORE UPDATE ON public.hr_payroll_runs FOR EACH ROW EXECUTE FUNCTION public.hr_guard_paid_payroll();

CREATE OR REPLACE FUNCTION public.hr_reopen_payroll(p_run UUID,p_reason TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.hr_payroll_runs; company UUID;
BEGIN
  IF NOT public.hr_payroll_role_allowed() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ปรับปรุงงวด'; END IF;
  IF NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผล'; END IF;
  SELECT company_id INTO company FROM public.hr_payroll_runs WHERE id=p_run;
  PERFORM pg_advisory_xact_lock(hashtextextended(company::text || ':payroll',0));
  SELECT * INTO r FROM public.hr_payroll_runs WHERE id=p_run FOR UPDATE;
  IF NOT FOUND OR r.status<>'confirmed' THEN RAISE EXCEPTION 'เปิดปรับปรุงได้เฉพาะงวดยืนยันที่ยังไม่จ่าย'; END IF;
  INSERT INTO public.hr_payroll_revisions(payroll_run_id,reason,run_before,items_before,created_by)
    SELECT r.id,trim(p_reason),to_jsonb(r),COALESCE(jsonb_agg(to_jsonb(i)),'[]'),auth.uid() FROM public.hr_payroll_items i WHERE payroll_run_id=r.id;
  UPDATE public.hr_payroll_runs SET status='draft',confirmed_at=NULL,confirmed_by=NULL,updated_at=now() WHERE id=r.id;
  UPDATE public.hr_payroll_items SET reviewed_at=NULL,reviewed_by=NULL WHERE payroll_run_id=r.id;
END $$;
REVOKE ALL ON FUNCTION public.hr_reopen_payroll(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_reopen_payroll(UUID,TEXT) TO authenticated;
CREATE OR REPLACE FUNCTION public.hr_reopen_daily_payroll(p_run UUID,p_reason TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN PERFORM public.hr_reopen_payroll(p_run,p_reason); END $$;
CREATE OR REPLACE FUNCTION public.hr_reopen_monthly_payroll(p_run UUID,p_reason TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN PERFORM public.hr_reopen_payroll(p_run,p_reason); END $$;

CREATE OR REPLACE FUNCTION public.hr_cancel_payroll(p_run UUID,p_reason TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.hr_payroll_runs; company UUID;
BEGIN
  IF NOT public.hr_payroll_role_allowed() OR NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'ไม่มีสิทธิ์หรือยังไม่ระบุเหตุผล'; END IF;
  SELECT company_id INTO company FROM public.hr_payroll_runs WHERE id=p_run;
  PERFORM pg_advisory_xact_lock(hashtextextended(company::text || ':payroll',0));
  SELECT * INTO r FROM public.hr_payroll_runs WHERE id=p_run FOR UPDATE;
  IF NOT FOUND OR r.status='cancelled' THEN RAISE EXCEPTION 'ไม่พบงวดที่ยกเลิกได้'; END IF;
  IF r.status='confirmed' THEN PERFORM public.hr_reopen_payroll(p_run,p_reason); END IF;
  INSERT INTO public.hr_payroll_revisions(payroll_run_id,reason,run_before,items_before,created_by)
    SELECT r.id,'ยกเลิกงวด: '||trim(p_reason),to_jsonb(r),COALESCE(jsonb_agg(to_jsonb(i)),'[]'),auth.uid() FROM public.hr_payroll_items i WHERE payroll_run_id=r.id;
  UPDATE public.hr_payroll_runs SET status='cancelled',updated_at=now() WHERE id=r.id;
END $$;
REVOKE ALL ON FUNCTION public.hr_cancel_payroll(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_cancel_payroll(UUID,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.hr_record_payroll_payment(p_request UUID,p_run UUID,p_items JSONB,p_adjustments UUID[],p_paid_date DATE,p_channel TEXT,p_reference TEXT,p_evidence_url TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE company UUID; batch public.hr_payroll_payment_batches; payload JSONB; item RECORD; adjustment public.hr_payroll_adjustments;
  input JSONB; ids UUID[]; adjustment_ids UUID[]:=COALESCE(p_adjustments,ARRAY[]::uuid[]); signs INT[]; result JSONB;
BEGIN
  IF NOT public.hr_payroll_role_allowed() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์บันทึกการจ่าย'; END IF;
  IF p_request IS NULL OR p_paid_date IS NULL OR p_paid_date>(now() AT TIME ZONE 'Asia/Bangkok')::date OR p_channel NOT IN ('bank','cash','other','offset') OR NULLIF(trim(p_reference),'') IS NULL THEN RAISE EXCEPTION 'กรุณาตรวจวันจ่าย ช่องทาง และเลขอ้างอิง'; END IF;
  IF p_evidence_url IS NOT NULL AND p_evidence_url !~ '^https://' THEN RAISE EXCEPTION 'ลิงก์หลักฐานต้องเป็น HTTPS'; END IF;
  IF jsonb_typeof(p_items)<>'array' THEN RAISE EXCEPTION 'ข้อมูลผู้รับเงินไม่ถูกต้อง'; END IF;
  SELECT array_agg(DISTINCT (entry->>'id')::uuid ORDER BY (entry->>'id')::uuid) INTO ids FROM jsonb_array_elements(p_items) entry;
  IF COALESCE(cardinality(ids),0)<>jsonb_array_length(p_items) OR COALESCE(cardinality(ids),0)+cardinality(adjustment_ids)=0 THEN RAISE EXCEPTION 'กรุณาเลือกผู้รับเงินโดยไม่ซ้ำกัน'; END IF;
  IF cardinality(adjustment_ids)<>(SELECT count(DISTINCT id) FROM unnest(adjustment_ids) id) THEN RAISE EXCEPTION 'รายการปรับปรุงซ้ำ'; END IF;
  IF cardinality(ids)>0 THEN SELECT company_id INTO company FROM public.hr_payroll_runs WHERE id=p_run;
  ELSE SELECT company_id INTO company FROM public.hr_payroll_adjustments WHERE id=adjustment_ids[1]; END IF;
  IF company IS NULL THEN RAISE EXCEPTION 'ไม่พบข้อมูลบริษัทของรายการ'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(company::text || ':payroll',0));
  payload:=jsonb_build_object('run',p_run,'items',p_items,'adjustments',adjustment_ids,'date',p_paid_date,'channel',p_channel,'reference',trim(p_reference),'evidence',p_evidence_url);
  SELECT * INTO batch FROM public.hr_payroll_payment_batches WHERE request_key=p_request;
  IF FOUND THEN
    IF batch.payload<>payload OR batch.company_id<>company THEN RAISE EXCEPTION 'รหัสคำขอนี้ถูกใช้กับข้อมูลอื่นแล้ว'; END IF;
    RETURN jsonb_build_object('batch',to_jsonb(batch),'payments',(SELECT jsonb_agg(to_jsonb(p)) FROM public.hr_payroll_payments p WHERE batch_id=batch.id));
  END IF;
  IF cardinality(ids)>0 THEN
    IF NOT EXISTS(SELECT 1 FROM public.hr_payroll_runs WHERE id=p_run AND company_id=company AND status='confirmed') THEN RAISE EXCEPTION 'ต้องยืนยันยอดก่อนบันทึกการจ่าย'; END IF;
    IF (SELECT count(*) FROM public.hr_payroll_items WHERE payroll_run_id=p_run AND id=ANY(ids))<>cardinality(ids) THEN RAISE EXCEPTION 'ผู้รับเงินไม่ได้อยู่ในงวดนี้'; END IF;
  END IF;
  signs:=ARRAY[]::int[];
  FOR input IN SELECT entry FROM jsonb_array_elements(p_items) entry LOOP
    SELECT * INTO item FROM public.hr_payroll_items WHERE id=(input->>'id')::uuid FOR UPDATE;
    IF EXISTS(SELECT 1 FROM public.hr_payroll_payments WHERE payroll_item_id=item.id) THEN RAISE EXCEPTION 'พนักงาน % บันทึกจ่ายแล้ว กรุณาโหลดสถานะล่าสุด',item.employee_code; END IF;
    IF item.net_pay<0 OR item.net_pay IS DISTINCT FROM (input->>'net_pay')::numeric THEN RAISE EXCEPTION 'ยอดสุทธิเปลี่ยนหรือเป็นยอดติดลบ กรุณาทบทวนก่อนจ่าย'; END IF;
    signs:=array_append(signs,sign(item.net_pay)::int);
  END LOOP;
  FOR adjustment IN SELECT * FROM public.hr_payroll_adjustments WHERE id=ANY(adjustment_ids) ORDER BY id FOR UPDATE LOOP
    IF adjustment.company_id<>company OR adjustment.status<>'approved' OR EXISTS(SELECT 1 FROM public.hr_payroll_payments WHERE adjustment_id=adjustment.id) THEN RAISE EXCEPTION 'รายการปรับปรุงถูกยกเลิกหรือบันทึกจ่ายแล้ว'; END IF;
    signs:=array_append(signs,sign(adjustment.net_delta)::int);
  END LOOP;
  IF (SELECT count(*) FROM public.hr_payroll_adjustments WHERE id=ANY(adjustment_ids))<>cardinality(adjustment_ids) THEN RAISE EXCEPTION 'ไม่พบรายการปรับปรุงครบ'; END IF;
  IF 1=ANY(signs) AND -1=ANY(signs) THEN RAISE EXCEPTION 'กรุณาแยกการจ่ายเพิ่มออกจากการรับเงินคืน'; END IF;
  IF p_channel='offset' AND EXISTS(SELECT 1 FROM unnest(signs) sign WHERE sign<>0) THEN RAISE EXCEPTION 'ช่องทางยอดศูนย์ใช้ได้เฉพาะรายการสุทธิศูนย์'; END IF;
  INSERT INTO public.hr_payroll_payment_batches(request_key,company_id,payload,paid_date,channel,reference,evidence_url,created_by)
    VALUES(p_request,company,payload,p_paid_date,p_channel,trim(p_reference),p_evidence_url,auth.uid()) RETURNING * INTO batch;
  INSERT INTO public.hr_payroll_payments(batch_id,company_id,employee_id,payroll_item_id,amount,snapshot)
    SELECT batch.id,company,employee_id,id,net_pay,to_jsonb(i) FROM public.hr_payroll_items i WHERE id=ANY(ids);
  INSERT INTO public.hr_payroll_payments(batch_id,company_id,employee_id,adjustment_id,amount,snapshot)
    SELECT batch.id,company,employee_id,id,net_delta,to_jsonb(a) FROM public.hr_payroll_adjustments a WHERE id=ANY(adjustment_ids);
  SELECT jsonb_build_object('batch',to_jsonb(batch),'payments',jsonb_agg(to_jsonb(p))) INTO result FROM public.hr_payroll_payments p WHERE batch_id=batch.id;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hr_record_payroll_payment(UUID,UUID,JSONB,UUID[],DATE,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_record_payroll_payment(UUID,UUID,JSONB,UUID[],DATE,TEXT,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.hr_create_payroll_adjustment(p_request UUID,p_source UUID,p_corrected JSONB,p_reason TEXT,p_expected_previous JSONB DEFAULT NULL)
RETURNS public.hr_payroll_adjustments LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE source RECORD; existing public.hr_payroll_adjustments; previous JSONB; deltas JSONB:='{}'; field TEXT; current_amount NUMERIC; target NUMERIC; income NUMERIC:=0; deduction NUMERIC:=0; company UUID;
  allocations JSONB:='{}'; source_allocations JSONB; m RECORD; weights NUMERIC[]; months TEXT[]; denominator NUMERIC; cumulative NUMERIC; allocated NUMERIC; next_amount NUMERIC; idx INT;
  income_keys TEXT[]:=ARRAY['base_salary','position_allowance','overtime_pay','other_income'];
  keys TEXT[]:=ARRAY['base_salary','position_allowance','overtime_pay','other_income','personal_tax','social_security','ewf','savings','student_loan','company_loan','leave_deduction','other_deduction'];
BEGIN
  IF NOT public.hr_payroll_role_allowed() OR NULLIF(trim(p_reason),'') IS NULL OR p_request IS NULL THEN RAISE EXCEPTION 'ไม่มีสิทธิ์หรือยังไม่ระบุเหตุผลปรับปรุง'; END IF;
  IF jsonb_typeof(p_corrected) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'ข้อมูลยอดที่ถูกต้องไม่ครบ'; END IF;
  SELECT r.company_id INTO company FROM public.hr_payroll_items i JOIN public.hr_payroll_runs r ON r.id=i.payroll_run_id WHERE i.id=p_source;
  PERFORM pg_advisory_xact_lock(hashtextextended(company::text || ':payroll',0));
  SELECT * INTO existing FROM public.hr_payroll_adjustments WHERE request_key=p_request;
  IF FOUND THEN
    IF existing.source_item_id<>p_source OR existing.corrected_amounts<>p_corrected OR existing.reason<>trim(p_reason) THEN RAISE EXCEPTION 'รหัสคำขอถูกใช้กับข้อมูลอื่น'; END IF;
    RETURN existing;
  END IF;
  SELECT i.*,r.company_id,r.payroll_month INTO source FROM public.hr_payroll_items i JOIN public.hr_payroll_runs r ON r.id=i.payroll_run_id WHERE i.id=p_source FOR UPDATE OF i;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.hr_payroll_payments WHERE payroll_item_id=p_source) THEN RAISE EXCEPTION 'ปรับส่วนต่างได้เฉพาะรายการที่บันทึกจ่ายจริงแล้ว'; END IF;
  IF EXISTS(SELECT 1 FROM public.hr_payroll_adjustments a WHERE a.source_item_id=p_source AND a.status='approved' AND NOT EXISTS(SELECT 1 FROM public.hr_payroll_payments p WHERE p.adjustment_id=a.id)) THEN RAISE EXCEPTION 'มีรายการปรับปรุงรอจ่ายอยู่ กรุณาจ่ายหรือยกเลิกรายการนั้นก่อน'; END IF;
  previous:=to_jsonb(source);
  FOREACH field IN ARRAY keys LOOP
    IF p_corrected->>field IS NULL OR p_corrected->>field IN ('NaN','Infinity','-Infinity') OR (p_corrected->>field)::numeric<0 THEN RAISE EXCEPTION 'ยอดที่ถูกต้องของ % ไม่ครบหรือเป็นค่าติดลบ',field; END IF;
    SELECT COALESCE(sum((a.deltas->>field)::numeric),0) INTO current_amount FROM public.hr_payroll_adjustments a WHERE a.source_item_id=p_source AND a.status='approved';
    current_amount:=COALESCE((to_jsonb(source)->>field)::numeric,0)+current_amount;
    IF p_expected_previous IS NOT NULL AND current_amount IS DISTINCT FROM (p_expected_previous->>field)::numeric THEN RAISE EXCEPTION 'มีผู้ใช้อื่นปรับยอดแล้ว กรุณาโหลดข้อมูลล่าสุด'; END IF;
    target:=round((p_corrected->>field)::numeric,2);
    previous:=previous||jsonb_build_object(field,current_amount);
    deltas:=deltas||jsonb_build_object(field,round(target-current_amount,2));
    IF field=ANY(income_keys) THEN income:=income+target-current_amount; ELSE deduction:=deduction+target-current_amount; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM jsonb_each_text(deltas) WHERE value::numeric<>0) THEN RAISE EXCEPTION 'ยอดนี้ได้รับการปรับปรุงแล้ว ไม่มีส่วนต่างใหม่'; END IF;
  SELECT jsonb_object_agg(to_char(earning_month,'YYYY-MM'),amounts) INTO source_allocations FROM public.hr_payroll_monthly_allocations WHERE payroll_item_id=p_source;
  source_allocations:=COALESCE(source_allocations,jsonb_build_object(to_char(source.payroll_month,'YYYY-MM'),to_jsonb(source)));
  SELECT array_agg(key ORDER BY key) INTO months FROM jsonb_each(source_allocations);
  FOREACH field IN ARRAY keys LOOP
    SELECT array_agg(abs(COALESCE((value->>field)::numeric,0)) ORDER BY key),sum(abs(COALESCE((value->>field)::numeric,0))) INTO weights,denominator FROM jsonb_each(source_allocations);
    IF denominator=0 THEN
      SELECT array_agg(GREATEST(1,(SELECT count(*) FROM public.hr_payroll_wage_reservations w WHERE w.payroll_item_id=p_source AND to_char(w.work_date,'YYYY-MM')=key))::numeric ORDER BY key) INTO weights FROM jsonb_each(source_allocations);
      SELECT sum(weight) INTO denominator FROM unnest(weights) weight;
    END IF;
    cumulative:=0; allocated:=0;
    FOR idx IN 1..cardinality(months) LOOP
      cumulative:=cumulative+weights[idx]; next_amount:=round((deltas->>field)::numeric*cumulative/denominator,2);
      allocations:=jsonb_set(allocations,ARRAY[months[idx]],COALESCE(allocations->months[idx],'{}')||jsonb_build_object(field,next_amount-allocated),true);
      allocated:=next_amount;
    END LOOP;
  END LOOP;
  INSERT INTO public.hr_payroll_adjustments(request_key,source_item_id,company_id,employee_id,earning_month,reason,previous_amounts,corrected_amounts,deltas,deduction_allocations,income_delta,deduction_delta,net_delta,created_by)
    VALUES(p_request,p_source,company,source.employee_id,source.payroll_month,trim(p_reason),previous,p_corrected,deltas,allocations,round(income,2),round(deduction,2),round(income-deduction,2),auth.uid()) RETURNING * INTO existing;
  RETURN existing;
END $$;
REVOKE ALL ON FUNCTION public.hr_create_payroll_adjustment(UUID,UUID,JSONB,TEXT,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_create_payroll_adjustment(UUID,UUID,JSONB,TEXT,JSONB) TO authenticated;
CREATE OR REPLACE FUNCTION public.hr_cancel_payroll_adjustment(p_adjustment UUID,p_reason TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE company UUID;
BEGIN
  IF NOT public.hr_payroll_role_allowed() OR NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลและใช้สิทธิ์ฝ่ายบัญชี'; END IF;
  SELECT company_id INTO company FROM public.hr_payroll_adjustments WHERE id=p_adjustment;
  PERFORM pg_advisory_xact_lock(hashtextextended(company::text || ':payroll',0));
  IF EXISTS(SELECT 1 FROM public.hr_payroll_payments WHERE adjustment_id=p_adjustment) THEN RAISE EXCEPTION 'รายการนี้จ่ายหรือรับคืนแล้ว ต้องปรับด้วยรายการใหม่'; END IF;
  UPDATE public.hr_payroll_adjustments SET status='cancelled',cancelled_reason=trim(p_reason),cancelled_by=auth.uid(),cancelled_at=now() WHERE id=p_adjustment AND status='approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบรายการที่ยกเลิกได้'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.hr_cancel_payroll_adjustment(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_cancel_payroll_adjustment(UUID,TEXT) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
