-- เพิ่ม column is_active สำหรับระงับ/เปิดใช้งาน user
ALTER TABLE public.us_users
ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- ตรวจสอบให้แน่ใจว่า user ที่มีอยู่แล้วทุกคนเป็น active
UPDATE public.us_users SET is_active = true WHERE is_active IS NULL;

-- Comment
COMMENT ON COLUMN public.us_users.is_active IS 'false = ระงับการใช้งาน (ไม่สามารถ login ได้)';
