-- =============================================================================
-- สิทธิ์โหมดมือถือหลาย role ต่อ 1 user (us_users.mobile_access)
--   - เก็บ array ของ role มือถือที่ user เปิดสิทธิ์ เช่น ["production_mb","picker"]
--   - รองรับ: production_mb, manager, technician, picker, auditor
--   - ใช้คู่กับ employee_access (สวิตช์เดิมของหน้า Employee)
-- IDEMPOTENT: รันซ้ำได้
-- =============================================================================

ALTER TABLE us_users
  ADD COLUMN IF NOT EXISTS mobile_access JSONB DEFAULT '[]'::jsonb;

NOTIFY pgrst, 'reload schema';
