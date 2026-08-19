-- Repair production databases where the payroll-deduction table predates the
-- salary/deduction snapshots added in migrations 357/358.
ALTER TABLE public.hr_leave_payroll_deductions
  ADD COLUMN IF NOT EXISTS salary_base NUMERIC(12, 2) NOT NULL DEFAULT 0
    CHECK (salary_base >= 0),
  ADD COLUMN IF NOT EXISTS deduction_amount NUMERIC(12, 2) NOT NULL DEFAULT 0
    CHECK (deduction_amount >= 0),
  ADD COLUMN IF NOT EXISTS pay_type TEXT NOT NULL DEFAULT 'permanent';

ALTER TABLE public.hr_leave_payroll_deductions
  DROP CONSTRAINT IF EXISTS hr_leave_payroll_deductions_pay_type_check;

ALTER TABLE public.hr_leave_payroll_deductions
  ADD CONSTRAINT hr_leave_payroll_deductions_pay_type_check
  CHECK (pay_type IN ('permanent', 'daily'));

-- Make PostgREST refresh immediately so the confirm action can use the newly
-- restored columns without waiting for its schema-cache polling interval.
NOTIFY pgrst, 'reload schema';
