-- วันสิ้นสุดสัญญาจ้างสำหรับทะเบียนพนักงาน

ALTER TABLE hr_employees
  ADD COLUMN IF NOT EXISTS contract_end_date DATE;

COMMENT ON COLUMN hr_employees.contract_end_date IS
  'วันที่สิ้นสุดสัญญาจ้าง ใช้แจ้งเตือนล่วงหน้า 60 วันและเรียงลำดับอายุสัญญา';

CREATE INDEX IF NOT EXISTS idx_hr_employees_contract_end_date
  ON hr_employees (contract_end_date)
  WHERE contract_end_date IS NOT NULL;
