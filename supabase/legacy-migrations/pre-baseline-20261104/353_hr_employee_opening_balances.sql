-- ยอดยกมาก่อนเริ่มใช้งาน ERP แยกรายพนักงานและปี
CREATE TABLE IF NOT EXISTS public.hr_employee_opening_leave_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.hr_employees(id) ON DELETE CASCADE,
  leave_type_id UUID NOT NULL REFERENCES public.hr_leave_types(id),
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  effective_date DATE NOT NULL,
  opening_remaining_days NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (opening_remaining_days >= 0),
  note TEXT,
  updated_by UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, leave_type_id, year),
  CHECK (EXTRACT(YEAR FROM effective_date) = year)
);

CREATE TABLE IF NOT EXISTS public.hr_employee_opening_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.hr_employees(id) ON DELETE CASCADE,
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  effective_date DATE NOT NULL,
  absence_days NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (absence_days >= 0),
  late_count INTEGER NOT NULL DEFAULT 0 CHECK (late_count >= 0),
  late_minutes INTEGER NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  early_leave_count INTEGER NOT NULL DEFAULT 0 CHECK (early_leave_count >= 0),
  early_leave_minutes INTEGER NOT NULL DEFAULT 0 CHECK (early_leave_minutes >= 0),
  note TEXT,
  updated_by UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, year),
  CHECK (EXTRACT(YEAR FROM effective_date) = year)
);

CREATE OR REPLACE FUNCTION public.hr_touch_opening_data()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.hr_score_periods p
    WHERE p.employee_id = NEW.employee_id
      AND p.period = date_trunc('month', NEW.effective_date)::DATE
      AND p.status = 'locked'
  ) THEN
    RAISE EXCEPTION 'รอบคะแนนของเดือนเริ่มระบบถูกปิดแล้ว ไม่สามารถแก้ยอดยกมาได้';
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS hr_opening_leave_touch ON public.hr_employee_opening_leave_balances;
CREATE TRIGGER hr_opening_leave_touch BEFORE INSERT OR UPDATE ON public.hr_employee_opening_leave_balances
FOR EACH ROW EXECUTE FUNCTION public.hr_touch_opening_data();
DROP TRIGGER IF EXISTS hr_opening_attendance_touch ON public.hr_employee_opening_attendance;
CREATE TRIGGER hr_opening_attendance_touch BEFORE INSERT OR UPDATE ON public.hr_employee_opening_attendance
FOR EACH ROW EXECUTE FUNCTION public.hr_touch_opening_data();

ALTER TABLE public.hr_employee_opening_leave_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_employee_opening_attendance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "opening_leave_select" ON public.hr_employee_opening_leave_balances;
DROP POLICY IF EXISTS "opening_leave_manage" ON public.hr_employee_opening_leave_balances;
CREATE POLICY "opening_leave_select" ON public.hr_employee_opening_leave_balances FOR SELECT TO authenticated
  USING (public.hr_is_admin() OR employee_id = public.hr_my_employee_id());
CREATE POLICY "opening_leave_manage" ON public.hr_employee_opening_leave_balances FOR ALL TO authenticated
  USING (public.hr_is_admin()) WITH CHECK (public.hr_is_admin());

DROP POLICY IF EXISTS "opening_attendance_select" ON public.hr_employee_opening_attendance;
DROP POLICY IF EXISTS "opening_attendance_manage" ON public.hr_employee_opening_attendance;
CREATE POLICY "opening_attendance_select" ON public.hr_employee_opening_attendance FOR SELECT TO authenticated
  USING (public.hr_is_admin() OR employee_id = public.hr_my_employee_id());
CREATE POLICY "opening_attendance_manage" ON public.hr_employee_opening_attendance FOR ALL TO authenticated
  USING (public.hr_is_admin()) WITH CHECK (public.hr_is_admin());

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
