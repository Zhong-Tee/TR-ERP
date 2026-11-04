-- Review state belongs to an employee's payroll snapshot for one specific month.
ALTER TABLE public.hr_payroll_items
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
