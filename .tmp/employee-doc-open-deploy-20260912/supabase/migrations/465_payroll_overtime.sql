-- Persist approved, attendance-backed overtime in payroll snapshots.

ALTER TABLE public.hr_payroll_items
  ADD COLUMN IF NOT EXISTS ot_normal_hours NUMERIC(8,2) NOT NULL DEFAULT 0
    CHECK (ot_normal_hours >= 0),
  ADD COLUMN IF NOT EXISTS ot_holiday_hours NUMERIC(8,2) NOT NULL DEFAULT 0
    CHECK (ot_holiday_hours >= 0),
  ADD COLUMN IF NOT EXISTS overtime_pay NUMERIC(12,2) NOT NULL DEFAULT 0
    CHECK (overtime_pay >= 0);

ALTER TABLE public.hr_payroll_items
  DROP COLUMN IF EXISTS net_pay,
  DROP COLUMN IF EXISTS gross_income;

ALTER TABLE public.hr_payroll_items
  ADD COLUMN gross_income NUMERIC(12,2)
    GENERATED ALWAYS AS (
      base_salary + position_allowance + overtime_pay + other_income
    ) STORED,
  ADD COLUMN net_pay NUMERIC(12,2)
    GENERATED ALWAYS AS (
      (base_salary + position_allowance + overtime_pay + other_income)
      - (personal_tax + social_security + ewf + savings + student_loan
        + company_loan + leave_deduction + other_deduction)
    ) STORED;

COMMENT ON COLUMN public.hr_payroll_items.ot_normal_hours IS
  'Approved actual OT hours on normal workdays, capped at approved request hours';
COMMENT ON COLUMN public.hr_payroll_items.ot_holiday_hours IS
  'Approved actual OT hours on company holidays or weekly days off';
COMMENT ON COLUMN public.hr_payroll_items.overtime_pay IS
  'OT pay snapshot: normal hours at 1.5x plus holiday hours at 3x';

NOTIFY pgrst, 'reload schema';
