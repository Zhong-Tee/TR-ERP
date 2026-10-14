-- Private attendance facts preserve existing calendar/WFH rules.
CREATE OR REPLACE FUNCTION hr_late_attendance_facts(
  p_from DATE,
  p_to DATE,
  p_employee UUID DEFAULT NULL
)
RETURNS TABLE (
  employee_id UUID,
  employee_code TEXT,
  employee_name TEXT,
  department_id UUID,
  work_date DATE,
  day_type TEXT,
  work_mode TEXT,
  is_remote_day BOOLEAN,
  expected_start_min INT,
  expected_end_min INT,
  grace_min INT,
  actual_in_min INT,
  actual_in_source TEXT,
  actual_in_ref UUID,
  actual_out_min INT,
  actual_out_source TEXT,
  actual_out_ref UUID,
  ot_in_min INT,
  ot_in_ref UUID,
  ot_request_id UUID,
  ot_request_status TEXT,
  ot_request_created_date DATE,
  ot_request_created_min INT,
  leave_id UUID,
  leave_status TEXT,
  leave_mode TEXT,
  leave_type_name TEXT,
  leave_start_date DATE,
  leave_filed_date DATE,
  leave_filed_min INT,
  leave_start_min INT,
  leave_end_min INT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Private helper: revoked from PUBLIC/authenticated. Public RPCs and the
  -- warning trigger authorize the actor, including employee acknowledgement.

  IF p_to < p_from THEN
    RAISE EXCEPTION 'ช่วงวันที่ไม่ถูกต้อง';
  END IF;

  RETURN QUERY
  WITH default_schedule AS (
    SELECT s.work_start, s.work_end, s.late_grace_min, s.work_days
    FROM hr_work_schedules s
    WHERE s.is_active
    ORDER BY s.is_default DESC, s.created_at
    LIMIT 1
  ),
  emp AS (
    SELECT
      e.id,
      e.employee_code,
      TRIM(e.first_name || ' ' || e.last_name) AS full_name,
      e.department_id,
      e.hire_date,
      e.work_mode,
      COALESCE(es.work_start, ds.work_start, TIME '08:00') AS work_start,
      COALESCE(es.work_end, ds.work_end, TIME '17:00') AS work_end,
      COALESCE(es.late_grace_min, ds.late_grace_min, 0) AS late_grace_min,
      COALESCE(es.work_days, ds.work_days, '1,2,3,4,5,6') AS work_days
    FROM hr_employees e
    LEFT JOIN hr_work_schedules es ON es.id = e.work_schedule_id AND es.is_active
    LEFT JOIN default_schedule ds ON true
    WHERE e.employment_status IN ('active', 'probation')
      AND (p_employee IS NULL OR e.id = p_employee)
  ),
  days AS (
    SELECT gs::DATE AS d FROM generate_series(p_from, p_to, INTERVAL '1 day') gs
  ),
  base AS (
    SELECT emp.*, days.d
    FROM emp
    CROSS JOIN days
    WHERE emp.hire_date IS NULL OR days.d >= emp.hire_date
  )
  SELECT
    b.id,
    b.employee_code,
    b.full_name,
    b.department_id,
    b.d,
    CASE
      WHEN cal.id IS NOT NULL THEN cal.day_type
      WHEN hol.id IS NOT NULL THEN 'company_holiday'
      WHEN EXTRACT(ISODOW FROM b.d)::TEXT = ANY (string_to_array(b.work_days, ',')) THEN 'work'
      ELSE 'weekly_off'
    END AS day_type,
    b.work_mode,
    (b.work_mode = 'wfh' OR wfh.id IS NOT NULL) AS is_remote_day,
    (EXTRACT(HOUR FROM eff_start) * 60 + EXTRACT(MINUTE FROM eff_start))::INT AS expected_start_min,
    (EXTRACT(HOUR FROM eff_end) * 60 + EXTRACT(MINUTE FROM eff_end))::INT AS expected_end_min,
    COALESCE(cal_sched.late_grace_min, b.late_grace_min)::INT AS grace_min,

    COALESCE(tin.min_of_day, cin.min_of_day)::INT AS actual_in_min,
    CASE WHEN tin.id IS NOT NULL THEN 'entry' WHEN cin.id IS NOT NULL THEN 'certified' END AS actual_in_source,
    COALESCE(tin.id, cin.id) AS actual_in_ref,

    COALESCE(tout.min_of_day, cout.min_of_day)::INT AS actual_out_min,
    CASE WHEN tout.id IS NOT NULL THEN 'entry' WHEN cout.id IS NOT NULL THEN 'certified' END AS actual_out_source,
    COALESCE(tout.id, cout.id) AS actual_out_ref,

    otin.min_of_day::INT AS ot_in_min,
    otin.id AS ot_in_ref,
    otr.id AS ot_request_id,
    otr.status AS ot_request_status,
    (otr.created_at AT TIME ZONE 'Asia/Bangkok')::DATE AS ot_request_created_date,
    (EXTRACT(HOUR FROM otr.created_at AT TIME ZONE 'Asia/Bangkok') * 60
      + EXTRACT(MINUTE FROM otr.created_at AT TIME ZONE 'Asia/Bangkok'))::INT AS ot_request_created_min,

    lv.id AS leave_id,
    lv.status AS leave_status,
    lv.leave_mode,
    lv.type_name AS leave_type_name,
    lv.start_date AS leave_start_date,
    (lv.created_at AT TIME ZONE 'Asia/Bangkok')::DATE AS leave_filed_date,
    (EXTRACT(HOUR FROM lv.created_at AT TIME ZONE 'Asia/Bangkok') * 60
      + EXTRACT(MINUTE FROM lv.created_at AT TIME ZONE 'Asia/Bangkok'))::INT AS leave_filed_min,
    (EXTRACT(HOUR FROM lv.start_time) * 60 + EXTRACT(MINUTE FROM lv.start_time))::INT AS leave_start_min,
    (EXTRACT(HOUR FROM lv.end_time) * 60 + EXTRACT(MINUTE FROM lv.end_time))::INT AS leave_end_min
  FROM base b
  LEFT JOIN hr_employee_work_calendar cal ON cal.employee_id = b.id AND cal.work_date = b.d
  LEFT JOIN hr_work_schedules cal_sched ON cal_sched.id = cal.work_schedule_id
  LEFT JOIN hr_company_holidays hol ON hol.holiday_date = b.d
  -- ต้องอยู่ก่อน eff เพราะ eff อ้างช่วงเวลาของคำขอ WFH
  LEFT JOIN LATERAL (
    SELECT w.id, w.start_time, w.end_time
    FROM hr_wfh_requests w
    WHERE w.employee_id = b.id AND w.status = 'approved'
      AND w.start_date <= b.d AND w.end_date >= b.d
    ORDER BY w.approved_at DESC NULLS LAST
    LIMIT 1
  ) wfh ON true
  CROSS JOIN LATERAL (
    SELECT
      COALESCE(wfh.start_time, cal.work_start, cal_sched.work_start, b.work_start) AS eff_start,
      COALESCE(wfh.end_time, cal.work_end, cal_sched.work_end, b.work_end) AS eff_end
  ) eff
  LEFT JOIN LATERAL (
    SELECT te.id, EXTRACT(EPOCH FROM ((te.entry_time AT TIME ZONE 'Asia/Bangkok') - b.d::TIMESTAMP)) / 60 AS min_of_day
    FROM hr_time_entries te
    WHERE te.employee_id = b.id AND te.work_date = b.d AND te.entry_type = 'clock_in'
    ORDER BY te.entry_time
    LIMIT 1
  ) tin ON true
  LEFT JOIN LATERAL (
    SELECT te.id, EXTRACT(EPOCH FROM ((te.entry_time AT TIME ZONE 'Asia/Bangkok') - b.d::TIMESTAMP)) / 60 AS min_of_day
    FROM hr_time_entries te
    WHERE te.employee_id = b.id AND te.work_date = b.d AND te.entry_type = 'clock_out'
    ORDER BY te.entry_time DESC
    LIMIT 1
  ) tout ON true
  LEFT JOIN LATERAL (
    SELECT te.id, EXTRACT(EPOCH FROM ((te.entry_time AT TIME ZONE 'Asia/Bangkok') - b.d::TIMESTAMP)) / 60 AS min_of_day
    FROM hr_time_entries te
    WHERE te.employee_id = b.id AND te.work_date = b.d AND te.entry_type = 'ot_in'
    ORDER BY te.entry_time
    LIMIT 1
  ) otin ON true
  LEFT JOIN LATERAL (
    SELECT tc.id, EXTRACT(EPOCH FROM ((tc.certified_time AT TIME ZONE 'Asia/Bangkok') - b.d::TIMESTAMP)) / 60 AS min_of_day
    FROM hr_time_certifications tc
    WHERE tc.employee_id = b.id AND tc.work_date = b.d AND tc.entry_type = 'clock_in'
  ) cin ON true
  LEFT JOIN LATERAL (
    SELECT tc.id, EXTRACT(EPOCH FROM ((tc.certified_time AT TIME ZONE 'Asia/Bangkok') - b.d::TIMESTAMP)) / 60 AS min_of_day
    FROM hr_time_certifications tc
    WHERE tc.employee_id = b.id AND tc.work_date = b.d AND tc.entry_type = 'clock_out'
  ) cout ON true
  LEFT JOIN LATERAL (
    SELECT lr.id, lr.status, lr.leave_mode, lr.start_date, lr.created_at,
           lr.start_time, lr.end_time, lt.name AS type_name
    FROM hr_leave_requests lr
    LEFT JOIN hr_leave_types lt ON lt.id = lr.leave_type_id
    WHERE lr.employee_id = b.id
      AND lr.start_date <= b.d AND lr.end_date >= b.d
      AND lr.status IN ('approved', 'pending')
    ORDER BY CASE lr.status WHEN 'approved' THEN 0 ELSE 1 END, lr.created_at
    LIMIT 1
  ) lv ON true
  LEFT JOIN LATERAL (
    SELECT r.id, r.status, r.created_at
    FROM hr_ot_requests r
    WHERE r.employee_id = b.id AND r.request_date = b.d
      AND r.status IN ('approved', 'pending', 'rejected')
    ORDER BY CASE r.status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, r.created_at
    LIMIT 1
  ) otr ON true
  WHERE cal.day_type = 'work'
     OR (cal.id IS NULL AND hol.id IS NULL
         AND EXTRACT(ISODOW FROM b.d)::TEXT = ANY (string_to_array(b.work_days, ',')))
     OR tin.id IS NOT NULL OR tout.id IS NOT NULL OR otin.id IS NOT NULL
     OR cin.id IS NOT NULL OR cout.id IS NOT NULL
  ORDER BY b.full_name, b.d;
END;
$$;


REVOKE ALL ON FUNCTION hr_late_attendance_facts(DATE,DATE,UUID) FROM PUBLIC,authenticated;

-- Late accumulation is derived on the server at the current Bangkok date.
-- Resets do not delete incidents and need no browser or scheduled job to run.
CREATE TABLE hr_late_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  start_date DATE NOT NULL DEFAULT DATE '2026-10-15',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id)
);
INSERT INTO hr_late_settings(singleton) VALUES(true);
CREATE TABLE hr_late_exceptions (
  employee_id UUID NOT NULL REFERENCES hr_employees(id), work_date DATE NOT NULL,
  exempt BOOLEAN NOT NULL, reason TEXT NOT NULL CHECK(length(btrim(reason))>0),
  decided_by UUID NOT NULL REFERENCES auth.users(id), decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(employee_id,work_date)
);
CREATE TABLE hr_late_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action TEXT NOT NULL, actor UUID REFERENCES auth.users(id), old_data JSONB, new_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE hr_warnings ADD COLUMN late_generated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE hr_warnings ADD COLUMN late_incidents_snapshot JSONB NOT NULL DEFAULT '[]';
ALTER TABLE hr_warnings ADD COLUMN late_start_date DATE;
ALTER TABLE hr_late_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_late_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_late_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY late_settings_read ON hr_late_settings FOR SELECT TO authenticated
 USING(check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']));
CREATE POLICY late_exceptions_read ON hr_late_exceptions FOR SELECT TO authenticated
 USING(check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']));
CREATE POLICY late_audit_read ON hr_late_audit FOR SELECT TO authenticated
 USING(check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']));

CREATE FUNCTION hr_late_events_internal(p_start DATE, p_today DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE f RECORD; lv RECORD; ex RECORD; expected INT; actual INT; delay INT;
  approved_full BOOLEAN; approved_at_arrival BOOLEAN; waiting BOOLEAN; occurred TIMESTAMPTZ;
  event_status TEXT; event_reason TEXT; result JSONB := '[]';
BEGIN
  IF p_start>p_today THEN RETURN result; END IF;
  FOR f IN SELECT * FROM hr_late_attendance_facts(p_start,p_today,NULL) LOOP
    IF f.day_type<>'work' OR f.actual_in_min IS NULL THEN CONTINUE; END IF;
    -- Floor seconds, do not round 08:35:31 up to 08:36.
    SELECT CASE WHEN f.actual_in_source='entry' THEN
      (SELECT entry_time FROM hr_time_entries WHERE id=f.actual_in_ref)
      ELSE (SELECT certified_time FROM hr_time_certifications WHERE id=f.actual_in_ref) END INTO occurred;
    actual := floor(extract(epoch FROM ((occurred AT TIME ZONE 'Asia/Bangkok')-f.work_date::TIMESTAMP))/60)::INT;
    expected := f.expected_start_min;
    IF actual-expected<=5 THEN CONTINUE; END IF;
    approved_full := false; approved_at_arrival := false; waiting := false;
    FOR lv IN SELECT r.* FROM hr_leave_requests r
      WHERE r.employee_id=f.employee_id AND r.start_date<=f.work_date AND r.end_date>=f.work_date
        AND r.status='approved' ORDER BY r.start_time NULLS FIRST LOOP
      IF lv.leave_mode IS DISTINCT FROM 'hourly' THEN approved_full := true;
      ELSIF lv.start_time IS NOT NULL AND lv.end_time IS NOT NULL THEN
        IF actual >= extract(epoch FROM lv.start_time)/60 AND actual <= extract(epoch FROM lv.end_time)/60 THEN
          approved_at_arrival := true;
        END IF;
        IF extract(epoch FROM lv.start_time)/60<=expected AND extract(epoch FROM lv.end_time)/60>expected THEN
          expected := (extract(epoch FROM lv.end_time)/60)::INT;
        END IF;
      END IF;
    END LOOP;
    SELECT EXISTS(SELECT 1 FROM hr_leave_requests r WHERE r.employee_id=f.employee_id
      AND r.start_date<=f.work_date AND r.end_date>=f.work_date AND r.status='pending' AND r.is_emergency
      AND (r.leave_mode IS DISTINCT FROM 'hourly' OR
        (extract(epoch FROM r.start_time)/60<=actual AND extract(epoch FROM r.end_time)/60>=f.expected_start_min))) INTO waiting;
    SELECT * INTO ex FROM hr_late_exceptions WHERE employee_id=f.employee_id AND work_date=f.work_date;
    delay := greatest(actual-expected,0);
    IF approved_full OR approved_at_arrival OR delay<=5 OR COALESCE(ex.exempt,false) THEN
      event_status := 'exempt';
      event_reason := CASE WHEN COALESCE(ex.exempt,false) THEN ex.reason ELSE 'ช่วงลาที่อนุมัติ / เข้างานภายในเวลาหลังลา' END;
    ELSIF waiting THEN event_status := 'pending'; event_reason := 'รอพิจารณาลากิจฉุกเฉิน';
    ELSE event_status := 'included'; event_reason := ex.reason; END IF;
    result := result || jsonb_build_array(jsonb_build_object('employee_id',f.employee_id,'work_date',f.work_date,
      'occurred_at',occurred,'expected_min',expected,'actual_min',actual,'late_min',delay,'status',event_status,'reason',event_reason));
  END LOOP;
  RETURN result;
END; $$;

CREATE FUNCTION hr_late_summary_internal()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE start_day DATE; today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::DATE; result JSONB;
BEGIN
  SELECT start_date INTO start_day FROM hr_late_settings WHERE singleton;
  WITH events AS MATERIALIZED (
    SELECT x.* FROM jsonb_to_recordset(hr_late_events_internal(start_day,today)) AS x(
      employee_id UUID, work_date DATE, occurred_at TIMESTAMPTZ, expected_min INT,
      actual_min INT, late_min INT, status TEXT, reason TEXT)
  ), employees AS (
    SELECT e.id, e.employee_code, trim(e.first_name||' '||e.last_name) employee_name, d.name department_name
    FROM hr_employees e LEFT JOIN hr_departments d ON d.id=e.department_id
    WHERE e.employment_status IN ('active','probation') AND
      (EXISTS(SELECT 1 FROM events WHERE employee_id=e.id) OR EXISTS(SELECT 1 FROM hr_warnings WHERE employee_id=e.id AND late_generated))
  ), base AS (
    SELECT e.*, w.warning_level,
      (w.incident_date+INTERVAL '1 year')::DATE expires_on,
      CASE WHEN (w.incident_date+INTERVAL '1 year')::DATE<=today
        THEN (w.incident_date+INTERVAL '1 year')::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
        ELSE COALESCE(w.acknowledged_at,w.approved_at) END cutoff,
      p.id pending_warning_id, p.case_number pending_case_number, p.status pending_status,
      COALESCE(p.late_incidents_snapshot,CASE WHEN (w.incident_date+INTERVAL '1 year')::DATE>today THEN w.late_incidents_snapshot END) snapshot,
      (SELECT max(work_date) FROM events WHERE employee_id=e.id AND status<>'exempt' AND late_min>5) last_late_date
    FROM employees e
    LEFT JOIN LATERAL (
      SELECT * FROM hr_warnings WHERE employee_id=e.id AND late_generated AND status<>'cancelled'
        AND (acknowledged_at IS NOT NULL OR (warning_level='termination_review' AND approved_at IS NOT NULL))
      ORDER BY COALESCE(approved_at,acknowledged_at,created_at) DESC,id DESC LIMIT 1
    ) w ON true
    LEFT JOIN LATERAL (
      SELECT * FROM hr_warnings WHERE employee_id=e.id AND late_generated
        AND status IN ('draft','pending_review','changes_requested','pending_approval','approved','pending_acknowledgement','termination_review')
      ORDER BY created_at DESC,id DESC LIMIT 1
    ) p ON true
  ), ordered AS (
    SELECT x.*,lag(x.work_date) OVER(PARTITION BY x.employee_id ORDER BY x.work_date) previous_date
    FROM events x JOIN base b ON b.id=x.employee_id
    WHERE x.status<>'exempt' AND x.late_min>5 AND (b.cutoff IS NULL OR x.occurred_at>b.cutoff)
  ), rounds AS (
    SELECT x.*,sum(CASE WHEN previous_date IS NULL OR work_date-previous_date>=120 THEN 1 ELSE 0 END)
      OVER(PARTITION BY employee_id ORDER BY work_date) round_number FROM ordered x
  ), current_events AS (
    SELECT x.* FROM rounds x WHERE round_number=(SELECT max(y.round_number) FROM rounds y WHERE y.employee_id=x.employee_id)
      AND today-(SELECT max(y.work_date) FROM rounds y WHERE y.employee_id=x.employee_id)<120
  ), totals AS (
    SELECT b.*,
      CASE WHEN expires_on>today THEN warning_level END current_level,
      greatest(COALESCE(today-last_late_date,0),0) clean_days,
      (SELECT count(*) FROM current_events WHERE employee_id=b.id AND status='included')::INT late_count,
      COALESCE((SELECT sum(late_min) FROM current_events WHERE employee_id=b.id AND status='included'),0)::INT late_minutes,
      (SELECT count(*) FROM current_events WHERE employee_id=b.id AND status='pending')::INT pending_emergency_count,
      COALESCE((SELECT jsonb_agg(to_jsonb(x)-'previous_date'-'round_number' ORDER BY work_date) FROM current_events x WHERE employee_id=b.id AND status='included'),'[]') incidents,
      COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY work_date DESC) FROM events x WHERE employee_id=b.id),'[]') history,
      EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(b.snapshot,'[]')) s
        WHERE NOT EXISTS(SELECT 1 FROM events x WHERE x.employee_id=b.id AND x.work_date=(s->>'work_date')::DATE
          AND x.status='included' AND x.expected_min=(s->>'expected_min')::INT
          AND x.actual_min=(s->>'actual_min')::INT AND x.late_min=(s->>'late_min')::INT)) review_required
    FROM base b
  ), rows AS (
    SELECT employee_id,employee_code,employee_name,department_name,late_count,late_minutes,last_late_date,clean_days,
      current_level,CASE WHEN current_level IS NOT NULL THEN expires_on END effective_until,
      CASE current_level WHEN 'verbal' THEN 'written_1' WHEN 'written_1' THEN 'final'
        WHEN 'final' THEN 'termination_review' WHEN 'termination_review' THEN 'termination_review' ELSE 'verbal' END next_level,
      pending_warning_id,pending_case_number,pending_status,pending_emergency_count,review_required,incidents,history,
      ((late_count>=3 OR late_minutes>=120) AND pending_warning_id IS NULL AND pending_emergency_count=0
        AND COALESCE(current_level,'')<>'termination_review') eligible
    FROM (SELECT id employee_id,totals.* FROM totals) t
  ) SELECT jsonb_build_object('start_date',start_day,
      'settings_locked',EXISTS(SELECT 1 FROM hr_warnings WHERE late_generated),
      'ready_count',(SELECT count(*) FROM rows WHERE eligible),
      'rows',COALESCE((SELECT jsonb_agg(to_jsonb(rows) ORDER BY eligible DESC,employee_code) FROM rows),'[]')) INTO result;
  RETURN result;
