-- Promotion free-shipping flag and automatic shipping fee ranges

ALTER TABLE promotion
  ADD COLUMN IF NOT EXISTS free_shipping BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS or_shipping_fee_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  auto_calculate_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  charge_promotion_orders BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

INSERT INTO or_shipping_fee_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS or_shipping_fee_ranges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  min_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  max_amount NUMERIC(12, 2) CHECK (max_amount IS NULL OR max_amount >= min_amount),
  shipping_fee NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (shipping_fee >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_or_shipping_fee_ranges_amount
  ON or_shipping_fee_ranges(min_amount, max_amount, sort_order);

ALTER TABLE or_shipping_fee_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE or_shipping_fee_ranges ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON or_shipping_fee_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON or_shipping_fee_ranges TO authenticated;

DROP POLICY IF EXISTS "Authenticated users can read shipping fee settings" ON or_shipping_fee_settings;
CREATE POLICY "Authenticated users can read shipping fee settings"
  ON or_shipping_fee_settings FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "Admins can manage shipping fee settings" ON or_shipping_fee_settings;
CREATE POLICY "Admins can manage shipping fee settings"
  ON or_shipping_fee_settings FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-pump', 'admin-pump'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-pump', 'admin-pump'))
  );

DROP POLICY IF EXISTS "Authenticated users can read shipping fee ranges" ON or_shipping_fee_ranges;
CREATE POLICY "Authenticated users can read shipping fee ranges"
  ON or_shipping_fee_ranges FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "Admins can manage shipping fee ranges" ON or_shipping_fee_ranges;
CREATE POLICY "Admins can manage shipping fee ranges"
  ON or_shipping_fee_ranges FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-pump', 'admin-pump'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-pump', 'admin-pump'))
  );

NOTIFY pgrst, 'reload schema';
