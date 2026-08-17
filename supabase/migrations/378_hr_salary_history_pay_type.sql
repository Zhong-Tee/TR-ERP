-- เก็บประเภทค่าจ้างในแต่ละช่วงประวัติ เพื่อคำนวณย้อนหลังตามอัตราที่มีผลจริง
ALTER TABLE hr_salary_history
  ADD COLUMN IF NOT EXISTS pay_type TEXT;

UPDATE hr_salary_history history
SET pay_type = CASE
  WHEN employee.contract_type = 'daily' THEN 'daily'
  ELSE 'permanent'
END
FROM hr_employees employee
WHERE history.employee_id = employee.id
  AND history.pay_type IS NULL;

UPDATE hr_salary_history
SET pay_type = 'permanent'
WHERE pay_type IS NULL;

ALTER TABLE hr_salary_history
  ALTER COLUMN pay_type SET DEFAULT 'permanent',
  ALTER COLUMN pay_type SET NOT NULL;

ALTER TABLE hr_salary_history
  DROP CONSTRAINT IF EXISTS hr_salary_history_pay_type_check;

ALTER TABLE hr_salary_history
  ADD CONSTRAINT hr_salary_history_pay_type_check
  CHECK (pay_type IN ('permanent', 'daily'));

COMMENT ON COLUMN hr_salary_history.pay_type IS
  'ประเภทค่าจ้าง ณ วันที่มีผล: permanent=รายเดือน, daily=รายวัน';

-- Snapshot ประเภทค่าจ้างของยอดหักที่ยืนยันแล้ว รายการเดิมคำนวณแบบรายเดือนทั้งหมด
ALTER TABLE hr_leave_payroll_deductions
  ADD COLUMN IF NOT EXISTS pay_type TEXT NOT NULL DEFAULT 'permanent';

ALTER TABLE hr_leave_payroll_deductions
  DROP CONSTRAINT IF EXISTS hr_leave_payroll_deductions_pay_type_check;

ALTER TABLE hr_leave_payroll_deductions
  ADD CONSTRAINT hr_leave_payroll_deductions_pay_type_check
  CHECK (pay_type IN ('permanent', 'daily'));
