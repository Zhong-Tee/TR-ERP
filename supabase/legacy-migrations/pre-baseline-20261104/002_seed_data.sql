-- Seed Data for TR-ERP
-- รันไฟล์นี้หลังจากรัน 001_initial_schema.sql แล้ว

-- ============================================
-- CHANNELS TABLE (ถ้ายังไม่มี)
-- ============================================
CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_code TEXT UNIQUE NOT NULL,
  channel_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can view channels"
  ON channels FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage channels"
  ON channels FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff')
    )
  );

-- ============================================
-- INK TYPES TABLE (ถ้ายังไม่มี)
-- ============================================
CREATE TABLE IF NOT EXISTS ink_types (
  id SERIAL PRIMARY KEY,
  ink_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ink_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can view ink types"
  ON ink_types FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage ink types"
  ON ink_types FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff')
    )
  );

-- ============================================
-- INSERT CHANNELS
-- ============================================
INSERT INTO channels (channel_code, channel_name) VALUES
('SPTR', 'Shopee TR'),
('FSPTR', 'Facebook Shop TR'),
('LZTR', 'Lazada TR'),
('TTTR', 'TikTok TR'),
('SHOP', 'Shop'),
('CLAIM', 'CLAIM'),
('INFU', 'INFU')
ON CONFLICT (channel_code) DO NOTHING;

-- ============================================
-- INSERT INK TYPES
-- ============================================
INSERT INTO ink_types (ink_name) VALUES
('ดำ'),
('แดง'),
('น้ำเงิน'),
('เขียว')
ON CONFLICT DO NOTHING;
