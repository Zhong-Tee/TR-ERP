-- Employee savings and company-loan opening balances for payroll.
ALTER TABLE public.hr_employees
  ADD COLUMN IF NOT EXISTS monthly_savings NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monthly_savings >= 0),
  ADD COLUMN IF NOT EXISTS savings_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (savings_opening_balance >= 0),
  ADD COLUMN IF NOT EXISTS company_loan_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (company_loan_opening_balance >= 0),
  ADD COLUMN IF NOT EXISTS company_loan_opening_installments INTEGER NOT NULL DEFAULT 0 CHECK (company_loan_opening_installments >= 0);

ALTER TABLE public.hr_payroll_items
  ADD COLUMN IF NOT EXISTS savings NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (savings >= 0),
  ADD COLUMN IF NOT EXISTS savings_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (savings_opening_balance >= 0),
  ADD COLUMN IF NOT EXISTS company_loan_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (company_loan_opening_balance >= 0),
  ADD COLUMN IF NOT EXISTS company_loan_opening_installments INTEGER NOT NULL DEFAULT 0 CHECK (company_loan_opening_installments >= 0);

ALTER TABLE public.hr_payroll_items
  DROP COLUMN IF EXISTS net_pay,
  DROP COLUMN IF EXISTS total_deduction;

ALTER TABLE public.hr_payroll_items
  ADD COLUMN total_deduction NUMERIC(12,2)
    GENERATED ALWAYS AS (personal_tax + social_security + savings + student_loan + company_loan + leave_deduction + other_deduction) STORED,
  ADD COLUMN net_pay NUMERIC(12,2)
    GENERATED ALWAYS AS ((base_salary + position_allowance + other_income) - (personal_tax + social_security + savings + student_loan + company_loan + leave_deduction + other_deduction)) STORED;

NOTIFY pgrst, 'reload schema';
