-- Keep the employee nickname in each monthly payroll snapshot for filenames.
ALTER TABLE public.hr_payroll_items
  ADD COLUMN IF NOT EXISTS employee_nickname TEXT;

NOTIFY pgrst, 'reload schema';
