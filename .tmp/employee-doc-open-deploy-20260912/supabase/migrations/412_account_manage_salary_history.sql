-- Repair salary-history schema and explicitly allow the account role to manage it.
BEGIN;

ALTER TABLE public.hr_salary_history
  ADD COLUMN IF NOT EXISTS position_allowance NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS pay_type TEXT;

UPDATE public.hr_salary_history history
SET pay_type = CASE
  WHEN employee.contract_type = 'daily' THEN 'daily'
  ELSE 'permanent'
END
FROM public.hr_employees employee
WHERE history.employee_id = employee.id
  AND history.pay_type IS NULL;

UPDATE public.hr_salary_history
SET pay_type = 'permanent'
WHERE pay_type IS NULL;

ALTER TABLE public.hr_salary_history
  ALTER COLUMN pay_type SET DEFAULT 'permanent',
  ALTER COLUMN pay_type SET NOT NULL;

ALTER TABLE public.hr_salary_history
  DROP CONSTRAINT IF EXISTS hr_salary_history_pay_type_check;

ALTER TABLE public.hr_salary_history
  ADD CONSTRAINT hr_salary_history_pay_type_check
  CHECK (pay_type IN ('permanent', 'daily'));

DROP POLICY IF EXISTS "hr_salary_history_account_manage" ON public.hr_salary_history;
CREATE POLICY "hr_salary_history_account_manage"
  ON public.hr_salary_history
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.us_users
      WHERE id = auth.uid()
        AND is_active IS TRUE
        AND role = 'account'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.us_users
      WHERE id = auth.uid()
        AND is_active IS TRUE
        AND role = 'account'
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hr_salary_history TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