END; $$;

CREATE FUNCTION hr_late_accumulation() RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ดูยอดมาสาย'; END IF;
  RETURN hr_late_summary_internal();
END; $$;
CREATE FUNCTION hr_late_ready_count() RETURNS INT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ดูยอดมาสาย'; END IF;
  RETURN (hr_late_summary_internal()->>'ready_count')::INT;
END; $$;

CREATE FUNCTION hr_late_set_start_date(p_start DATE) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE old_row hr_late_settings;
BEGIN
  IF NOT check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ตั้งค่า'; END IF;
  IF p_start IS NULL OR p_start<DATE '2000-01-01' OR p_start>DATE '2100-12-31' THEN RAISE EXCEPTION 'วันที่ไม่ถูกต้อง'; END IF;
  SELECT * INTO old_row FROM hr_late_settings WHERE singleton FOR UPDATE;
  IF EXISTS(SELECT 1 FROM hr_warnings WHERE late_generated) THEN RAISE EXCEPTION 'ไม่สามารถเปลี่ยนวันเริ่มหลังสร้างเคสได้'; END IF;
  UPDATE hr_late_settings SET start_date=p_start,updated_at=now(),updated_by=auth.uid() WHERE singleton;
  INSERT INTO hr_late_audit(action,actor,old_data,new_data) VALUES('set_start_date',auth.uid(),to_jsonb(old_row),jsonb_build_object('start_date',p_start));
