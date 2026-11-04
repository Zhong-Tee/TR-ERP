-- =============================================================================
-- HR Module: Tables, RPC, RLS, Triggers, Storage Buckets
-- IDEMPOTENT: safe to re-run
-- =============================================================================

-- ─── 1. hr_departments ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  manager_id UUID,
  telegram_group_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 2. hr_positions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  department_id UUID REFERENCES hr_departments(id) ON DELETE SET NULL,
  level INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(name, department_id)
);

-- ─── 3. hr_employees (Master) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code TEXT UNIQUE NOT NULL,
  citizen_id TEXT UNIQUE,
  prefix TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  first_name_en TEXT,
  last_name_en TEXT,
  nickname TEXT,
  birth_date DATE,
  gender TEXT,
  religion TEXT,
  address JSONB,
  current_address JSONB,
  phone TEXT,
  emergency_contact JSONB,
  photo_url TEXT,
  department_id UUID REFERENCES hr_departments(id) ON DELETE SET NULL,
  position_id UUID REFERENCES hr_positions(id) ON DELETE SET NULL,
  salary NUMERIC(12,2),
  hire_date DATE,
  probation_end_date DATE,
  employment_status TEXT DEFAULT 'active',
  fingerprint_id_old TEXT,
  fingerprint_id_new TEXT,
  user_id UUID REFERENCES us_users(id) ON DELETE SET NULL,
  telegram_chat_id TEXT,
  documents JSONB DEFAULT '[]',
  card_issue_date DATE,
  card_expiry_date DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- back-reference from hr_departments.manager_id
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_departments_manager_fk') THEN
    ALTER TABLE hr_departments ADD CONSTRAINT hr_departments_manager_fk
      FOREIGN KEY (manager_id) REFERENCES hr_employees(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_hr_employees_department ON hr_employees(department_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_status ON hr_employees(employment_status);
CREATE INDEX IF NOT EXISTS idx_hr_employees_user ON hr_employees(user_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_fingerprint_old ON hr_employees(fingerprint_id_old);
CREATE INDEX IF NOT EXISTS idx_hr_employees_fingerprint_new ON hr_employees(fingerprint_id_new);

-- ─── 4. hr_leave_types ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_leave_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  max_days_per_year INT,
  requires_doc BOOLEAN DEFAULT false,
  is_paid BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 5. hr_leave_requests ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  leave_type_id UUID NOT NULL REFERENCES hr_leave_types(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  total_days NUMERIC(4,1) NOT NULL,
  reason TEXT,
  status TEXT DEFAULT 'pending',
  approved_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  reject_reason TEXT,
  medical_cert_url TEXT,
  notified_before BOOLEAN DEFAULT false,
  notified_morning BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_employee ON hr_leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_status ON hr_leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_dates ON hr_leave_requests(start_date, end_date);

-- ─── 6. hr_leave_balances ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_leave_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  leave_type_id UUID NOT NULL REFERENCES hr_leave_types(id),
  year INT NOT NULL,
  entitled_days NUMERIC(4,1) NOT NULL,
  used_days NUMERIC(4,1) DEFAULT 0,
  carried_days NUMERIC(4,1) DEFAULT 0,
  UNIQUE(employee_id, leave_type_id, year)
);

-- ─── 7. hr_candidates ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id TEXT,
  prefix TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  first_name_en TEXT,
  last_name_en TEXT,
  birth_date DATE,
  gender TEXT,
  religion TEXT,
  address JSONB,
  photo_url TEXT,
  phone TEXT,
  applied_position TEXT,
  applied_department_id UUID REFERENCES hr_departments(id) ON DELETE SET NULL,
  resume_url TEXT,
  source TEXT,
  status TEXT DEFAULT 'new',
  custom_field_1 TEXT,
  custom_field_2 TEXT,
  custom_field_3 TEXT,
  custom_field_4 TEXT,
  raw_siam_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 8. hr_interviews ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_interviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID NOT NULL REFERENCES hr_candidates(id) ON DELETE CASCADE,
  interview_date TIMESTAMPTZ NOT NULL,
  location TEXT,
  interviewer_ids UUID[] DEFAULT '{}',
  status TEXT DEFAULT 'scheduled',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_interviews_date ON hr_interviews(interview_date);

-- ─── 9. hr_interview_scores ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_interview_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id UUID NOT NULL REFERENCES hr_interviews(id) ON DELETE CASCADE,
  interviewer_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  criteria JSONB NOT NULL,
  total_score NUMERIC(6,2),
  max_possible NUMERIC(6,2),
  recommendation TEXT,
  comments TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 10. hr_attendance_uploads ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_attendance_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  file_url TEXT,
  uploaded_by UUID REFERENCES us_users(id) ON DELETE SET NULL,
  row_count INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 11. hr_attendance_summary ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_attendance_summary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID REFERENCES hr_attendance_uploads(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  fingerprint_id TEXT,
  employee_name TEXT,
  department TEXT,
  source TEXT NOT NULL,
  period_start DATE,
  period_end DATE,
  scheduled_hours NUMERIC(8,2),
  actual_hours NUMERIC(8,2),
  overtime_hours NUMERIC(8,2) DEFAULT 0,
  late_count INT DEFAULT 0,
  late_minutes INT DEFAULT 0,
  early_leave_count INT DEFAULT 0,
  early_leave_minutes INT DEFAULT 0,
  absent_days NUMERIC(4,1) DEFAULT 0,
  leave_days NUMERIC(4,1) DEFAULT 0,
  work_days_required INT DEFAULT 0,
  work_days_actual INT DEFAULT 0,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_attendance_summary_upload ON hr_attendance_summary(upload_id);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_summary_employee ON hr_attendance_summary(employee_id);

-- ─── 12. hr_attendance_daily ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_attendance_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID REFERENCES hr_attendance_uploads(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  fingerprint_id TEXT,
  employee_name TEXT,
  source TEXT NOT NULL,
  work_date DATE NOT NULL,
  shift_code TEXT,
  clock_in TIME,
  clock_out TIME,
  clock_in_2 TIME,
  clock_out_2 TIME,
  late_minutes INT DEFAULT 0,
  early_minutes INT DEFAULT 0,
  is_absent BOOLEAN DEFAULT false,
  is_holiday BOOLEAN DEFAULT false,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_attendance_daily_upload ON hr_attendance_daily(upload_id);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_daily_date ON hr_attendance_daily(work_date);

-- ─── 13. hr_contract_templates ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_contract_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  template_content TEXT NOT NULL,
  placeholders JSONB DEFAULT '[]',
  is_active BOOLEAN DEFAULT true,
  version INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 14. hr_contracts ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  template_id UUID REFERENCES hr_contract_templates(id) ON DELETE SET NULL,
  contract_number TEXT UNIQUE,
  content TEXT NOT NULL,
  start_date DATE,
  end_date DATE,
  salary NUMERIC(12,2),
  position TEXT,
  status TEXT DEFAULT 'draft',
  pdf_url TEXT,
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_contracts_employee ON hr_contracts(employee_id);

-- ─── 15. hr_document_categories ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_document_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  parent_id UUID REFERENCES hr_document_categories(id) ON DELETE SET NULL,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_doc_cat_name_parent
  ON hr_document_categories (name, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'));

-- ─── 16. hr_documents ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID REFERENCES hr_document_categories(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  file_url TEXT,
  content TEXT,
  department_id UUID REFERENCES hr_departments(id) ON DELETE SET NULL,
  level TEXT,
  version TEXT DEFAULT '1.0',
  is_active BOOLEAN DEFAULT true,
  requires_acknowledgment BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 17. hr_exams ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_exams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  department_id UUID REFERENCES hr_departments(id) ON DELETE SET NULL,
  level TEXT,
  passing_score NUMERIC(5,2) NOT NULL,
  time_limit_minutes INT,
  questions JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 18. hr_exam_results ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_exam_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id UUID NOT NULL REFERENCES hr_exams(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  answers JSONB NOT NULL,
  score NUMERIC(5,2) NOT NULL,
  max_score NUMERIC(5,2) NOT NULL,
  percentage NUMERIC(5,2) NOT NULL,
  passed BOOLEAN NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 19. hr_document_reads ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_document_reads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES hr_documents(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ DEFAULT now(),
  acknowledged BOOLEAN DEFAULT false,
  UNIQUE(document_id, employee_id)
);

-- ─── 20. hr_onboarding_templates ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_onboarding_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id UUID REFERENCES hr_departments(id) ON DELETE SET NULL,
  position_id UUID REFERENCES hr_positions(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  phases JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 21. hr_onboarding_plans ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_onboarding_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  template_id UUID REFERENCES hr_onboarding_templates(id) ON DELETE SET NULL,
  mentor_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  supervisor_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  manager_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  start_date DATE NOT NULL,
  expected_end_date DATE,
  status TEXT DEFAULT 'in_progress',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 22. hr_onboarding_progress ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_onboarding_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES hr_onboarding_plans(id) ON DELETE CASCADE,
  phase_index INT NOT NULL,
  task_index INT NOT NULL,
  status TEXT DEFAULT 'pending',
  score NUMERIC(5,2),
  evaluated_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  evaluated_at TIMESTAMPTZ,
  note TEXT,
  due_date DATE,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 23. hr_career_tracks ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_career_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  department_id UUID REFERENCES hr_departments(id) ON DELETE SET NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 24. hr_career_levels ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_career_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID NOT NULL REFERENCES hr_career_tracks(id) ON DELETE CASCADE,
  position_id UUID REFERENCES hr_positions(id) ON DELETE SET NULL,
  level_order INT NOT NULL,
  title TEXT NOT NULL,
  salary_min NUMERIC(12,2) NOT NULL,
  salary_max NUMERIC(12,2) NOT NULL,
  salary_step NUMERIC(12,2),
  requirements JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(track_id, level_order)
);

-- ─── 25. hr_employee_career ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_employee_career (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  track_id UUID NOT NULL REFERENCES hr_career_tracks(id) ON DELETE CASCADE,
  current_level_id UUID NOT NULL REFERENCES hr_career_levels(id),
  current_salary NUMERIC(12,2),
  effective_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, track_id)
);

-- ─── 26. hr_career_history ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_career_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  from_level_id UUID REFERENCES hr_career_levels(id) ON DELETE SET NULL,
  to_level_id UUID NOT NULL REFERENCES hr_career_levels(id),
  from_salary NUMERIC(12,2),
  to_salary NUMERIC(12,2),
  effective_date DATE NOT NULL,
  reason TEXT,
  approved_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 27. hr_notification_settings ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_notification_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_token TEXT NOT NULL,
  hr_group_chat_id TEXT,
  manager_group_chat_id TEXT,
  leave_notify_before_days INT DEFAULT 1,
  leave_notify_morning_time TIME DEFAULT '07:00',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 28. hr_notification_logs (Telegram) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  target_chat_id TEXT,
  message TEXT,
  status TEXT DEFAULT 'sent',
  error TEXT,
  related_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 29. hr_notifications (In-App) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  link TEXT,
  is_read BOOLEAN DEFAULT false,
  related_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_notifications_employee ON hr_notifications(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_notifications_unread ON hr_notifications(employee_id, is_read) WHERE NOT is_read;

-- =============================================================================
-- RLS: Enable
-- =============================================================================
ALTER TABLE hr_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_leave_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_interview_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_attendance_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_attendance_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_attendance_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_contract_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_document_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_exam_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_document_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_onboarding_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_onboarding_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_onboarding_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_career_tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_career_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employee_career ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_career_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_notification_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_notifications ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- Helper Functions
-- =============================================================================
CREATE OR REPLACE FUNCTION hr_is_admin() RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM us_users
    WHERE id = auth.uid()
      AND role IN ('superadmin','admin','admin-tr','hr')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION hr_my_employee_id() RETURNS UUID AS $$
  SELECT id FROM hr_employees WHERE user_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- =============================================================================
-- RLS Policies (DROP IF EXISTS + CREATE)
-- =============================================================================

-- hr_departments
DROP POLICY IF EXISTS "hr_departments_select" ON hr_departments;
DROP POLICY IF EXISTS "hr_departments_insert" ON hr_departments;
DROP POLICY IF EXISTS "hr_departments_update" ON hr_departments;
DROP POLICY IF EXISTS "hr_departments_delete" ON hr_departments;
CREATE POLICY "hr_departments_select" ON hr_departments FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_departments_insert" ON hr_departments FOR INSERT TO authenticated WITH CHECK (hr_is_admin());
CREATE POLICY "hr_departments_update" ON hr_departments FOR UPDATE TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_departments_delete" ON hr_departments FOR DELETE TO authenticated USING (hr_is_admin());

-- hr_positions
DROP POLICY IF EXISTS "hr_positions_select" ON hr_positions;
DROP POLICY IF EXISTS "hr_positions_insert" ON hr_positions;
DROP POLICY IF EXISTS "hr_positions_update" ON hr_positions;
DROP POLICY IF EXISTS "hr_positions_delete" ON hr_positions;
CREATE POLICY "hr_positions_select" ON hr_positions FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_positions_insert" ON hr_positions FOR INSERT TO authenticated WITH CHECK (hr_is_admin());
CREATE POLICY "hr_positions_update" ON hr_positions FOR UPDATE TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_positions_delete" ON hr_positions FOR DELETE TO authenticated USING (hr_is_admin());

-- hr_leave_types
DROP POLICY IF EXISTS "hr_leave_types_select" ON hr_leave_types;
DROP POLICY IF EXISTS "hr_leave_types_insert" ON hr_leave_types;
DROP POLICY IF EXISTS "hr_leave_types_update" ON hr_leave_types;
DROP POLICY IF EXISTS "hr_leave_types_delete" ON hr_leave_types;
CREATE POLICY "hr_leave_types_select" ON hr_leave_types FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_leave_types_insert" ON hr_leave_types FOR INSERT TO authenticated WITH CHECK (hr_is_admin());
CREATE POLICY "hr_leave_types_update" ON hr_leave_types FOR UPDATE TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_leave_types_delete" ON hr_leave_types FOR DELETE TO authenticated USING (hr_is_admin());

-- hr_employees
DROP POLICY IF EXISTS "hr_employees_select" ON hr_employees;
DROP POLICY IF EXISTS "hr_employees_insert" ON hr_employees;
DROP POLICY IF EXISTS "hr_employees_update" ON hr_employees;
DROP POLICY IF EXISTS "hr_employees_delete" ON hr_employees;
CREATE POLICY "hr_employees_select" ON hr_employees FOR SELECT TO authenticated USING (hr_is_admin() OR user_id = auth.uid());
CREATE POLICY "hr_employees_insert" ON hr_employees FOR INSERT TO authenticated WITH CHECK (hr_is_admin());
CREATE POLICY "hr_employees_update" ON hr_employees FOR UPDATE TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_employees_delete" ON hr_employees FOR DELETE TO authenticated USING (hr_is_admin());

-- hr_leave_requests
DROP POLICY IF EXISTS "hr_leave_requests_select" ON hr_leave_requests;
DROP POLICY IF EXISTS "hr_leave_requests_insert" ON hr_leave_requests;
DROP POLICY IF EXISTS "hr_leave_requests_update" ON hr_leave_requests;
DROP POLICY IF EXISTS "hr_leave_requests_delete" ON hr_leave_requests;
CREATE POLICY "hr_leave_requests_select" ON hr_leave_requests FOR SELECT TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_leave_requests_insert" ON hr_leave_requests FOR INSERT TO authenticated WITH CHECK (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_leave_requests_update" ON hr_leave_requests FOR UPDATE TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_leave_requests_delete" ON hr_leave_requests FOR DELETE TO authenticated USING (hr_is_admin());

-- hr_leave_balances
DROP POLICY IF EXISTS "hr_leave_balances_select" ON hr_leave_balances;
DROP POLICY IF EXISTS "hr_leave_balances_all" ON hr_leave_balances;
CREATE POLICY "hr_leave_balances_select" ON hr_leave_balances FOR SELECT TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_leave_balances_all" ON hr_leave_balances FOR ALL TO authenticated USING (hr_is_admin());

-- hr_candidates, hr_interviews, hr_interview_scores
DROP POLICY IF EXISTS "hr_candidates_all" ON hr_candidates;
DROP POLICY IF EXISTS "hr_interviews_all" ON hr_interviews;
DROP POLICY IF EXISTS "hr_interview_scores_all" ON hr_interview_scores;
CREATE POLICY "hr_candidates_all" ON hr_candidates FOR ALL TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_interviews_all" ON hr_interviews FOR ALL TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_interview_scores_all" ON hr_interview_scores FOR ALL TO authenticated USING (hr_is_admin());

-- hr_attendance
DROP POLICY IF EXISTS "hr_attendance_uploads_all" ON hr_attendance_uploads;
DROP POLICY IF EXISTS "hr_attendance_summary_all" ON hr_attendance_summary;
DROP POLICY IF EXISTS "hr_attendance_daily_all" ON hr_attendance_daily;
CREATE POLICY "hr_attendance_uploads_all" ON hr_attendance_uploads FOR ALL TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_attendance_summary_all" ON hr_attendance_summary FOR ALL TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_attendance_daily_all" ON hr_attendance_daily FOR ALL TO authenticated USING (hr_is_admin());

-- hr_contracts
DROP POLICY IF EXISTS "hr_contract_templates_select" ON hr_contract_templates;
DROP POLICY IF EXISTS "hr_contract_templates_manage" ON hr_contract_templates;
DROP POLICY IF EXISTS "hr_contracts_select" ON hr_contracts;
DROP POLICY IF EXISTS "hr_contracts_manage" ON hr_contracts;
CREATE POLICY "hr_contract_templates_select" ON hr_contract_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_contract_templates_manage" ON hr_contract_templates FOR ALL TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_contracts_select" ON hr_contracts FOR SELECT TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_contracts_manage" ON hr_contracts FOR ALL TO authenticated USING (hr_is_admin());

-- hr_documents, categories, exams
DROP POLICY IF EXISTS "hr_document_categories_select" ON hr_document_categories;
DROP POLICY IF EXISTS "hr_document_categories_manage" ON hr_document_categories;
DROP POLICY IF EXISTS "hr_documents_select" ON hr_documents;
DROP POLICY IF EXISTS "hr_documents_manage" ON hr_documents;
DROP POLICY IF EXISTS "hr_exams_select" ON hr_exams;
DROP POLICY IF EXISTS "hr_exams_manage" ON hr_exams;
DROP POLICY IF EXISTS "hr_exam_results_select" ON hr_exam_results;
DROP POLICY IF EXISTS "hr_exam_results_insert" ON hr_exam_results;
DROP POLICY IF EXISTS "hr_document_reads_select" ON hr_document_reads;
DROP POLICY IF EXISTS "hr_document_reads_insert" ON hr_document_reads;
DROP POLICY IF EXISTS "hr_document_reads_update" ON hr_document_reads;
CREATE POLICY "hr_document_categories_select" ON hr_document_categories FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_document_categories_manage" ON hr_document_categories FOR ALL TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_documents_select" ON hr_documents FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_documents_manage" ON hr_documents FOR ALL TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_exams_select" ON hr_exams FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_exams_manage" ON hr_exams FOR ALL TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_exam_results_select" ON hr_exam_results FOR SELECT TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_exam_results_insert" ON hr_exam_results FOR INSERT TO authenticated WITH CHECK (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_document_reads_select" ON hr_document_reads FOR SELECT TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_document_reads_insert" ON hr_document_reads FOR INSERT TO authenticated WITH CHECK (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_document_reads_update" ON hr_document_reads FOR UPDATE TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());

-- hr_onboarding
DROP POLICY IF EXISTS "hr_onboarding_templates_select" ON hr_onboarding_templates;
DROP POLICY IF EXISTS "hr_onboarding_templates_manage" ON hr_onboarding_templates;
DROP POLICY IF EXISTS "hr_onboarding_plans_select" ON hr_onboarding_plans;
DROP POLICY IF EXISTS "hr_onboarding_plans_manage" ON hr_onboarding_plans;
DROP POLICY IF EXISTS "hr_onboarding_progress_select" ON hr_onboarding_progress;
DROP POLICY IF EXISTS "hr_onboarding_progress_manage" ON hr_onboarding_progress;
CREATE POLICY "hr_onboarding_templates_select" ON hr_onboarding_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_onboarding_templates_manage" ON hr_onboarding_templates FOR ALL TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_onboarding_plans_select" ON hr_onboarding_plans FOR SELECT TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_onboarding_plans_manage" ON hr_onboarding_plans FOR ALL TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_onboarding_progress_select" ON hr_onboarding_progress FOR SELECT TO authenticated USING (hr_is_admin() OR plan_id IN (SELECT id FROM hr_onboarding_plans WHERE employee_id = hr_my_employee_id()));
CREATE POLICY "hr_onboarding_progress_manage" ON hr_onboarding_progress FOR ALL TO authenticated USING (hr_is_admin());

-- hr_career
DROP POLICY IF EXISTS "hr_career_tracks_select" ON hr_career_tracks;
DROP POLICY IF EXISTS "hr_career_tracks_manage" ON hr_career_tracks;
DROP POLICY IF EXISTS "hr_career_levels_select" ON hr_career_levels;
DROP POLICY IF EXISTS "hr_career_levels_manage" ON hr_career_levels;
DROP POLICY IF EXISTS "hr_employee_career_select" ON hr_employee_career;
DROP POLICY IF EXISTS "hr_employee_career_manage" ON hr_employee_career;
DROP POLICY IF EXISTS "hr_career_history_select" ON hr_career_history;
DROP POLICY IF EXISTS "hr_career_history_manage" ON hr_career_history;
CREATE POLICY "hr_career_tracks_select" ON hr_career_tracks FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_career_tracks_manage" ON hr_career_tracks FOR ALL TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_career_levels_select" ON hr_career_levels FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_career_levels_manage" ON hr_career_levels FOR ALL TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_employee_career_select" ON hr_employee_career FOR SELECT TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_employee_career_manage" ON hr_employee_career FOR ALL TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_career_history_select" ON hr_career_history FOR SELECT TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_career_history_manage" ON hr_career_history FOR ALL TO authenticated USING (hr_is_admin());

-- hr_notification_settings
DROP POLICY IF EXISTS "hr_notification_settings_all" ON hr_notification_settings;
CREATE POLICY "hr_notification_settings_all" ON hr_notification_settings FOR ALL TO authenticated USING (hr_is_admin());

-- hr_notification_logs
DROP POLICY IF EXISTS "hr_notification_logs_select" ON hr_notification_logs;
DROP POLICY IF EXISTS "hr_notification_logs_insert" ON hr_notification_logs;
CREATE POLICY "hr_notification_logs_select" ON hr_notification_logs FOR SELECT TO authenticated USING (hr_is_admin());
CREATE POLICY "hr_notification_logs_insert" ON hr_notification_logs FOR INSERT TO authenticated WITH CHECK (hr_is_admin());

-- hr_notifications
DROP POLICY IF EXISTS "hr_notifications_select" ON hr_notifications;
DROP POLICY IF EXISTS "hr_notifications_update" ON hr_notifications;
DROP POLICY IF EXISTS "hr_notifications_insert" ON hr_notifications;
DROP POLICY IF EXISTS "hr_notifications_delete" ON hr_notifications;
CREATE POLICY "hr_notifications_select" ON hr_notifications FOR SELECT TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_notifications_update" ON hr_notifications FOR UPDATE TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_notifications_insert" ON hr_notifications FOR INSERT TO authenticated WITH CHECK (hr_is_admin());
CREATE POLICY "hr_notifications_delete" ON hr_notifications FOR DELETE TO authenticated USING (hr_is_admin());

-- =============================================================================
-- Triggers: updated_at
-- =============================================================================
CREATE OR REPLACE FUNCTION hr_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_hr_employees_updated ON hr_employees;
DROP TRIGGER IF EXISTS trg_hr_leave_requests_updated ON hr_leave_requests;
DROP TRIGGER IF EXISTS trg_hr_candidates_updated ON hr_candidates;
DROP TRIGGER IF EXISTS trg_hr_contract_templates_updated ON hr_contract_templates;
DROP TRIGGER IF EXISTS trg_hr_contracts_updated ON hr_contracts;
DROP TRIGGER IF EXISTS trg_hr_documents_updated ON hr_documents;
DROP TRIGGER IF EXISTS trg_hr_exams_updated ON hr_exams;
DROP TRIGGER IF EXISTS trg_hr_onboarding_templates_updated ON hr_onboarding_templates;
DROP TRIGGER IF EXISTS trg_hr_onboarding_plans_updated ON hr_onboarding_plans;
DROP TRIGGER IF EXISTS trg_hr_notification_settings_updated ON hr_notification_settings;

CREATE TRIGGER trg_hr_employees_updated BEFORE UPDATE ON hr_employees FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();
CREATE TRIGGER trg_hr_leave_requests_updated BEFORE UPDATE ON hr_leave_requests FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();
CREATE TRIGGER trg_hr_candidates_updated BEFORE UPDATE ON hr_candidates FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();
CREATE TRIGGER trg_hr_contract_templates_updated BEFORE UPDATE ON hr_contract_templates FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();
CREATE TRIGGER trg_hr_contracts_updated BEFORE UPDATE ON hr_contracts FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();
CREATE TRIGGER trg_hr_documents_updated BEFORE UPDATE ON hr_documents FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();
CREATE TRIGGER trg_hr_exams_updated BEFORE UPDATE ON hr_exams FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();
CREATE TRIGGER trg_hr_onboarding_templates_updated BEFORE UPDATE ON hr_onboarding_templates FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();
CREATE TRIGGER trg_hr_onboarding_plans_updated BEFORE UPDATE ON hr_onboarding_plans FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();
CREATE TRIGGER trg_hr_notification_settings_updated BEFORE UPDATE ON hr_notification_settings FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

-- =============================================================================
-- Trigger: leave notification
-- =============================================================================
CREATE OR REPLACE FUNCTION hr_leave_notify() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO hr_notifications (employee_id, type, title, message, link, related_id)
    SELECT e.id, 'leave_approval_pending', 'มีใบลารออนุมัติ',
      NEW.reason, '/hr/leave', NEW.id
    FROM hr_employees e
    JOIN us_users u ON u.id = e.user_id
    WHERE u.role IN ('superadmin','admin','admin-tr','hr')
    LIMIT 5;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status IN ('approved','rejected') THEN
    INSERT INTO hr_notifications (employee_id, type, title, message, link, related_id)
    VALUES (
      NEW.employee_id,
      'leave_result',
      CASE WHEN NEW.status = 'approved' THEN 'ใบลาได้รับการอนุมัติ' ELSE 'ใบลาถูกปฏิเสธ' END,
      COALESCE(NEW.reject_reason, ''),
      '/employee/leave',
      NEW.id
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_hr_leave_notify ON hr_leave_requests;
CREATE TRIGGER trg_hr_leave_notify
  AFTER INSERT OR UPDATE ON hr_leave_requests
  FOR EACH ROW EXECUTE FUNCTION hr_leave_notify();

-- =============================================================================
-- Trigger: medical cert reminder
-- =============================================================================
CREATE OR REPLACE FUNCTION hr_medical_cert_reminder() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'approved'
     AND NEW.total_days > 1
     AND NEW.medical_cert_url IS NULL
     AND EXISTS (SELECT 1 FROM hr_leave_types WHERE id = NEW.leave_type_id AND name ILIKE '%ป่วย%')
  THEN
    INSERT INTO hr_notifications (employee_id, type, title, message, link, related_id)
    VALUES (
      NEW.employee_id,
      'medical_cert_required',
      'กรุณาอัปโหลดใบรับรองแพทย์',
      'คุณลาป่วยเกิน 1 วัน กรุณาอัปโหลดใบรับรองแพทย์',
      '/employee/leave',
      NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_hr_medical_cert_reminder ON hr_leave_requests;
CREATE TRIGGER trg_hr_medical_cert_reminder
  AFTER UPDATE ON hr_leave_requests
  FOR EACH ROW EXECUTE FUNCTION hr_medical_cert_reminder();

-- =============================================================================
-- RPC Functions
-- =============================================================================

CREATE OR REPLACE FUNCTION get_hr_dashboard(p_employee_id UUID DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'total_employees', (SELECT count(*) FROM hr_employees WHERE employment_status IN ('active','probation')),
    'pending_leaves', (SELECT count(*) FROM hr_leave_requests WHERE status = 'pending'),
    'today_on_leave', (SELECT count(*) FROM hr_leave_requests WHERE status = 'approved' AND CURRENT_DATE BETWEEN start_date AND end_date),
    'upcoming_interviews', (SELECT count(*) FROM hr_interviews WHERE status = 'scheduled' AND interview_date > now()),
    'active_onboarding', (SELECT count(*) FROM hr_onboarding_plans WHERE status = 'in_progress'),
    'unread_notifications', CASE WHEN p_employee_id IS NOT NULL
      THEN (SELECT count(*) FROM hr_notifications WHERE employee_id = p_employee_id AND NOT is_read)
      ELSE 0 END
  ) INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_employee_leave_summary(p_employee_id UUID, p_year INT)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'balances', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', b.id,
        'leave_type_id', b.leave_type_id,
        'leave_type_name', t.name,
        'entitled_days', b.entitled_days,
        'used_days', b.used_days,
        'carried_days', b.carried_days,
        'remaining', b.entitled_days + b.carried_days - b.used_days
      ))
      FROM hr_leave_balances b
      JOIN hr_leave_types t ON t.id = b.leave_type_id
      WHERE b.employee_id = p_employee_id AND b.year = p_year
    ), '[]'::jsonb),
    'recent_requests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id,
        'leave_type_name', t.name,
        'start_date', r.start_date,
        'end_date', r.end_date,
        'total_days', r.total_days,
        'status', r.status,
        'reason', r.reason,
        'medical_cert_url', r.medical_cert_url,
        'created_at', r.created_at
      ) ORDER BY r.created_at DESC)
      FROM hr_leave_requests r
      JOIN hr_leave_types t ON t.id = r.leave_type_id
      WHERE r.employee_id = p_employee_id
        AND EXTRACT(YEAR FROM r.start_date) = p_year
    ), '[]'::jsonb),
    'pending_count', (
      SELECT count(*) FROM hr_leave_requests
      WHERE employee_id = p_employee_id AND status = 'pending'
    )
  ) INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_onboarding_detail(p_plan_id UUID)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
  v_plan RECORD;
