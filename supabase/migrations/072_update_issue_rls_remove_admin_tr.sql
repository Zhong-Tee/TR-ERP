-- Remove admin-tr from issue bypass list so they only see issues for their own orders
-- admin-tr will rely on the admin_user ownership check instead

-- Drop existing policies
DROP POLICY IF EXISTS "Issue owners can view issues" ON or_issues;
DROP POLICY IF EXISTS "Issue owners can manage issues" ON or_issues;
DROP POLICY IF EXISTS "Issue owners can view messages" ON or_issue_messages;
DROP POLICY IF EXISTS "Issue owners can manage messages" ON or_issue_messages;

-- Recreate: or_issues SELECT
CREATE POLICY "Issue owners can view issues"
  ON or_issues FOR SELECT
  USING (
    (EXISTS (
      SELECT 1 FROM or_orders o
      WHERE o.id = or_issues.order_id
        AND (o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
             OR o.admin_user = (auth.jwt() ->> 'email'))
    ))
    OR or_issues.created_by = auth.uid()
    OR EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'admin_qc'))
  );

-- Recreate: or_issues ALL (INSERT/UPDATE/DELETE)
CREATE POLICY "Issue owners can manage issues"
  ON or_issues FOR ALL
  USING (
    (EXISTS (
      SELECT 1 FROM or_orders o
      WHERE o.id = or_issues.order_id
        AND (o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
             OR o.admin_user = (auth.jwt() ->> 'email'))
    ))
    OR or_issues.created_by = auth.uid()
    OR EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'admin_qc'))
  );

-- Recreate: or_issue_messages SELECT
CREATE POLICY "Issue owners can view messages"
  ON or_issue_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM or_issues i
      JOIN or_orders o ON o.id = i.order_id
      WHERE i.id = or_issue_messages.issue_id
        AND (
          o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
          OR o.admin_user = (auth.jwt() ->> 'email')
          OR i.created_by = auth.uid()
          OR EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'admin_qc'))
        )
    )
  );

-- Recreate: or_issue_messages ALL
CREATE POLICY "Issue owners can manage messages"
  ON or_issue_messages FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM or_issues i
      JOIN or_orders o ON o.id = i.order_id
      WHERE i.id = or_issue_messages.issue_id
        AND (
          o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
          OR o.admin_user = (auth.jwt() ->> 'email')
          OR i.created_by = auth.uid()
          OR EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'admin_qc'))
        )
    )
  );