END; $$;

CREATE FUNCTION hr_late_set_exception(p_employee UUID,p_date DATE,p_exempt BOOLEAN,p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE old_row hr_late_exceptions;
BEGIN
  IF NOT check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์พิจารณาข้อยกเว้น'; END IF;
  IF NULLIF(btrim(p_reason),'') IS NULL OR p_exempt IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผล'; END IF;
  IF p_date IS NULL OR p_date<(SELECT start_date FROM hr_late_settings WHERE singleton)
    OR p_date>(now() AT TIME ZONE 'Asia/Bangkok')::DATE THEN RAISE EXCEPTION 'วันที่เหตุไม่ถูกต้อง'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_employee::TEXT,653));
  SELECT * INTO old_row FROM hr_late_exceptions WHERE employee_id=p_employee AND work_date=p_date;
  INSERT INTO hr_late_exceptions(employee_id,work_date,exempt,reason,decided_by)
    VALUES(p_employee,p_date,p_exempt,btrim(p_reason),auth.uid()) ON CONFLICT(employee_id,work_date)
    DO UPDATE SET exempt=excluded.exempt,reason=excluded.reason,decided_by=excluded.decided_by,decided_at=now();
  INSERT INTO hr_late_audit(action,actor,old_data,new_data) VALUES('exception',auth.uid(),to_jsonb(old_row),
    jsonb_build_object('employee_id',p_employee,'work_date',p_date,'exempt',p_exempt,'reason',btrim(p_reason)));
