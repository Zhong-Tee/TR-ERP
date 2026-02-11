-- ตาราง track การอ่าน order chat (คล้ายกับ or_issue_reads)
CREATE TABLE IF NOT EXISTS or_order_chat_reads (
  order_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES us_users(id),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (order_id, user_id)
);

ALTER TABLE or_order_chat_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own order chat reads"
  ON or_order_chat_reads FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'admin_qc', 'account_staff', 'production')
    )
  );

CREATE POLICY "Anyone authenticated can view order chat reads"
  ON or_order_chat_reads FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE INDEX IF NOT EXISTS idx_or_order_chat_reads_user_id ON or_order_chat_reads(user_id);

-- Enable realtime for order chat logs
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE or_order_chat_logs;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;
