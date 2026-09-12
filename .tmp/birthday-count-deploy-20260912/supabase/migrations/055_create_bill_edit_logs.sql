-- Bill edit logs: บันทึกประวัติการแก้ไขบิลจากเมนูบัญชี > แก้ไขบิล
CREATE TABLE IF NOT EXISTS ac_bill_edit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  bill_no TEXT,
  edited_by TEXT NOT NULL,
  edited_at TIMESTAMPTZ DEFAULT NOW(),
  changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  snapshot_before JSONB,
  snapshot_after JSONB
);

ALTER TABLE ac_bill_edit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ac_bill_edit_logs read"
  ON ac_bill_edit_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'account')
    )
  );

CREATE POLICY "ac_bill_edit_logs write"
  ON ac_bill_edit_logs FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'account')
    )
  );

CREATE INDEX idx_ac_bill_edit_logs_order_id ON ac_bill_edit_logs(order_id);
CREATE INDEX idx_ac_bill_edit_logs_edited_at ON ac_bill_edit_logs(edited_at DESC);
