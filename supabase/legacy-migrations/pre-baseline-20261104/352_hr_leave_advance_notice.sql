-- ตั้งค่าจำนวนวันปฏิทินที่พนักงานต้องแจ้งล่วงหน้าสำหรับการลาแต่ละประเภท
ALTER TABLE public.hr_leave_types
  ADD COLUMN IF NOT EXISTS advance_notice_days INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.hr_leave_types
  DROP CONSTRAINT IF EXISTS hr_leave_types_advance_notice_days_check;

ALTER TABLE public.hr_leave_types
  ADD CONSTRAINT hr_leave_types_advance_notice_days_check
  CHECK (advance_notice_days >= 0);

COMMENT ON COLUMN public.hr_leave_types.advance_notice_days IS
  'Minimum calendar days an employee must submit a leave request in advance';
