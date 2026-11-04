-- Add salary and deduction snapshots for databases that already applied migration 357.
ALTER TABLE public.hr_leave_payroll_deductions
  ADD COLUMN IF NOT EXISTS salary_base NUMERIC(12, 2) NOT NULL DEFAULT 0
    CHECK (salary_base >= 0),
  ADD COLUMN IF NOT EXISTS deduction_amount NUMERIC(12, 2) NOT NULL DEFAULT 0
    CHECK (deduction_amount >= 0);
