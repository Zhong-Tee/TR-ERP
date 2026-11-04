CREATE TABLE IF NOT EXISTS or_issue_reads (
  issue_id UUID NOT NULL REFERENCES or_issues(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES us_users(id),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (issue_id, user_id)
);

ALTER TABLE or_issue_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Order staff can manage issue reads"
  ON or_issue_reads FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'admin_qc', 'account_staff')
    )
  );

CREATE POLICY "Anyone authenticated can view issue reads"
  ON or_issue_reads FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE INDEX IF NOT EXISTS idx_or_issue_reads_user_id ON or_issue_reads(user_id);
