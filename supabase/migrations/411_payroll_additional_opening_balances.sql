-- Additional year-to-date opening balances used by payroll slips.
ALTER TABLE public.hr_employees
  ADD COLUMN IF NOT EXISTS income_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (income_opening_balance >= 0),
  ADD COLUMN IF NOT EXISTS personal_tax_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (personal_tax_opening_balance >= 0),
  ADD COLUMN IF NOT EXISTS student_loan_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (student_loan_opening_balance >= 0);

ALTER TABLE public.hr_payroll_items
  ADD COLUMN IF NOT EXISTS income_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (income_opening_balance >= 0),
  ADD COLUMN IF NOT EXISTS personal_tax_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (personal_tax_opening_balance >= 0),
  ADD COLUMN IF NOT EXISTS student_loan_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (student_loan_opening_balance >= 0);

NOTIFY pgrst, 'reload schema';
