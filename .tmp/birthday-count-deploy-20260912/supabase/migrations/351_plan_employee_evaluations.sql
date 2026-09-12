-- Daily/weekly production evaluations for newly hired employees.
CREATE TABLE IF NOT EXISTS plan_employee_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  period_type TEXT NOT NULL CHECK (period_type IN ('daily','weekly')),
  evaluation_date DATE NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  attendance_score SMALLINT CHECK (attendance_score BETWEEN 1 AND 5),
  learning_score SMALLINT CHECK (learning_score BETWEEN 1 AND 5),
  quality_score SMALLINT CHECK (quality_score BETWEEN 1 AND 5),
  teamwork_score SMALLINT CHECK (teamwork_score BETWEEN 1 AND 5),
  discipline_score SMALLINT CHECK (discipline_score BETWEEN 1 AND 5),
  result TEXT NOT NULL DEFAULT 'continue' CHECK (result IN ('continue','passed','failed')),
  strengths TEXT,
  improvements TEXT,
  note TEXT,
  evaluated_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  UNIQUE (employee_id, period_type, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS idx_plan_employee_evaluations_employee_date ON plan_employee_evaluations(employee_id, evaluation_date DESC);
ALTER TABLE plan_employee_evaluations ENABLE ROW LEVEL SECURITY;
CREATE POLICY plan_employee_evaluations_read ON plan_employee_evaluations FOR SELECT TO authenticated USING (true);
CREATE POLICY plan_employee_evaluations_manage ON plan_employee_evaluations FOR ALL TO authenticated USING (hr_is_admin()) WITH CHECK (hr_is_admin());
CREATE TRIGGER trg_plan_employee_evaluations_updated BEFORE UPDATE ON plan_employee_evaluations FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

