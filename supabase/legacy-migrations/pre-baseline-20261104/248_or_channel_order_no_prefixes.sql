-- ช่องทาง ↔ prefix เลขคำสั่งซื้อ (channel_order_no)
-- ใช้สำหรับ validation ที่หน้าออเดอร์ + หน้า Settings

BEGIN;

CREATE TABLE IF NOT EXISTS or_channel_order_no_prefixes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_code TEXT NOT NULL REFERENCES channels(channel_code) ON DELETE CASCADE,
  prefix TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(channel_code, prefix)
);

CREATE INDEX IF NOT EXISTS idx_or_channel_order_no_prefixes_channel_code
  ON or_channel_order_no_prefixes(channel_code);

ALTER TABLE or_channel_order_no_prefixes ENABLE ROW LEVEL SECURITY;

-- อ่านได้ทุกคนที่ login
DROP POLICY IF EXISTS "Allow authenticated users to read or_channel_order_no_prefixes" ON or_channel_order_no_prefixes;
CREATE POLICY "Allow authenticated users to read or_channel_order_no_prefixes"
  ON or_channel_order_no_prefixes
  FOR SELECT
  TO authenticated
  USING (true);

-- แก้ไขได้เฉพาะ admin/sales-tr (สอดคล้องผู้ใช้หน้า /settings)
DROP POLICY IF EXISTS "Allow settings editors to insert or_channel_order_no_prefixes" ON or_channel_order_no_prefixes;
CREATE POLICY "Allow settings editors to insert or_channel_order_no_prefixes"
  ON or_channel_order_no_prefixes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE us_users.id = auth.uid()
        AND us_users.role IN ('superadmin', 'admin', 'sales-tr')
    )
  );

DROP POLICY IF EXISTS "Allow settings editors to update or_channel_order_no_prefixes" ON or_channel_order_no_prefixes;
CREATE POLICY "Allow settings editors to update or_channel_order_no_prefixes"
  ON or_channel_order_no_prefixes
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE us_users.id = auth.uid()
        AND us_users.role IN ('superadmin', 'admin', 'sales-tr')
    )
  );

DROP POLICY IF EXISTS "Allow settings editors to delete or_channel_order_no_prefixes" ON or_channel_order_no_prefixes;
CREATE POLICY "Allow settings editors to delete or_channel_order_no_prefixes"
  ON or_channel_order_no_prefixes
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE us_users.id = auth.uid()
        AND us_users.role IN ('superadmin', 'admin', 'sales-tr')
    )
  );

COMMENT ON TABLE or_channel_order_no_prefixes IS 'Mapping ช่องทาง ↔ prefix เลขคำสั่งซื้อ (or_orders.channel_order_no)';

-- Seed permission key for Settings tab (used by frontend hasAccess())
INSERT INTO st_user_menus (role, menu_key, menu_name, has_access)
VALUES
  ('superadmin', 'settings-bill-channel-map', 'ตั้งค่าเลขบิล-ช่องทาง', true),
  ('admin', 'settings-bill-channel-map', 'ตั้งค่าเลขบิล-ช่องทาง', true),
  ('sales-tr', 'settings-bill-channel-map', 'ตั้งค่าเลขบิล-ช่องทาง', true)
ON CONFLICT (role, menu_key) DO NOTHING;

COMMIT;