END; $$;

CREATE FUNCTION hr_late_create_warning(p_employee UUID) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE summary JSONB; row_data JSONB; incident_day DATE; offense UUID; warning_id UUID; description TEXT;
BEGIN
  IF NOT check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์สร้างใบเตือน'; END IF;
  -- Same lock as settings changes and exception decisions; concurrent clicks cannot create duplicate drafts.
  PERFORM singleton FROM hr_late_settings WHERE singleton FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_employee::TEXT,653));
  summary := hr_late_summary_internal();
  SELECT x INTO row_data FROM jsonb_array_elements(summary->'rows') x WHERE x->>'employee_id'=p_employee::TEXT;
  IF row_data IS NULL OR NOT (row_data->>'eligible')::BOOLEAN THEN RAISE EXCEPTION 'ยังไม่ถึงเกณฑ์ หรือมีเคส/ลาฉุกเฉินรอดำเนินการ กรุณารีเฟรช'; END IF;
  -- Conservative validity: no event in this warning is older than its one-year validity base.
  SELECT min((x->>'work_date')::DATE),string_agg((x->>'work_date')||' เริ่ม '||
      to_char(make_interval(mins=>(x->>'expected_min')::INT),'HH24:MI')||' เข้า '||
      to_char(make_interval(mins=>(x->>'actual_min')::INT),'HH24:MI')||' สาย '||(x->>'late_min')||' นาที',E'\n' ORDER BY x->>'work_date')
    INTO incident_day,description FROM jsonb_array_elements(row_data->'incidents') x;
  SELECT id INTO offense FROM hr_warning_offense_types WHERE code='late';
  IF offense IS NULL THEN RAISE EXCEPTION 'ไม่พบประเภทความผิดมาสาย'; END IF;
  INSERT INTO hr_warnings(employee_id,offense_type_id,warning_level,recommended_level,subject,description,corrective_action,
    incident_date,effective_until,status,created_by_user,issued_by,late_generated,late_start_date,late_incidents_snapshot)
  VALUES(p_employee,offense,row_data->>'next_level',row_data->>'next_level','การมาสายสะสม',
    'สะสม '||(row_data->>'late_count')||' ครั้ง รวม '||(row_data->>'late_minutes')||E' นาที\n'||description,
    'ให้มาปฏิบัติงานตรงตามเวลาเริ่มงานและปฏิบัติตามหลักเกณฑ์การมาทำงานสายของบริษัท',
    incident_day,(incident_day+INTERVAL '1 year')::DATE,'draft',auth.uid(),hr_my_employee_id(),true,
    (summary->>'start_date')::DATE,row_data->'incidents') RETURNING id INTO warning_id;
  RETURN warning_id;
