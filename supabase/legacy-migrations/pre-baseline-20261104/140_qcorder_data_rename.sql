-- =====================================================================
-- Migration 140: data rename admin_qc -> qc_order
-- ย้ายข้อมูล role จริงในตารางหลัก
-- =====================================================================

BEGIN;

-- 1) Backfill สิทธิ์เมนูจาก role เก่า -> role ใหม่
INSERT INTO st_user_menus (role, menu_key, menu_name, has_access, created_at, updated_at)
SELECT
  'qc_order' AS role,
  m.menu_key,
  m.menu_name,
  m.has_access,
  m.created_at,
  NOW()
FROM st_user_menus m
WHERE m.role = 'admin_qc'
ON CONFLICT (role, menu_key)
DO UPDATE SET
  menu_name = EXCLUDED.menu_name,
  has_access = EXCLUDED.has_access,
  updated_at = NOW();

-- 2) อัปเดต role ผู้ใช้จริง
UPDATE us_users
SET role = 'qc_order'
WHERE role = 'admin_qc';

-- 3) ลบ role เก่าในตารางสิทธิ์เมนู
DELETE FROM st_user_menus
WHERE role = 'admin_qc';

COMMIT;
