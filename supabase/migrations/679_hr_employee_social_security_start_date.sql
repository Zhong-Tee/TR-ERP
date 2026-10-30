-- Keep the enrollment date even when social security deductions are disabled.
ALTER TABLE public.hr_employees
  ADD COLUMN IF NOT EXISTS social_security_start_date DATE;

COMMENT ON COLUMN public.hr_employees.social_security_start_date IS
  'Recorded social security enrollment date; independent of the payroll deduction switch';

NOTIFY pgrst, 'reload schema';
