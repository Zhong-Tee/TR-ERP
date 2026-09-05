-- ลบสิทธิ์ Mobile ที่ซ้ำกับ role หลักของผู้ใช้
-- ตัวอย่าง: role = 'picker' และ mobile_access = ["picker"] จะเหลือ []
-- IDEMPOTENT: รันซ้ำได้

UPDATE public.us_users
SET mobile_access = COALESCE(mobile_access, '[]'::jsonb) - role
WHERE role IN ('production_mb', 'manager', 'technician', 'picker', 'auditor')
  AND COALESCE(mobile_access, '[]'::jsonb) ? role;

NOTIFY pgrst, 'reload schema';
