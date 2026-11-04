-- Separate permanent and daily payroll runs and persist daily wage evidence.

ALTER TABLE public.hr_payroll_runs
  ADD COLUMN IF NOT EXISTS payroll_type TEXT NOT NULL DEFAULT 'permanent'
    CHECK (payroll_type IN ('permanent', 'daily'));

ALTER TABLE public.hr_payroll_runs
  DROP CONSTRAINT IF EXISTS hr_payroll_runs_payroll_month_company_id_key;

ALTER TABLE public.hr_payroll_runs
  DROP CONSTRAINT IF EXISTS hr_payroll_runs_month_company_type_key;

ALTER TABLE public.hr_payroll_runs
  ADD CONSTRAINT hr_payroll_runs_month_company_type_key
    UNIQUE (payroll_month, company_id, payroll_type);

ALTER TABLE public.hr_payroll_items
  ADD COLUMN IF NOT EXISTS pay_type TEXT NOT NULL DEFAULT 'permanent'
    CHECK (pay_type IN ('permanent', 'daily')),
  ADD COLUMN IF NOT EXISTS daily_rate NUMERIC(12,2) NOT NULL DEFAULT 0
    CHECK (daily_rate >= 0),
  ADD COLUMN IF NOT EXISTS full_days NUMERIC(6,2) NOT NULL DEFAULT 0
    CHECK (full_days >= 0),
  ADD COLUMN IF NOT EXISTS half_days NUMERIC(6,2) NOT NULL DEFAULT 0
    CHECK (half_days >= 0),
  ADD COLUMN IF NOT EXISTS paid_holiday_days NUMERIC(6,2) NOT NULL DEFAULT 0
    CHECK (paid_holiday_days >= 0),
  ADD COLUMN IF NOT EXISTS unpaid_leave_days NUMERIC(6,2) NOT NULL DEFAULT 0
    CHECK (unpaid_leave_days >= 0),
  ADD COLUMN IF NOT EXISTS payable_days NUMERIC(6,2) NOT NULL DEFAULT 0
    CHECK (payable_days >= 0),
  ADD COLUMN IF NOT EXISTS unresolved_attendance_days INTEGER NOT NULL DEFAULT 0
    CHECK (unresolved_attendance_days >= 0),
  ADD COLUMN IF NOT EXISTS daily_wage_details JSONB NOT NULL DEFAULT '[]'::JSONB;

CREATE INDEX IF NOT EXISTS idx_hr_payroll_runs_type
  ON public.hr_payroll_runs (payroll_type, payroll_month, company_id);

COMMENT ON COLUMN public.hr_payroll_items.base_salary IS
  'Permanent: monthly base salary; daily: regular wage for payable days';
COMMENT ON COLUMN public.hr_payroll_items.daily_wage_details IS
  'Immutable per-date evidence used to calculate a confirmed daily payroll item';

NOTIFY pgrst, 'reload schema';
