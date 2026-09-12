-- Track who verified slips and all verification outcomes

ALTER TABLE ac_verified_slips
  ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES us_users(id);

CREATE TABLE IF NOT EXISTS ac_slip_verification_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  slip_image_url TEXT,
  slip_storage_path TEXT,
  verified_by UUID REFERENCES us_users(id),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  verified_amount NUMERIC(10, 2) DEFAULT 0,
  error TEXT,
  easyslip_response JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ac_slip_verification_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Order and account staff can manage slip verification logs"
  ON ac_slip_verification_logs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'account_staff')
    )
  );

CREATE POLICY "Anyone authenticated can view slip verification logs"
  ON ac_slip_verification_logs FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE INDEX IF NOT EXISTS idx_slip_verification_logs_order_id
  ON ac_slip_verification_logs (order_id);

CREATE INDEX IF NOT EXISTS idx_slip_verification_logs_verified_by
  ON ac_slip_verification_logs (verified_by);
