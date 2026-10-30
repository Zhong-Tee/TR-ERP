-- Enrollment is independent of the employee's contract/pay type.
BEGIN;
ALTER TABLE public.hr_employees
  ADD COLUMN IF NOT EXISTS social_security_enabled BOOLEAN;

-- Preserve existing payroll behavior; new employees must explicitly enroll.
UPDATE public.hr_employees
SET social_security_enabled = (
  COALESCE(contract_type, 'permanent') <> 'daily'
  AND UPPER(TRIM(employee_code)) <> 'EMP00001'
)
WHERE social_security_enabled IS NULL;

ALTER TABLE public.hr_employees
  ALTER COLUMN social_security_enabled SET DEFAULT false,
  ALTER COLUMN social_security_enabled SET NOT NULL;

COMMENT ON COLUMN public.hr_employees.social_security_enabled IS
  'Explicit enrollment switch controlling social security deductions for monthly and daily payroll';
NOTIFY pgrst, 'reload schema';
COMMIT;
