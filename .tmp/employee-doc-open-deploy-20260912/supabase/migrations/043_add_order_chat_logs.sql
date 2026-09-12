CREATE TABLE IF NOT EXISTS or_order_chat_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  bill_no TEXT NOT NULL,
  sender_id UUID NOT NULL REFERENCES us_users(id),
  sender_name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE or_order_chat_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Order staff can manage chat logs"
  ON or_order_chat_logs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'admin_qc', 'account_staff')
    )
  );

CREATE POLICY "Anyone authenticated can view chat logs"
  ON or_order_chat_logs FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE INDEX IF NOT EXISTS idx_order_chat_logs_order_id ON or_order_chat_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_order_chat_logs_created_at ON or_order_chat_logs(created_at);