BEGIN
  SELECT * INTO v_plan FROM hr_onboarding_plans WHERE id = p_plan_id;
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;

  SELECT jsonb_build_object(
    'plan', row_to_json(v_plan)::jsonb,
    'employee', (SELECT row_to_json(e)::jsonb FROM hr_employees e WHERE e.id = v_plan.employee_id),
    'mentor', (SELECT row_to_json(e)::jsonb FROM hr_employees e WHERE e.id = v_plan.mentor_id),
    'supervisor', (SELECT row_to_json(e)::jsonb FROM hr_employees e WHERE e.id = v_plan.supervisor_id),
    'manager', (SELECT row_to_json(e)::jsonb FROM hr_employees e WHERE e.id = v_plan.manager_id),
    'template', (SELECT row_to_json(t)::jsonb FROM hr_onboarding_templates t WHERE t.id = v_plan.template_id),
    'progress', COALESCE((
      SELECT jsonb_agg(row_to_json(p)::jsonb ORDER BY p.phase_index, p.task_index)
      FROM hr_onboarding_progress p WHERE p.plan_id = p_plan_id
    ), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_career_path(p_employee_id UUID)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'career', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'track_id', t.id,
        'track_name', t.name,
        'description', t.description,
        'current_level_id', ec.current_level_id,
        'current_salary', ec.current_salary,
        'effective_date', ec.effective_date,
        'levels', (
          SELECT jsonb_agg(jsonb_build_object(
            'id', cl.id,
            'level_order', cl.level_order,
            'title', cl.title,
            'salary_min', cl.salary_min,
            'salary_max', cl.salary_max,
            'salary_step', cl.salary_step,
            'requirements', cl.requirements
          ) ORDER BY cl.level_order)
          FROM hr_career_levels cl WHERE cl.track_id = t.id
        )
      ))
      FROM hr_employee_career ec
      JOIN hr_career_tracks t ON t.id = ec.track_id
      WHERE ec.employee_id = p_employee_id
    ), '[]'::jsonb),
    'history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'from_title', fl.title,
        'to_title', tl.title,
        'from_salary', ch.from_salary,
        'to_salary', ch.to_salary,
        'effective_date', ch.effective_date,
        'reason', ch.reason
      ) ORDER BY ch.effective_date DESC)
      FROM hr_career_history ch
      LEFT JOIN hr_career_levels fl ON fl.id = ch.from_level_id
      JOIN hr_career_levels tl ON tl.id = ch.to_level_id
      WHERE ch.employee_id = p_employee_id
    ), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION batch_upsert_attendance(
  p_upload JSONB,
  p_summaries JSONB,
  p_dailies JSONB
) RETURNS UUID AS $$
DECLARE
  v_upload_id UUID;
  s JSONB;
  d JSONB;