END; $$;

CREATE UNIQUE INDEX hr_late_one_open_case ON hr_warnings(employee_id) WHERE late_generated
  AND status IN ('draft','pending_review','changes_requested','pending_approval','approved','pending_acknowledgement','termination_review');

-- Keep generated evidence immutable; validate live data again at each workflow checkpoint.
CREATE FUNCTION hr_late_warning_guard() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE summary JSONB; row_data JSONB; base_day DATE; evidence JSONB; evidence_count INT; evidence_minutes INT;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.late_generated THEN RAISE EXCEPTION 'กรุณายกเลิกเคสแทนการลบ เพื่อรักษาประวัติ'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.late_generated AND NOT NEW.late_generated THEN RAISE EXCEPTION 'ไม่สามารถยกเลิกการเชื่อมยอดมาสายได้'; END IF;
  IF TG_OP='UPDATE' AND NOT OLD.late_generated AND NEW.late_generated THEN RAISE EXCEPTION 'กรุณาสร้างเคสผ่านหน้าสะสมการมาสาย'; END IF;
  IF NOT NEW.late_generated THEN RETURN NEW; END IF;
  IF NOT check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']) THEN
    IF TG_OP<>'UPDATE' OR OLD.employee_id IS DISTINCT FROM hr_my_employee_id()
      OR OLD.status<>'pending_acknowledgement' OR NEW.status NOT IN ('acknowledged','acknowledgement_refused') THEN
      RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขเคสสะสมการมาสาย';
    END IF;
    IF (to_jsonb(NEW)-ARRAY['status','acknowledged_at','employee_response','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','acknowledged_at','employee_response','updated_at']) THEN
      RAISE EXCEPTION 'พนักงานบันทึกได้เฉพาะการรับทราบและคำชี้แจง';
    END IF;
    NEW.acknowledged_at := now();
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.employee_id::TEXT,653));
  IF TG_OP='UPDATE' THEN
    IF NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.offense_type_id IS DISTINCT FROM OLD.offense_type_id
      OR NEW.warning_level IS DISTINCT FROM OLD.warning_level OR NEW.incident_date IS DISTINCT FROM OLD.incident_date
      OR NEW.late_start_date IS DISTINCT FROM OLD.late_start_date THEN
      RAISE EXCEPTION 'เคสสะสมมาสายไม่สามารถเปลี่ยนพนักงาน ขั้น หรือวันที่เหตุได้ กรุณายกเลิกและสร้างใหม่';
    END IF;
    IF NEW.status='cancelled' AND OLD.status<>'cancelled' AND NULLIF(btrim(NEW.resolution_note),'') IS NULL THEN
      RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ยกเลิกหรือเพิกถอน';
    END IF;
    IF NEW.status='cancelled' OR NEW.status='closed' OR NEW.status='changes_requested' THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN
    ('pending_review','pending_approval','pending_acknowledgement','termination_review','acknowledged','acknowledgement_refused')) THEN
    summary := hr_late_summary_internal();
    SELECT x INTO row_data FROM jsonb_array_elements(summary->'rows') x WHERE x->>'employee_id'=NEW.employee_id::TEXT;
    IF row_data IS NULL OR (row_data->>'pending_emergency_count')::INT>0 THEN
      RAISE EXCEPTION 'ยอดไม่ถึงเกณฑ์ หรือมีลาฉุกเฉินรอพิจารณา กรุณาทบทวนเคส';
    END IF;
    IF TG_OP='INSERT' AND NOT (row_data->>'eligible')::BOOLEAN THEN RAISE EXCEPTION 'มีเคสรอดำเนินการแล้ว'; END IF;
    IF (row_data->>'review_required')::BOOLEAN THEN RAISE EXCEPTION 'เวลา/ข้อยกเว้นเปลี่ยนแปลง กรุณาทบทวนยอดและส่งตรวจใหม่'; END IF;
    -- A warning expiring while this draft waits must not silently escalate the new cycle.
    IF NEW.warning_level IS DISTINCT FROM row_data->>'next_level' THEN RAISE EXCEPTION 'ขั้นเตือนเปลี่ยนแปลง กรุณายกเลิกเคสและสร้างร่างใหม่'; END IF;
    -- A 120-day counter reset does not erase the evidence of an already-created case.
    evidence := CASE WHEN TG_OP='INSERT' THEN '[]'::JSONB ELSE OLD.late_incidents_snapshot END || (row_data->'incidents');
    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'work_date'),'[]') INTO evidence FROM (
      SELECT DISTINCT ON (x->>'work_date') x FROM jsonb_array_elements(evidence) WITH ORDINALITY a(x,n)
      ORDER BY x->>'work_date',n DESC
    ) unique_events;
    SELECT count(*)::INT,COALESCE(sum((x->>'late_min')::INT),0)::INT INTO evidence_count,evidence_minutes FROM jsonb_array_elements(evidence) x;
    IF evidence_count<3 AND evidence_minutes<120 THEN RAISE EXCEPTION 'ยอดไม่ถึงเกณฑ์ กรุณาทบทวนเคส'; END IF;
    IF NEW.status IN ('acknowledged','acknowledgement_refused') AND NEW.acknowledged_at IS NULL THEN
      RAISE EXCEPTION 'กรุณาบันทึกวันและเวลาที่แจ้งรับทราบ';
    END IF;
    NEW.late_incidents_snapshot := evidence;
    SELECT min((x->>'work_date')::DATE) INTO base_day FROM jsonb_array_elements(NEW.late_incidents_snapshot) x;
    IF (base_day+INTERVAL '1 year')::DATE<=(now() AT TIME ZONE 'Asia/Bangkok')::DATE THEN
      RAISE EXCEPTION 'เหตุที่ใช้เตือนเกินอายุหนึ่งปีแล้ว กรุณายกเลิกและพิจารณาใหม่';
    END IF;
    NEW.incident_date := base_day;
    NEW.effective_until := (base_day+INTERVAL '1 year')::DATE;
    NEW.description := 'สะสม '||evidence_count||' ครั้ง รวม '||evidence_minutes||E' นาที\n'||
      (SELECT string_agg((x->>'work_date')||' เริ่ม '||to_char(make_interval(mins=>(x->>'expected_min')::INT),'HH24:MI')||
        ' เข้า '||to_char(make_interval(mins=>(x->>'actual_min')::INT),'HH24:MI')||' สาย '||(x->>'late_min')||' นาที',E'\n' ORDER BY x->>'work_date')
        FROM jsonb_array_elements(NEW.late_incidents_snapshot) x);
  ELSE
    IF NEW.late_incidents_snapshot IS DISTINCT FROM OLD.late_incidents_snapshot THEN
      RAISE EXCEPTION 'ไม่สามารถแก้ไขหลักฐานสะสมโดยตรงได้ กรุณาทบทวนยอด';
    END IF;
    NEW.effective_until := (NEW.incident_date+INTERVAL '1 year')::DATE;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_hr_late_warning_guard BEFORE INSERT OR UPDATE OR DELETE ON hr_warnings
  FOR EACH ROW EXECUTE FUNCTION hr_late_warning_guard();

