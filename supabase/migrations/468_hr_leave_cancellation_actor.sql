-- เก็บผู้ดำเนินการและเวลาที่กดยกเลิกใบลา เพื่อแสดงในรายละเอียดคำขอลา
ALTER TABLE public.hr_leave_requests
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES public.hr_employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by_name TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_cancelled_by
  ON public.hr_leave_requests(cancelled_by);
