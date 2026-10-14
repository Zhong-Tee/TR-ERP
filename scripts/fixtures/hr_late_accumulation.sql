-- Minimal existing HR schema for isolated PostgreSQL integration tests.
CREATE ROLE authenticated; CREATE ROLE anon;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id UUID PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::UUID;
$$;
CREATE TABLE us_users(id UUID PRIMARY KEY,role TEXT,is_active BOOLEAN DEFAULT true);
CREATE FUNCTION check_user_role(p_user UUID,p_roles TEXT[]) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM us_users WHERE id=p_user AND role=ANY(p_roles));
$$;
CREATE TABLE hr_departments(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),name TEXT);
CREATE TABLE hr_work_schedules(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),work_start TIME,work_end TIME,
 late_grace_min INT,work_days TEXT,is_active BOOLEAN DEFAULT true,is_default BOOLEAN DEFAULT false,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE hr_employees(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),employee_code TEXT,first_name TEXT,last_name TEXT,
 department_id UUID,hire_date DATE,work_mode TEXT DEFAULT 'office',work_schedule_id UUID,
 employment_status TEXT DEFAULT 'active',user_id UUID);
CREATE FUNCTION hr_my_employee_id() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT id FROM hr_employees WHERE user_id=auth.uid() LIMIT 1; $$;
CREATE TABLE hr_employee_work_calendar(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),employee_id UUID,work_date DATE,
 day_type TEXT,work_schedule_id UUID,work_start TIME,work_end TIME);
CREATE TABLE hr_company_holidays(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),holiday_date DATE);
CREATE TABLE hr_wfh_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),employee_id UUID,status TEXT,start_date DATE,end_date DATE,start_time TIME,end_time TIME,approved_at TIMESTAMPTZ);
CREATE TABLE hr_time_entries(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),employee_id UUID,work_date DATE,entry_type TEXT,entry_time TIMESTAMPTZ);
CREATE TABLE hr_time_certifications(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),employee_id UUID,work_date DATE,entry_type TEXT,certified_time TIMESTAMPTZ);
CREATE TABLE hr_leave_types(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),name TEXT);
CREATE TABLE hr_leave_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),employee_id UUID,leave_type_id UUID,
 status TEXT,start_date DATE,end_date DATE,leave_mode TEXT,start_time TIME,end_time TIME,is_emergency BOOLEAN DEFAULT false,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE hr_ot_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),employee_id UUID,request_date DATE,status TEXT,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE hr_warning_offense_types(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),code TEXT);
INSERT INTO hr_warning_offense_types(code) VALUES('late');
CREATE SEQUENCE hr_warning_number_seq;
CREATE SEQUENCE hr_warning_case_seq;
CREATE TABLE hr_warnings(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),employee_id UUID,offense_type_id UUID,
 warning_level TEXT,recommended_level TEXT,subject TEXT,description TEXT,corrective_action TEXT,
 incident_date DATE,effective_until DATE,status TEXT,created_by_user UUID,issued_by UUID,
 created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now(),approved_at TIMESTAMPTZ,
 acknowledged_at TIMESTAMPTZ,reviewed_at TIMESTAMPTZ,reviewer_id UUID,approver_id UUID,issued_date DATE,
 warning_number TEXT,case_number TEXT DEFAULT ('CASE-'||nextval('hr_warning_case_seq')),
 cancelled_at TIMESTAMPTZ,closed_at TIMESTAMPTZ,resolution_note TEXT,employee_response TEXT);
CREATE TABLE hr_warning_approvals(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),warning_id UUID,step TEXT,actor_id UUID,action TEXT,note TEXT);
INSERT INTO auth.users VALUES('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
INSERT INTO us_users VALUES('00000000-0000-0000-0000-000000000001','hr',true),('00000000-0000-0000-0000-000000000002','employee',true);
INSERT INTO hr_work_schedules(work_start,work_end,late_grace_min,work_days,is_default) VALUES('08:30','17:00',5,'1,2,3,4,5,6,7',true);
INSERT INTO hr_employees(id,employee_code,first_name,last_name,user_id) VALUES
 ('00000000-0000-0000-0000-000000000011','E001','Test','Employee','00000000-0000-0000-0000-000000000002'),
 ('00000000-0000-0000-0000-000000000012','HR001','HR','Manager','00000000-0000-0000-0000-000000000001');
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