BEGIN
  INSERT INTO hr_attendance_uploads (source, period_start, period_end, file_url, uploaded_by, row_count)
  VALUES (
    p_upload->>'source',
    (p_upload->>'period_start')::DATE,
    (p_upload->>'period_end')::DATE,
    p_upload->>'file_url',
    (p_upload->>'uploaded_by')::UUID,
    (p_upload->>'row_count')::INT
  ) RETURNING id INTO v_upload_id;

  FOR s IN SELECT * FROM jsonb_array_elements(p_summaries) LOOP
    INSERT INTO hr_attendance_summary (
      upload_id, employee_id, fingerprint_id, employee_name, department,
      source, period_start, period_end, scheduled_hours, actual_hours,
      overtime_hours, late_count, late_minutes, early_leave_count,
      early_leave_minutes, absent_days, leave_days, work_days_required,
      work_days_actual, raw_data
    ) VALUES (
      v_upload_id,
      (s->>'employee_id')::UUID,
      s->>'fingerprint_id',
      s->>'employee_name',
      s->>'department',
      s->>'source',
      (s->>'period_start')::DATE,
      (s->>'period_end')::DATE,
      (s->>'scheduled_hours')::NUMERIC,
      (s->>'actual_hours')::NUMERIC,
      COALESCE((s->>'overtime_hours')::NUMERIC, 0),
      COALESCE((s->>'late_count')::INT, 0),
      COALESCE((s->>'late_minutes')::INT, 0),
      COALESCE((s->>'early_leave_count')::INT, 0),
      COALESCE((s->>'early_leave_minutes')::INT, 0),
      COALESCE((s->>'absent_days')::NUMERIC, 0),
      COALESCE((s->>'leave_days')::NUMERIC, 0),
      COALESCE((s->>'work_days_required')::INT, 0),
      COALESCE((s->>'work_days_actual')::INT, 0),
      s->'raw_data'
    );
  END LOOP;

  FOR d IN SELECT * FROM jsonb_array_elements(p_dailies) LOOP
    INSERT INTO hr_attendance_daily (
      upload_id, employee_id, fingerprint_id, employee_name, source,
      work_date, shift_code, clock_in, clock_out, clock_in_2, clock_out_2,
      late_minutes, early_minutes, is_absent, is_holiday, note
    ) VALUES (
      v_upload_id,
      (d->>'employee_id')::UUID,
      d->>'fingerprint_id',
      d->>'employee_name',
      d->>'source',
      (d->>'work_date')::DATE,
      d->>'shift_code',
      (d->>'clock_in')::TIME,
      (d->>'clock_out')::TIME,
      (d->>'clock_in_2')::TIME,
      (d->>'clock_out_2')::TIME,
      COALESCE((d->>'late_minutes')::INT, 0),
      COALESCE((d->>'early_minutes')::INT, 0),
      COALESCE((d->>'is_absent')::BOOLEAN, false),
      COALESCE((d->>'is_holiday')::BOOLEAN, false),
      d->>'note'
    );
  END LOOP;

  RETURN v_upload_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- Realtime (safe: ignore if already added)
