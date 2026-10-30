BEGIN;

ALTER TABLE public.hr_payroll_runs DROP CONSTRAINT IF EXISTS hr_payroll_runs_payroll_type_check;
ALTER TABLE public.hr_payroll_runs ADD CONSTRAINT hr_payroll_runs_payroll_type_check
  CHECK(payroll_type IN ('permanent','monthly_uninsured','daily'));
ALTER TABLE public.hr_payroll_runs ADD COLUMN IF NOT EXISTS split_from_run_id UUID REFERENCES public.hr_payroll_runs(id);

-- Preserve every original item and monetary value. Existing mixed runs are
-- split with the complete original run/items retained in the revision ledger.
-- An empty new group inherits no confirmation from the other group.
DO $$
DECLARE r public.hr_payroll_runs; target UUID; original_items JSONB; left_count INT;
BEGIN
  FOR r IN SELECT * FROM public.hr_payroll_runs WHERE payroll_type='permanent' ORDER BY id FOR UPDATE LOOP
    IF NOT EXISTS(SELECT 1 FROM public.hr_payroll_items i WHERE i.payroll_run_id=r.id
      AND COALESCE(i.social_security_enabled,i.social_security > 0)=false) THEN CONTINUE; END IF;
    IF EXISTS(SELECT 1 FROM public.hr_payroll_runs x WHERE x.company_id=r.company_id AND x.payroll_month=r.payroll_month AND x.payroll_type='monthly_uninsured') THEN
      RAISE EXCEPTION 'พบงวดไม่เข้า สปส. เดิมพร้อมกับงวดรวม กรุณาตรวจสอบก่อนแยก';
    END IF;
    SELECT jsonb_agg(to_jsonb(i) ORDER BY i.employee_code) INTO original_items FROM public.hr_payroll_items i WHERE i.payroll_run_id=r.id;
    INSERT INTO public.hr_payroll_revisions(payroll_run_id,reason,run_before,items_before,created_by)
      VALUES(r.id,'Migration 682: แยกการยืนยันรายเดือน เข้า/ไม่เข้า สปส. โดยคงยอดเดิม',to_jsonb(r),original_items,auth.uid());
    IF r.status='confirmed' THEN
      UPDATE public.hr_payroll_runs SET status='draft',confirmed_by=NULL,confirmed_at=NULL WHERE id=r.id;
    END IF;
    INSERT INTO public.hr_payroll_runs(company_id,payroll_month,payroll_type,status,payment_date,split_from_run_id)
      VALUES(r.company_id,r.payroll_month,'monthly_uninsured','draft',r.payment_date,r.id) RETURNING id INTO target;
    UPDATE public.hr_payroll_items SET payroll_run_id=target,social_security_enabled=false
      WHERE payroll_run_id=r.id AND COALESCE(social_security_enabled,social_security > 0)=false;
    INSERT INTO public.hr_payroll_revisions(payroll_run_id,reason,run_before,items_before,created_by)
      VALUES(target,'Migration 682: สำเนางวดต้นทางก่อนแยกกลุ่ม ไม่เข้า สปส.',to_jsonb(r),original_items,auth.uid());
    SELECT count(*) INTO left_count FROM public.hr_payroll_items WHERE payroll_run_id=r.id;
    UPDATE public.hr_payroll_runs SET status=r.status,confirmed_by=r.confirmed_by,confirmed_at=r.confirmed_at WHERE id=target;
    UPDATE public.hr_payroll_runs SET status=CASE WHEN left_count > 0 THEN r.status ELSE 'draft' END,
      confirmed_by=CASE WHEN left_count > 0 THEN r.confirmed_by END,
      confirmed_at=CASE WHEN left_count > 0 THEN r.confirmed_at END WHERE id=r.id;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_payroll_snapshot_social_security()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE kind TEXT;
BEGIN
  SELECT payroll_type INTO kind FROM public.hr_payroll_runs WHERE id=NEW.payroll_run_id;
  IF kind IN ('permanent','monthly_uninsured') THEN
    NEW.social_security_enabled := kind='permanent';
  ELSIF NEW.social_security_enabled IS NULL THEN
    SELECT e.social_security_enabled INTO NEW.social_security_enabled FROM public.hr_employees e WHERE e.id=NEW.employee_id;
  END IF;
  IF NEW.social_security_enabled IS FALSE THEN NEW.social_security := 0; END IF;
  RETURN NEW;
