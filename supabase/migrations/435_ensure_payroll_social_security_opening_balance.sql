-- Repair installations where migration 415 was recorded/deployed out of order
-- but PostgREST still has no social_security_opening_balance column. Employee
-- edits always include this payroll field, so a missing column blocks updates
-- even when the user changes only personal/contact information.
BEGIN;

ALTER TABLE public.hr_employees
  ADD COLUMN IF NOT EXISTS social_security_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE public.hr_payroll_items
  ADD COLUMN IF NOT EXISTS social_security_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.hr_employees'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%social_security_opening_balance%'
  ) THEN
    ALTER TABLE public.hr_employees
      ADD CONSTRAINT hr_employees_social_security_opening_balance_nonnegative
      CHECK (social_security_opening_balance >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.hr_payroll_items'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%social_security_opening_balance%'
  ) THEN
    ALTER TABLE public.hr_payroll_items
      ADD CONSTRAINT hr_payroll_items_social_security_opening_balance_nonnegative
      CHECK (social_security_opening_balance >= 0);
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
