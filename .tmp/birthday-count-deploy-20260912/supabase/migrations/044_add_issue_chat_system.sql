CREATE TABLE IF NOT EXISTS or_issue_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3B82F6',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE or_issue_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Order staff can manage issue types"
  ON or_issue_types FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'admin_qc', 'account_staff')
    )
  );

CREATE POLICY "Anyone authenticated can view issue types"
  ON or_issue_types FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE TABLE IF NOT EXISTS or_issues (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  work_order_name TEXT,
  type_id UUID REFERENCES or_issue_types(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('On', 'Close')),
  created_by UUID NOT NULL REFERENCES us_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

ALTER TABLE or_issues ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Order staff can manage issues"
  ON or_issues FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'admin_qc', 'account_staff')
    )
  );

CREATE POLICY "Anyone authenticated can view issues"
  ON or_issues FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE TABLE IF NOT EXISTS or_issue_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  issue_id UUID NOT NULL REFERENCES or_issues(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES us_users(id),
  sender_name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE or_issue_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Order staff can manage issue messages"
  ON or_issue_messages FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'admin_qc', 'account_staff')
    )
  );

CREATE POLICY "Anyone authenticated can view issue messages"
  ON or_issue_messages FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE INDEX IF NOT EXISTS idx_or_issues_order_id ON or_issues(order_id);
CREATE INDEX IF NOT EXISTS idx_or_issues_work_order_name ON or_issues(work_order_name);
CREATE INDEX IF NOT EXISTS idx_or_issues_status ON or_issues(status);
CREATE INDEX IF NOT EXISTS idx_or_issue_messages_issue_id ON or_issue_messages(issue_id);