END;
$$;

-- Serialize writes to both monthly groups and prevent paying the same employee
-- twice. Transfers are allowed only from a draft; confirmed siblings are frozen.
CREATE OR REPLACE FUNCTION public.hr_payroll_monthly_membership()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.hr_payroll_runs; other RECORD;
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  SELECT * INTO r FROM public.hr_payroll_runs WHERE id=NEW.payroll_run_id;
  IF r.payroll_type NOT IN ('permanent','monthly_uninsured') THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(r.company_id::text || ':' || r.payroll_month::text || ':monthly',0));
  IF NEW.pay_type='daily' OR (NEW.social_security_enabled IS NOT NULL AND NEW.social_security_enabled <> (r.payroll_type='permanent')) THEN
    RAISE EXCEPTION 'ประเภทพนักงานหรือสถานะ สปส. ไม่ตรงกับกลุ่มเงินเดือน';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.hr_employees e WHERE e.id=NEW.employee_id AND e.company_id=r.company_id) THEN
    RAISE EXCEPTION 'พนักงานไม่ได้อยู่ในบริษัทของงวดนี้';
  END IF;
  IF TG_OP='INSERT' OR NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id OR NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
    IF NOT EXISTS(SELECT 1 FROM public.hr_employees e WHERE e.id=NEW.employee_id AND e.social_security_enabled=(r.payroll_type='permanent')) THEN
      RAISE EXCEPTION 'สถานะ สปส. ของพนักงานเปลี่ยนแล้ว กรุณาโหลดข้อมูลใหม่ก่อนบันทึก';
    END IF;
  END IF;
  FOR other IN SELECT i.id,x.id run_id,x.status FROM public.hr_payroll_items i
    JOIN public.hr_payroll_runs x ON x.id=i.payroll_run_id
    WHERE i.employee_id=NEW.employee_id AND x.company_id=r.company_id AND x.payroll_month=r.payroll_month
      AND x.payroll_type IN ('permanent','monthly_uninsured') AND x.id<>r.id FOR UPDATE OF x,i LOOP
    IF other.status='confirmed' THEN RAISE EXCEPTION 'พนักงานคนนี้ยืนยันเงินเดือนในอีกกลุ่มแล้ว กรุณาปรับปรุงงวดเดิมก่อน'; END IF;
    IF TG_OP='UPDATE' AND other.id=OLD.id THEN CONTINUE; END IF;
    DELETE FROM public.hr_payroll_items WHERE id=other.id;
  END LOOP;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS aaa_hr_payroll_monthly_membership ON public.hr_payroll_items;
CREATE TRIGGER aaa_hr_payroll_monthly_membership BEFORE INSERT OR UPDATE ON public.hr_payroll_items
  FOR EACH ROW EXECUTE FUNCTION public.hr_payroll_monthly_membership();

CREATE OR REPLACE FUNCTION public.hr_reopen_monthly_payroll(p_run UUID,p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_run public.hr_payroll_runs;
BEGIN
  IF NOT public.hr_payroll_role_allowed() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ปรับปรุงงวดเงินเดือน'; END IF;
  IF NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลปรับปรุงยอด'; END IF;
  SELECT * INTO v_run FROM public.hr_payroll_runs WHERE id=p_run FOR UPDATE;
  IF NOT FOUND OR v_run.status<>'confirmed' OR v_run.payroll_type NOT IN ('permanent','monthly_uninsured') THEN
    RAISE EXCEPTION 'เปิดปรับปรุงได้เฉพาะกลุ่มเงินเดือนรายเดือนที่ยืนยันแล้ว';
  END IF;
  INSERT INTO public.hr_payroll_revisions(payroll_run_id,reason,run_before,items_before,created_by)
    SELECT p_run,trim(p_reason),to_jsonb(v_run),COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.employee_code),'[]'::jsonb),auth.uid()
    FROM public.hr_payroll_items i WHERE i.payroll_run_id=p_run;
  UPDATE public.hr_payroll_runs SET status='draft',confirmed_at=NULL,confirmed_by=NULL,updated_at=now() WHERE id=p_run;
  UPDATE public.hr_payroll_items SET reviewed_at=NULL,reviewed_by=NULL WHERE payroll_run_id=p_run;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
