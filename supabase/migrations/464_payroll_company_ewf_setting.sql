-- Allow each company to independently enable or disable EWF payroll deductions.
-- Existing companies remain enabled to preserve current payroll behavior.

ALTER TABLE public.hr_companies
  ADD COLUMN IF NOT EXISTS ewf_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.hr_companies.ewf_enabled IS
  'เปิด/ปิดการหักกองทุนสงเคราะห์ลูกจ้าง (EWF) สำหรับบริษัทนี้';

NOTIFY pgrst, 'reload schema';