CREATE FUNCTION hr_late_review_warning(p_warning UUID) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE w hr_warnings; summary JSONB; row_data JSONB;
BEGIN
  IF NOT check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ทบทวนเคส'; END IF;
  SELECT * INTO w FROM hr_warnings WHERE id=p_warning FOR UPDATE;
  IF NOT FOUND OR NOT w.late_generated OR w.status NOT IN ('draft','changes_requested','pending_review','pending_approval') THEN
    RAISE EXCEPTION 'ทบทวนได้เฉพาะเคสก่อนอนุมัติ หากอนุมัติแล้วให้ยกเลิกหรือเพิกถอน';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(w.employee_id::TEXT,653));
  summary := hr_late_summary_internal();
  SELECT x INTO row_data FROM jsonb_array_elements(summary->'rows') x WHERE x->>'employee_id'=w.employee_id::TEXT;
  IF row_data IS NULL OR (row_data->>'pending_emergency_count')::INT>0
    OR ((row_data->>'late_count')::INT<3 AND (row_data->>'late_minutes')::INT<120)
    OR w.warning_level IS DISTINCT FROM row_data->>'next_level' THEN
    RAISE EXCEPTION 'ยอดหรือขั้นไม่ตรงเกณฑ์ กรุณายกเลิกเคสและพิจารณาใหม่';
  END IF;
  UPDATE hr_warnings SET status='changes_requested',late_incidents_snapshot=row_data->'incidents',reviewed_at=NULL,reviewer_id=NULL
    WHERE id=p_warning;
  INSERT INTO hr_late_audit(action,actor,old_data,new_data) VALUES('review_case',auth.uid(),to_jsonb(w),
    jsonb_build_object('warning_id',p_warning,'incidents',row_data->'incidents'));
