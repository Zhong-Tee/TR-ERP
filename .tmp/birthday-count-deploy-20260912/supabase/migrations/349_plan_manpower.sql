CREATE TABLE IF NOT EXISTS plan_employee_profiles (
  employee_id UUID PRIMARY KEY REFERENCES hr_employees(id) ON DELETE CASCADE,
  responsibility_level TEXT NOT NULL DEFAULT 'operator' CHECK (responsibility_level IN ('supervisor','lead','operator','assistant','trainee')),
  is_available_for_planning BOOLEAN NOT NULL DEFAULT true,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS plan_employee_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  department_name TEXT NOT NULL, process_name TEXT NOT NULL,
  proficiency SMALLINT NOT NULL DEFAULT 1 CHECK (proficiency BETWEEN 1 AND 5),
  efficiency_percent NUMERIC(6,2) NOT NULL DEFAULT 100 CHECK (efficiency_percent > 0 AND efficiency_percent <= 300),
  qualification_status TEXT NOT NULL DEFAULT 'qualified' CHECK (qualification_status IN ('qualified','training','blocked')),
  is_primary BOOLEAN NOT NULL DEFAULT false, assessed_at DATE, assessed_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  valid_until DATE, note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, department_name, process_name)
);
CREATE TABLE IF NOT EXISTS plan_operation_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), department_name TEXT NOT NULL, process_name TEXT NOT NULL,
  required_workers SMALLINT NOT NULL DEFAULT 1 CHECK (required_workers > 0),
  minimum_proficiency SMALLINT NOT NULL DEFAULT 1 CHECK (minimum_proficiency BETWEEN 1 AND 5),
  required_supervisors SMALLINT NOT NULL DEFAULT 0 CHECK (required_supervisors >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (department_name, process_name)
);
CREATE TABLE IF NOT EXISTS plan_worker_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), plan_job_id TEXT NOT NULL REFERENCES plan_jobs(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE, department_name TEXT NOT NULL, process_name TEXT NOT NULL,
  line_no SMALLINT NOT NULL DEFAULT 1 CHECK (line_no > 0), planned_start TIMESTAMPTZ NOT NULL, planned_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('suggested','planned','confirmed','in_progress','completed','cancelled')),
  assignment_source TEXT NOT NULL DEFAULT 'manual' CHECK (assignment_source IN ('manual','suggested','automatic')),
  score NUMERIC(7,3), score_detail JSONB NOT NULL DEFAULT '{}', assigned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK (planned_end > planned_start)
);
CREATE INDEX IF NOT EXISTS idx_plan_skills_employee ON plan_employee_skills(employee_id);
CREATE INDEX IF NOT EXISTS idx_plan_skills_operation ON plan_employee_skills(department_name, process_name);
CREATE INDEX IF NOT EXISTS idx_plan_assignments_employee_time ON plan_worker_assignments(employee_id, planned_start, planned_end);
CREATE INDEX IF NOT EXISTS idx_plan_assignments_job ON plan_worker_assignments(plan_job_id);
ALTER TABLE plan_employee_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_employee_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_operation_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_worker_assignments ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['plan_employee_profiles','plan_employee_skills','plan_operation_requirements','plan_worker_assignments'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO authenticated USING (hr_is_admin()) WITH CHECK (hr_is_admin())', t || '_manage', t);
  END LOOP;
END $$;
CREATE TRIGGER trg_plan_employee_profiles_updated BEFORE UPDATE ON plan_employee_profiles FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();
CREATE TRIGGER trg_plan_employee_skills_updated BEFORE UPDATE ON plan_employee_skills FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();
CREATE TRIGGER trg_plan_operation_requirements_updated BEFORE UPDATE ON plan_operation_requirements FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();
CREATE TRIGGER trg_plan_worker_assignments_updated BEFORE UPDATE ON plan_worker_assignments FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();
