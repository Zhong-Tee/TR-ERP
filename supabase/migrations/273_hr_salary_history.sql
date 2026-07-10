-- =============================================================================
-- ประวัติเงินเดือน (hr_salary_history)
--   - เก็บ log การเปลี่ยนแปลงเงินเดือนของพนักงานแต่ละคนตามวันที่มีผล
--   - เงินเดือนล่าสุด (effective_date มากสุด) จะ sync กลับไปที่ hr_employees.salary
-- IDEMPOTENT: รันซ้ำได้
-- =============================================================================

CREATE TABLE IF NOT EXISTS hr_salary_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  salary NUMERIC(12,2) NOT NULL,
  effective_date DATE NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_salary_history_emp
  ON hr_salary_history (employee_id, effective_date DESC, created_at DESC);

ALTER TABLE hr_salary_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hr_salary_history_select" ON hr_salary_history;
DROP POLICY IF EXISTS "hr_salary_history_manage" ON hr_salary_history;
CREATE POLICY "hr_salary_history_select" ON hr_salary_history
  FOR SELECT TO authenticated
  USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_salary_history_manage" ON hr_salary_history
  FOR ALL TO authenticated
  USING (hr_is_admin());
