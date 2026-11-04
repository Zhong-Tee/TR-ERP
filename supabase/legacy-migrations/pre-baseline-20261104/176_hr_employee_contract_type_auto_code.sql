-- ประเภทสัญญาจ้าง + รหัสพนักงานอัตโนมัติ (EMP + ลำดับ 6 หลัก)

ALTER TABLE hr_employees
  ADD COLUMN IF NOT EXISTS contract_type TEXT NOT NULL DEFAULT 'permanent';

ALTER TABLE hr_employees
  DROP CONSTRAINT IF EXISTS hr_employees_contract_type_check;

ALTER TABLE hr_employees
  ADD CONSTRAINT hr_employees_contract_type_check
  CHECK (contract_type IN ('permanent', 'daily'));

COMMENT ON COLUMN hr_employees.contract_type IS 'permanent=ประจำ, daily=รายวัน';

CREATE SEQUENCE IF NOT EXISTS hr_employee_code_seq;

DO $$
DECLARE
  mx bigint := 0;
  r record;
BEGIN
  FOR r IN SELECT employee_code FROM hr_employees WHERE employee_code ~ '^EMP[0-9]+$'
  LOOP
    mx := GREATEST(mx, substring(r.employee_code from 4)::bigint);
  END LOOP;
  FOR r IN SELECT employee_code FROM hr_employees WHERE employee_code ~ '^[0-9]+$'
  LOOP
    mx := GREATEST(mx, r.employee_code::bigint);
  END LOOP;
  PERFORM setval('hr_employee_code_seq', GREATEST(mx, 0) + 1, false);
END $$;

CREATE OR REPLACE FUNCTION hr_assign_employee_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.employee_code IS NULL OR btrim(NEW.employee_code) = '') THEN
    NEW.employee_code := 'EMP' || lpad(nextval('hr_employee_code_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_employees_assign_code ON hr_employees;
CREATE TRIGGER trg_hr_employees_assign_code
  BEFORE INSERT ON hr_employees
  FOR EACH ROW
  EXECUTE FUNCTION hr_assign_employee_code();
