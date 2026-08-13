-- รูปแบบพนักงานที่ไม่ต้องบันทึกเวลาเข้า-ออกงาน
ALTER TABLE hr_employees DROP CONSTRAINT IF EXISTS hr_employees_work_mode_check;
ALTER TABLE hr_employees ADD CONSTRAINT hr_employees_work_mode_check
  CHECK (work_mode IN ('office', 'hybrid', 'wfh', 'no_clock'));

COMMENT ON COLUMN hr_employees.work_mode IS
  'office=เข้าออฟฟิศ, hybrid=เข้าออฟฟิศและขอ WFH ได้, wfh=WFH ประจำ, no_clock=ไม่ต้องบันทึกเวลาเข้าออก';
