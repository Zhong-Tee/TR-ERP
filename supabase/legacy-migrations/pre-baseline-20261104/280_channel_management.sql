-- =====================================================================
-- Migration 280: ระบบจัดการช่องทางขาย (Channel Management)
--   1) เพิ่มคอลัมน์ให้ตาราง channels: receive_transfer, is_active, sort_order
--   2) สร้างตาราง channel_role_visibility (ผูกช่องทางกับ role ที่มองเห็น)
--   3) Seed ค่า receive_transfer ให้ช่องทางเดิม (พฤติกรรมไม่เปลี่ยน)
-- =====================================================================

-- 1) คอลัมน์ใหม่ในตาราง channels ------------------------------------------------
ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS receive_transfer BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_active        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sort_order       INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN channels.receive_transfer IS 'true = โอนเงินเข้าบัญชีตรง (ต้องผูกบัญชี + ตรวจ EasySlip); false = ไม่ต้องรับเงินโอน (marketplace/office)';
COMMENT ON COLUMN channels.is_active IS 'true = ใช้งาน (แสดงใน dropdown เปิดบิล); false = ปิดใช้งาน (ซ่อน แต่บิลเก่ายังอ้างอิงได้)';
COMMENT ON COLUMN channels.sort_order IS 'ลำดับการแสดงผลในหน้าจัดการช่องทาง/เปิดบิล';

-- Seed: ช่องทางที่ "ไม่ต้อง" รับเงินโอนเข้าบัญชีเรา (Marketplace เก็บเงินแทน + OFFICE ภายใน)
-- ตรงกับ hardcoded CHANNELS_NO_BANK_ACCOUNT_REQUIRED เดิม เพื่อคงพฤติกรรมไว้
UPDATE channels
  SET receive_transfer = false
  WHERE channel_code IN ('SPTR', 'FSPTR', 'TTTR', 'LZTR', 'OFFICE');

-- 2) ตาราง channel_role_visibility ---------------------------------------------
--    ถ้าช่องทางใด "ไม่มีแถว" ในตารางนี้ = ทุก role เห็น (permissive default)
--    ถ้ามีแถว = เห็นเฉพาะ role ที่ระบุ (superadmin/admin เห็นเสมอในระดับแอป)
CREATE TABLE IF NOT EXISTS channel_role_visibility (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_code TEXT NOT NULL REFERENCES channels(channel_code) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (channel_code, role)
);

CREATE INDEX IF NOT EXISTS idx_channel_role_visibility_channel ON channel_role_visibility(channel_code);
CREATE INDEX IF NOT EXISTS idx_channel_role_visibility_role    ON channel_role_visibility(role);

ALTER TABLE channel_role_visibility ENABLE ROW LEVEL SECURITY;

-- อ่านได้ทุกคนที่ล็อกอิน (ใช้กรอง dropdown ตอนเปิดบิล)
DROP POLICY IF EXISTS "read channel_role_visibility" ON channel_role_visibility;
CREATE POLICY "read channel_role_visibility"
  ON channel_role_visibility FOR SELECT
  TO authenticated
  USING (true);

-- จัดการได้เฉพาะ superadmin/admin
DROP POLICY IF EXISTS "manage channel_role_visibility" ON channel_role_visibility;
CREATE POLICY "manage channel_role_visibility"
  ON channel_role_visibility FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE us_users.id = auth.uid()
        AND us_users.role IN ('superadmin', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE us_users.id = auth.uid()
        AND us_users.role IN ('superadmin', 'admin')
    )
  );

COMMENT ON TABLE channel_role_visibility IS 'จำกัดการมองเห็นช่องทางตาม role (ไม่มีแถว = เห็นทุก role)';
