-- Remote-area and special-tourism shipping surcharges.

ALTER TABLE or_shipping_fee_settings
  ADD COLUMN IF NOT EXISTS special_area_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS or_shipping_area_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  carrier TEXT NOT NULL DEFAULT 'Flash Express',
  area_type TEXT NOT NULL CHECK (area_type IN ('remote', 'special_tourism')),
  channel_codes TEXT[] NOT NULL DEFAULT '{}',
  postal_code TEXT,
  province TEXT NOT NULL,
  district TEXT NOT NULL,
  sub_district TEXT,
  surcharge NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (surcharge >= 0),
  is_forever BOOLEAN NOT NULL DEFAULT TRUE,
  start_date DATE,
  end_date DATE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT,
  CONSTRAINT or_shipping_area_rules_date_check CHECK (
    is_forever OR (start_date IS NOT NULL AND end_date IS NOT NULL AND end_date >= start_date)
  ),
  CONSTRAINT or_shipping_area_rules_postal_check CHECK (
    postal_code IS NULL OR postal_code ~ '^[0-9]{5}$'
  )
);

CREATE INDEX IF NOT EXISTS idx_or_shipping_area_rules_match
  ON or_shipping_area_rules(is_active, postal_code, province, district, sub_district);
CREATE INDEX IF NOT EXISTS idx_or_shipping_area_rules_dates
  ON or_shipping_area_rules(start_date, end_date) WHERE is_active;

ALTER TABLE or_shipping_area_rules ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON or_shipping_area_rules TO authenticated;

DROP POLICY IF EXISTS "Authenticated users can read shipping area rules" ON or_shipping_area_rules;
CREATE POLICY "Authenticated users can read shipping area rules"
  ON or_shipping_area_rules FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS "Admins can manage shipping area rules" ON or_shipping_area_rules;
CREATE POLICY "Admins can manage shipping area rules"
  ON or_shipping_area_rules FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-pump', 'admin-pump')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-pump', 'admin-pump')
    )
  );

NOTIFY pgrst, 'reload schema';
