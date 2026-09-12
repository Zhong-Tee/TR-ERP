-- =====================================================================
-- Migration 137: Data rename (admin-tr/admin-pump -> sales-tr/sales-pump)
-- ใช้หลังจากรัน compatibility migration แล้ว
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1) Backfill st_user_menus ไป role ใหม่ก่อน (กันข้อมูลหาย)
-- ---------------------------------------------------------------------
INSERT INTO st_user_menus (role, menu_key, menu_name, has_access, created_at, updated_at)
SELECT
  'sales-tr' AS role,
  m.menu_key,
  m.menu_name,
  m.has_access,
  m.created_at,
  NOW()
FROM st_user_menus m
WHERE m.role = 'admin-tr'
ON CONFLICT (role, menu_key) DO UPDATE
SET
  menu_name = EXCLUDED.menu_name,
  has_access = EXCLUDED.has_access,
  updated_at = NOW();

INSERT INTO st_user_menus (role, menu_key, menu_name, has_access, created_at, updated_at)
SELECT
  'sales-pump' AS role,
  m.menu_key,
  m.menu_name,
  m.has_access,
  m.created_at,
  NOW()
FROM st_user_menus m
WHERE m.role = 'admin-pump'
ON CONFLICT (role, menu_key) DO UPDATE
SET
  menu_name = EXCLUDED.menu_name,
  has_access = EXCLUDED.has_access,
  updated_at = NOW();

-- ---------------------------------------------------------------------
-- 2) ย้าย role ใน us_users
-- ---------------------------------------------------------------------
UPDATE us_users SET role = 'sales-tr' WHERE role = 'admin-tr';
UPDATE us_users SET role = 'sales-pump' WHERE role = 'admin-pump';

-- ---------------------------------------------------------------------
-- 3) ลบ role เก่าจาก st_user_menus หลัง backfill เสร็จ
-- ---------------------------------------------------------------------
DELETE FROM st_user_menus WHERE role IN ('admin-tr', 'admin-pump');

COMMIT;

