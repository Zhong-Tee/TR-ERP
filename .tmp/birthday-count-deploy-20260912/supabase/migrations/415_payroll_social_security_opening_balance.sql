-- Social-security year-to-date opening balance used by employee payroll slips.
ALTER TABLE public.hr_employees
  ADD COLUMN IF NOT EXISTS social_security_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0
  CHECK (social_security_opening_balance >= 0);

ALTER TABLE public.hr_payroll_items
  ADD COLUMN IF NOT EXISTS social_security_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0
  CHECK (social_security_opening_balance >= 0);

NOTIFY pgrst, 'reload schema';
