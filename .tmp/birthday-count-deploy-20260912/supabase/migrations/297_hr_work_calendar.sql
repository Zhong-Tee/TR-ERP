-- HR employee work calendar: per-day overrides and company holidays

CREATE TABLE IF NOT EXISTS hr_company_holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date DATE NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_paid BOOLEAN NOT NULL DEFAULT true,
  note TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hr_employee_work_calendar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  day_type TEXT NOT NULL CHECK (day_type IN ('work', 'weekly_off')),
  work_schedule_id UUID REFERENCES hr_work_schedules(id) ON DELETE SET NULL,
  work_start TIME,
  work_end TIME,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'pattern', 'swap', 'import')),
  note TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date),
  CHECK (work_end IS NULL OR work_start IS NULL OR work_end > work_start)
);

CREATE INDEX IF NOT EXISTS idx_hr_work_calendar_date ON hr_employee_work_calendar(work_date);
CREATE INDEX IF NOT EXISTS idx_hr_work_calendar_employee_date ON hr_employee_work_calendar(employee_id, work_date);

DROP TRIGGER IF EXISTS trg_hr_company_holidays_updated ON hr_company_holidays;
CREATE TRIGGER trg_hr_company_holidays_updated BEFORE UPDATE ON hr_company_holidays
  FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();
DROP TRIGGER IF EXISTS trg_hr_work_calendar_updated ON hr_employee_work_calendar;
CREATE TRIGGER trg_hr_work_calendar_updated BEFORE UPDATE ON hr_employee_work_calendar
  FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

ALTER TABLE hr_company_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employee_work_calendar ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hr_company_holidays_select" ON hr_company_holidays;
DROP POLICY IF EXISTS "hr_company_holidays_manage" ON hr_company_holidays;
CREATE POLICY "hr_company_holidays_select" ON hr_company_holidays FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_company_holidays_manage" ON hr_company_holidays FOR ALL TO authenticated
  USING (hr_is_admin()) WITH CHECK (hr_is_admin());

DROP POLICY IF EXISTS "hr_work_calendar_select" ON hr_employee_work_calendar;
DROP POLICY IF EXISTS "hr_work_calendar_manage" ON hr_employee_work_calendar;
CREATE POLICY "hr_work_calendar_select" ON hr_employee_work_calendar FOR SELECT TO authenticated
  USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_work_calendar_manage" ON hr_employee_work_calendar FOR ALL TO authenticated
  USING (hr_is_admin()) WITH CHECK (hr_is_admin());

COMMENT ON TABLE hr_employee_work_calendar IS 'Per-day work/off overrides; absence of a row falls back to employee work schedule.';
