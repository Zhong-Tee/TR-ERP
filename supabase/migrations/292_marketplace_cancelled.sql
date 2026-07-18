-- Marketplace: เพิ่มสถานะ 'cancelled' (ยกเลิกบิล) + แถบ Dashboard/ยกเลิก
BEGIN;

-- 1) เพิ่มสถานะ cancelled ใน mp_orders
ALTER TABLE mp_orders DROP CONSTRAINT IF EXISTS mp_orders_status_check;
ALTER TABLE mp_orders
  ADD CONSTRAINT mp_orders_status_check
  CHECK (status IN ('new', 'assigned', 'follow_up', 'done', 'cancelled'));

-- 2) เก็บเหตุผล/เวลาที่ยกเลิก
ALTER TABLE mp_orders
  ADD COLUMN IF NOT EXISTS cancel_note  TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES us_users(id) ON DELETE SET NULL;

-- 3) สิทธิ์แถบใหม่ (Dashboard = admin เท่านั้น, ยกเลิก = เห็นเหมือน assign/done)
INSERT INTO st_user_menus (role, menu_key, menu_name, has_access) VALUES
  ('admin',      'marketplace-dashboard', 'Marketplace · Dashboard', true),
  ('admin',      'marketplace-cancelled', 'Marketplace · ยกเลิก',    true),
  ('sales-tr',   'marketplace-dashboard', 'Marketplace · Dashboard', false),
  ('sales-tr',   'marketplace-cancelled', 'Marketplace · ยกเลิก',    true),
  ('sales-pump', 'marketplace-dashboard', 'Marketplace · Dashboard', false),
  ('sales-pump', 'marketplace-cancelled', 'Marketplace · ยกเลิก',    true)
ON CONFLICT (role, menu_key) DO NOTHING;

COMMIT;
