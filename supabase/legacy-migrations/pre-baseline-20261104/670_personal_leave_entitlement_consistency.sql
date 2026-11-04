-- Personal opening rights are the common source for HR and payroll.
-- No request, entitlement record, or payroll snapshot is modified here.
BEGIN;
CREATE OR REPLACE FUNCTION public.get_employee_leave_summary(p_employee_id UUID, p_year INT)
RETURNS JSONB AS $$
DECLARE result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'balances', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', t.id,
        'leave_type_id', t.id,
        'leave_type_name', t.name,
        'entitled_days', CASE WHEN o.id IS NOT NULL THEN o.opening_remaining_days ELSE COALESCE(t.max_days_per_year, 0) END,
        'used_days', COALESCE(u.used, 0),
        'carried_days', 0,
        'remaining', GREATEST(0, CASE WHEN o.id IS NOT NULL THEN o.opening_remaining_days ELSE COALESCE(t.max_days_per_year, 0) END - COALESCE(u.used, 0)),
        'opening_effective_date', o.effective_date
      ) ORDER BY t.name)
      FROM public.hr_leave_types t
      LEFT JOIN public.hr_employee_opening_leave_balances o
        ON o.leave_type_id = t.id AND o.employee_id = p_employee_id AND o.year = p_year
        AND o.effective_date <= CASE WHEN p_year=EXTRACT(YEAR FROM now() AT TIME ZONE 'Asia/Bangkok')::int THEN (now() AT TIME ZONE 'Asia/Bangkok')::date ELSE make_date(p_year,12,31) END
      LEFT JOIN LATERAL (
        SELECT SUM(r.total_days) AS used
        FROM public.hr_leave_requests r
        WHERE r.employee_id = p_employee_id
          AND r.leave_type_id = t.id
          AND r.status = 'approved'
          AND EXTRACT(YEAR FROM r.start_date) = p_year
          AND (o.id IS NULL OR r.start_date >= o.effective_date)
      ) u ON TRUE
    ), '[]'::jsonb),
    'recent_requests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'leave_type_name', t.name, 'start_date', r.start_date,
        'end_date', r.end_date, 'total_days', r.total_days, 'leave_mode', r.leave_mode,
        'start_time', r.start_time, 'end_time', r.end_time, 'total_hours', r.total_hours,
        'status', r.status, 'reason', r.reason, 'medical_cert_url', r.medical_cert_url,
        'created_at', r.created_at
      ) ORDER BY r.created_at DESC)
      FROM public.hr_leave_requests r
      JOIN public.hr_leave_types t ON t.id = r.leave_type_id
      WHERE r.employee_id = p_employee_id AND EXTRACT(YEAR FROM r.start_date) = p_year
    ), '[]'::jsonb),
    'pending_count', (SELECT count(*) FROM public.hr_leave_requests WHERE employee_id = p_employee_id AND status = 'pending')
  ) INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;


-- Only annual vacation is restricted. Other categories retain the approved-overage workflow.
CREATE OR REPLACE FUNCTION public.hr_guard_vacation_entitlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_name text; v_entitled numeric; v_effective date; v_used numeric; v_year int;
BEGIN
  IF NEW.status NOT IN ('pending','approved') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.employee_id IS NOT DISTINCT FROM OLD.employee_id
     AND NEW.leave_type_id IS NOT DISTINCT FROM OLD.leave_type_id
     AND NEW.start_date IS NOT DISTINCT FROM OLD.start_date
     AND NEW.end_date IS NOT DISTINCT FROM OLD.end_date
     AND NEW.total_days IS NOT DISTINCT FROM OLD.total_days
     AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  SELECT name,max_days_per_year INTO v_name,v_entitled FROM hr_leave_types WHERE id=NEW.leave_type_id;
  IF btrim(v_name) IS DISTINCT FROM 'ลาพักร้อน' THEN RETURN NEW; END IF;
  IF EXTRACT(YEAR FROM NEW.start_date)<>EXTRACT(YEAR FROM NEW.end_date) THEN
    RAISE EXCEPTION 'กรุณาแยกใบลาพักร้อนตามปีที่ลา';
  END IF;
  v_year:=EXTRACT(YEAR FROM NEW.start_date)::int;
  PERFORM pg_advisory_xact_lock(hashtextextended('vacation:'||NEW.employee_id::text,0));
  v_effective:=make_date(v_year,1,1);
  SELECT opening_remaining_days,effective_date INTO v_entitled,v_effective
  FROM hr_employee_opening_leave_balances
  WHERE employee_id=NEW.employee_id AND leave_type_id=NEW.leave_type_id
    AND year=v_year AND effective_date<=NEW.start_date;
  IF NOT FOUND THEN
    SELECT COALESCE(max_days_per_year,0) INTO v_entitled FROM hr_leave_types WHERE id=NEW.leave_type_id;
    v_effective:=make_date(v_year,1,1);
  END IF;
  SELECT COALESCE(sum(total_days),0) INTO v_used FROM hr_leave_requests
  WHERE employee_id=NEW.employee_id AND leave_type_id=NEW.leave_type_id
    AND status IN ('pending','approved') AND id IS DISTINCT FROM NEW.id
    AND start_date>=v_effective AND start_date<make_date(v_year+1,1,1);
  IF NEW.total_days>GREATEST(0,v_entitled-v_used) THEN
    RAISE EXCEPTION 'สิทธิ์ลาพักร้อนไม่เพียงพอ: ขอ % วัน คงเหลือที่ขอได้ % วัน (หักคำขอรออนุมัติแล้ว)',NEW.total_days,GREATEST(0,v_entitled-v_used);
  END IF;
  RETURN NEW;
END;
$$;
-- Run after the existing working-day calculation triggers.
CREATE TRIGGER zz_hr_guard_vacation_entitlement BEFORE INSERT OR UPDATE ON public.hr_leave_requests
FOR EACH ROW EXECUTE FUNCTION public.hr_guard_vacation_entitlement();
COMMIT;
NOTIFY pgrst,'reload schema';
