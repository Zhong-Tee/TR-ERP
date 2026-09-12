-- Manual slip check requests: ส่งตรวจสลิปมือ จากเมนูออเดอร์ → เมนูบัญชี
CREATE TABLE IF NOT EXISTS ac_manual_slip_checks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  bill_no TEXT,
  transfer_date TEXT NOT NULL,
  transfer_time TEXT NOT NULL,
  transfer_amount NUMERIC(12,2) NOT NULL,
  submitted_by TEXT NOT NULL,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ
);

ALTER TABLE ac_manual_slip_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ac_manual_slip_checks read"
  ON ac_manual_slip_checks FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'account')
    )
  );

CREATE POLICY "ac_manual_slip_checks write"
  ON ac_manual_slip_checks FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'account')
    )
  );

CREATE INDEX idx_ac_manual_slip_checks_order_id ON ac_manual_slip_checks(order_id);
CREATE INDEX idx_ac_manual_slip_checks_status ON ac_manual_slip_checks(status);
