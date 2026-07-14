-- =====================================================================
-- Migration 283: สลิปการโอนเงินคืนลูกค้า (refund slip)
--   1) เก็บ path สลิปที่ "เราโอนคืนลูกค้า" (หลายรูปได้) ใน ac_refunds
--   2) เพิ่มสิทธิ์เมนูแท็บใหม่ "โอนคืน" (orders-refund-return) ให้ Sales + admin
--   หมายเหตุ:
--   - เก็บใน bucket slip-images (โฟลเดอร์ refunds/<refund_id>/...) เหมือนสลิปทั่วไป
--   - สิทธิ์อัปโหลด/อัปเดต ใช้ policy เดิม "Account staff can manage refunds"
--     (superadmin/admin-tr/account) — ไม่ต้องเพิ่ม RLS ใหม่
--   - Sales อ่าน ac_refunds ได้แล้วจาก migration 276; storage slip-images
--     อ่านได้ทุก authenticated (migration 012)
-- =====================================================================

ALTER TABLE ac_refunds
  ADD COLUMN IF NOT EXISTS refund_slip_paths TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN ac_refunds.refund_slip_paths IS 'path สลิปการโอนเงินคืนลูกค้า (bucket/path หลายรูป) — บัญชีอัปโหลด, Sales เปิดดูส่งลูกค้า';

-- สิทธิ์เมนูแท็บใหม่ "โอนคืน" ในหน้าออเดอร์ (superadmin bypass อยู่แล้ว)
INSERT INTO st_user_menus (role, menu_key, menu_name, has_access) VALUES
  ('admin', 'orders-refund-return', 'โอนคืน', true),
  ('sales-tr', 'orders-refund-return', 'โอนคืน', true),
  ('sales-pump', 'orders-refund-return', 'โอนคืน', true)
ON CONFLICT (role, menu_key) DO UPDATE
  SET has_access = EXCLUDED.has_access, menu_name = EXCLUDED.menu_name;

NOTIFY pgrst, 'reload schema';