-- =============================================================================
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE hr_leave_requests;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE hr_notifications;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- Seed leave types
-- =============================================================================
INSERT INTO hr_leave_types (name, max_days_per_year, requires_doc, is_paid) VALUES
  ('ลาป่วย', 30, true, true),
  ('ลากิจ', 3, false, true),
  ('ลาพักร้อน', 6, false, true),
  ('ลาคลอด', 98, true, true),
  ('ลาบวช', 15, false, true),
  ('ลาไม่รับค่าจ้าง', NULL, false, false)
ON CONFLICT (name) DO NOTHING;

-- =============================================================================
-- Seed document categories
-- =============================================================================
INSERT INTO hr_document_categories (name, sort_order) VALUES
  ('กฏระเบียบบริษัท', 1),
  ('SOP', 2),
  ('W/I', 3),
  ('ข้อสอบ', 4),
  ('คู่มือการทำงาน', 5)
ON CONFLICT (name, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000')) DO NOTHING;

-- =============================================================================
-- Storage Buckets
-- =============================================================================
INSERT INTO storage.buckets (id, name, public) VALUES
  ('hr-photos', 'hr-photos', true),
  ('hr-documents', 'hr-documents', false),
  ('hr-medical-certs', 'hr-medical-certs', false),
  ('hr-contracts', 'hr-contracts', false),
  ('hr-company-docs', 'hr-company-docs', false),
  ('hr-attendance', 'hr-attendance', false),
  ('hr-resumes', 'hr-resumes', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies
DROP POLICY IF EXISTS "hr_photos_select" ON storage.objects;
DROP POLICY IF EXISTS "hr_photos_insert" ON storage.objects;
DROP POLICY IF EXISTS "hr_photos_delete" ON storage.objects;
DROP POLICY IF EXISTS "hr_medical_certs_select" ON storage.objects;
DROP POLICY IF EXISTS "hr_medical_certs_insert" ON storage.objects;
DROP POLICY IF EXISTS "hr_private_buckets_select" ON storage.objects;
DROP POLICY IF EXISTS "hr_private_buckets_insert" ON storage.objects;
DROP POLICY IF EXISTS "hr_private_buckets_delete" ON storage.objects;

CREATE POLICY "hr_photos_select" ON storage.objects FOR SELECT USING (bucket_id = 'hr-photos');
CREATE POLICY "hr_photos_insert" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'hr-photos' AND (SELECT hr_is_admin()));
CREATE POLICY "hr_photos_delete" ON storage.objects FOR DELETE USING (bucket_id = 'hr-photos' AND (SELECT hr_is_admin()));

CREATE POLICY "hr_medical_certs_select" ON storage.objects FOR SELECT USING (bucket_id = 'hr-medical-certs' AND (SELECT hr_is_admin() OR auth.uid() IS NOT NULL));
CREATE POLICY "hr_medical_certs_insert" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'hr-medical-certs' AND auth.uid() IS NOT NULL);

CREATE POLICY "hr_private_buckets_select" ON storage.objects FOR SELECT
  USING (bucket_id IN ('hr-documents','hr-contracts','hr-company-docs','hr-attendance','hr-resumes') AND (SELECT hr_is_admin() OR auth.uid() IS NOT NULL));
CREATE POLICY "hr_private_buckets_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id IN ('hr-documents','hr-contracts','hr-company-docs','hr-attendance','hr-resumes') AND (SELECT hr_is_admin()));
CREATE POLICY "hr_private_buckets_delete" ON storage.objects FOR DELETE
  USING (bucket_id IN ('hr-documents','hr-contracts','hr-company-docs','hr-attendance','hr-resumes') AND (SELECT hr_is_admin()));
