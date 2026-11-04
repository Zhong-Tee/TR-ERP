ALTER TABLE public.ac_refunds
  ADD COLUMN IF NOT EXISTS refund_request_link TEXT;

COMMENT ON COLUMN public.ac_refunds.refund_request_link IS
  'ลิงก์เพิ่มเติมที่แนบตอนส่งคำขอโอนคืน (ไม่บังคับ)';