END; $$;

REVOKE ALL ON FUNCTION hr_late_events_internal(DATE,DATE),hr_late_summary_internal() FROM PUBLIC,authenticated;
REVOKE ALL ON FUNCTION hr_late_warning_guard() FROM PUBLIC,authenticated;
REVOKE ALL ON FUNCTION hr_late_review_warning(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hr_late_review_warning(UUID) TO authenticated;
REVOKE ALL ON FUNCTION hr_late_accumulation(),hr_late_ready_count(),hr_late_set_start_date(DATE),
  hr_late_set_exception(UUID,DATE,BOOLEAN,TEXT),hr_late_create_warning(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hr_late_accumulation(),hr_late_ready_count(),hr_late_set_start_date(DATE),
  hr_late_set_exception(UUID,DATE,BOOLEAN,TEXT),hr_late_create_warning(UUID) TO authenticated;

DO $$
DECLARE table_name TEXT;
BEGIN
  IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
    FOREACH table_name IN ARRAY ARRAY['hr_late_settings','hr_late_exceptions','hr_warnings'] LOOP
      IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime'
        AND schemaname='public' AND tablename=table_name) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I',table_name);
      END IF;
    END LOOP;
  END IF;
END; $$;

NOTIFY pgrst, 'reload schema';
CREATE OR REPLACE FUNCTION hr_warning_workflow(p_warning UUID,p_action TEXT,p_note TEXT DEFAULT NULL)
RETURNS hr_warnings LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE w hr_warnings; emp UUID;
BEGIN
  IF NOT check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ดำเนินการใบเตือน'; END IF;
  SELECT * INTO w FROM hr_warnings WHERE id=p_warning FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบเคสใบเตือน'; END IF;
  SELECT id INTO emp FROM hr_employees WHERE user_id=auth.uid();
  IF p_action='submit_review' AND w.status IN ('draft','changes_requested') THEN
    IF w.offense_type_id IS NULL OR NULLIF(btrim(COALESCE(w.corrective_action,'')),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุประเภทความผิดและสิ่งที่ต้องปรับปรุง'; END IF;
    UPDATE hr_warnings SET status='pending_review' WHERE id=p_warning;
    INSERT INTO hr_warning_approvals(warning_id,step,actor_id,action,note) VALUES(p_warning,'review',emp,'submitted',p_note);
  ELSIF p_action='send_approval' AND w.status='pending_review' THEN
    UPDATE hr_warnings SET status='pending_approval',reviewer_id=emp,reviewed_at=now() WHERE id=p_warning;
    INSERT INTO hr_warning_approvals(warning_id,step,actor_id,action,note) VALUES(p_warning,'review',emp,'approved',p_note);
  ELSIF p_action='return' AND w.status IN ('pending_review','pending_approval') THEN
    UPDATE hr_warnings SET status='changes_requested' WHERE id=p_warning;
    INSERT INTO hr_warning_approvals(warning_id,step,actor_id,action,note) VALUES(p_warning,CASE WHEN w.status='pending_review' THEN 'review' ELSE 'approval' END,emp,'returned',p_note);
  ELSIF p_action='approve' AND w.status='pending_approval' THEN
    IF w.approver_id IS NOT NULL AND w.approver_id IS DISTINCT FROM emp THEN RAISE EXCEPTION 'เฉพาะผู้อนุมัติที่ระบุในเคสเท่านั้นที่อนุมัติได้'; END IF;
    UPDATE hr_warnings SET status=CASE WHEN warning_level='termination_review' THEN 'termination_review' ELSE 'pending_acknowledgement' END,
      approver_id=emp,approved_at=now(),issued_date=CURRENT_DATE,
      warning_number=COALESCE(warning_number,'WRN-'||to_char(now(),'YYYY')||'-'||lpad(nextval('hr_warning_number_seq')::text,5,'0')) WHERE id=p_warning;
    INSERT INTO hr_warning_approvals(warning_id,step,actor_id,action,note) VALUES(p_warning,'approval',emp,'approved',p_note);
  ELSIF p_action='cancel' AND w.status<>'cancelled' AND (w.status<>'closed' OR w.late_generated) THEN
    IF NULLIF(btrim(p_note),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลในการยกเลิก'; END IF;
    UPDATE hr_warnings SET status='cancelled',cancelled_at=now(),resolution_note=p_note WHERE id=p_warning;
  ELSIF p_action='close' AND w.status IN ('acknowledged','acknowledgement_refused','termination_review') THEN
    UPDATE hr_warnings SET status='closed',closed_at=now() WHERE id=p_warning;
  ELSE RAISE EXCEPTION 'ไม่สามารถดำเนินการจากสถานะปัจจุบันได้'; END IF;
  RETURN (SELECT x FROM hr_warnings x WHERE x.id=p_warning);
END; $$;


