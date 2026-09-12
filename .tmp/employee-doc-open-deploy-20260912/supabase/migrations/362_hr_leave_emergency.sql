-- ระบุคำขอลากิจฉุกเฉิน เพื่อข้ามเงื่อนไขแจ้งล่วงหน้าและแสดงเตือนผู้อนุมัติ
ALTER TABLE public.hr_leave_requests
  ADD COLUMN IF NOT EXISTS is_emergency BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.hr_leave_requests.is_emergency IS
  'Emergency personal leave request; advance notice validation is bypassed';

NOTIFY pgrst, 'reload schema';
