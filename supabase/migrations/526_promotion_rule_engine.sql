-- Promotion rule engine + multi-promotion order links + immutable validation audit

ALTER TABLE promotion
  ADD COLUMN IF NOT EXISTS validation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rule_type TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS start_date DATE,
  ADD COLUMN IF NOT EXISTS end_date DATE,
  ADD COLUMN IF NOT EXISTS channel_codes TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS rule_config JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS allow_stack BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE promotion DROP CONSTRAINT IF EXISTS promotion_rule_type_check;
ALTER TABLE promotion ADD CONSTRAINT promotion_rule_type_check CHECK (
  rule_type IN (
    'legacy', 'bundle_fixed_price', 'spend_percent', 'spend_fixed',
    'buy_get', 'spend_get', 'quantity_get'
  )
);
ALTER TABLE promotion DROP CONSTRAINT IF EXISTS promotion_date_range_check;
ALTER TABLE promotion ADD CONSTRAINT promotion_date_range_check
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date);
ALTER TABLE promotion DROP CONSTRAINT IF EXISTS promotion_version_check;
ALTER TABLE promotion ADD CONSTRAINT promotion_version_check CHECK (version > 0);

-- รองรับทั้งชื่อ role ปัจจุบันและชื่อเดิมจากฐานที่อัปเกรดมา
DROP POLICY IF EXISTS "Admins and order staff can manage promotions" ON promotion;
CREATE POLICY "Admins and order staff can manage promotions"
  ON promotion FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users u
      WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-pump', 'admin-pump')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users u
      WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-pump', 'admin-pump')
    )
  );

CREATE TABLE IF NOT EXISTS or_order_promotions (
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  promotion_id UUID NOT NULL REFERENCES promotion(id) ON DELETE RESTRICT,
  promotion_name_snapshot TEXT NOT NULL,
  promotion_version INTEGER NOT NULL,
  rule_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  selected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  selected_by TEXT,
  PRIMARY KEY (order_id, promotion_id)
);

CREATE INDEX IF NOT EXISTS idx_or_order_promotions_promotion
  ON or_order_promotions(promotion_id);

CREATE TABLE IF NOT EXISTS or_promotion_audits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  bill_no TEXT NOT NULL,
  channel_code TEXT NOT NULL,
  order_admin_user TEXT,
  promotion_id UUID REFERENCES promotion(id) ON DELETE SET NULL,
  promotion_name TEXT NOT NULL,
  promotion_version INTEGER NOT NULL,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('passed', 'failed', 'overridden', 'not_checked')),
  validation_messages JSONB NOT NULL DEFAULT '[]'::JSONB,
  expected_discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  expected_total_discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  actual_total_discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  application_count INTEGER NOT NULL DEFAULT 0,
  rule_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  order_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  override_reason TEXT,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evaluated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_or_promotion_audits_evaluated_at
  ON or_promotion_audits(evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_or_promotion_audits_order
  ON or_promotion_audits(order_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_or_promotion_audits_promotion
  ON or_promotion_audits(promotion_id, evaluated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON or_order_promotions TO authenticated;
GRANT SELECT, INSERT ON or_promotion_audits TO authenticated;

ALTER TABLE or_order_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE or_promotion_audits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read order promotions" ON or_order_promotions;
CREATE POLICY "Authenticated users can read order promotions"
  ON or_order_promotions FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "Order staff can manage order promotions" ON or_order_promotions;
CREATE POLICY "Order staff can manage order promotions"
  ON or_order_promotions FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin', 'admin-tr', 'admin-pump', 'sales-tr', 'sales-pump', 'qc_order', 'account', 'account_staff')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin', 'admin-tr', 'admin-pump', 'sales-tr', 'sales-pump', 'qc_order', 'account', 'account_staff')
    )
  );

DROP POLICY IF EXISTS "Authenticated users can read promotion audits" ON or_promotion_audits;
CREATE POLICY "Authenticated users can read promotion audits"
  ON or_promotion_audits FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users u
      WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'admin-tr', 'account', 'account_staff')
    )
  );
DROP POLICY IF EXISTS "Order staff can create promotion audits" ON or_promotion_audits;
CREATE POLICY "Order staff can create promotion audits"
  ON or_promotion_audits FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin', 'admin-tr', 'admin-pump', 'sales-tr', 'sales-pump', 'qc_order', 'account', 'account_staff')
    )
  );

-- เปิดสิทธิ์รายงานให้บัญชีและผู้ดูแล โดยไม่กระทบค่าที่ผู้ใช้ตั้งไว้แล้ว
INSERT INTO st_user_menus (role, menu_key, menu_name, has_access)
VALUES
  ('superadmin', 'account-promotion-audit', 'บัญชี · ตรวจโปรโมชั่น', TRUE),
  ('admin', 'account-promotion-audit', 'บัญชี · ตรวจโปรโมชั่น', TRUE),
  ('account', 'account-promotion-audit', 'บัญชี · ตรวจโปรโมชั่น', TRUE),
  ('sales-tr', 'account-promotion-audit', 'บัญชี · ตรวจโปรโมชั่น', FALSE)
ON CONFLICT (role, menu_key) DO UPDATE SET
  menu_name = EXCLUDED.menu_name,
  has_access = EXCLUDED.has_access,
  updated_at = NOW();

NOTIFY pgrst, 'reload schema';
