-- Allow production role to create/manage issue tickets and issue chats.
-- Keep owner/admin visibility behavior intact.

DROP POLICY IF EXISTS "Issue owners can view issues" ON or_issues;
DROP POLICY IF EXISTS "Issue owners can manage issues" ON or_issues;

CREATE POLICY "Issue owners can view issues"
  ON or_issues FOR SELECT
  USING (
    (
      EXISTS (
        SELECT 1
        FROM or_orders o
        WHERE o.id = or_issues.order_id
          AND (
            o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
            OR o.admin_user = (auth.jwt() ->> 'email')
          )
      )
    )
    OR or_issues.created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'qc_order', 'production')
    )
  );

CREATE POLICY "Issue owners can manage issues"
  ON or_issues FOR ALL
  USING (
    (
      EXISTS (
        SELECT 1
        FROM or_orders o
        WHERE o.id = or_issues.order_id
          AND (
            o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
            OR o.admin_user = (auth.jwt() ->> 'email')
          )
      )
    )
    OR or_issues.created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'qc_order', 'production')
    )
  );

DROP POLICY IF EXISTS "Issue owners can view messages" ON or_issue_messages;
DROP POLICY IF EXISTS "Issue owners can manage messages" ON or_issue_messages;

CREATE POLICY "Issue owners can view messages"
  ON or_issue_messages FOR SELECT
  USING (
    (
      EXISTS (
        SELECT 1
        FROM or_issues i
        JOIN or_orders o ON o.id = i.order_id
        WHERE i.id = or_issue_messages.issue_id
          AND (
            o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
            OR o.admin_user = (auth.jwt() ->> 'email')
          )
      )
    )
    OR EXISTS (
      SELECT 1
      FROM or_issues i
      WHERE i.id = or_issue_messages.issue_id
        AND i.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'qc_order', 'production')
    )
  );

CREATE POLICY "Issue owners can manage messages"
  ON or_issue_messages FOR ALL
  USING (
    (
      EXISTS (
        SELECT 1
        FROM or_issues i
        JOIN or_orders o ON o.id = i.order_id
        WHERE i.id = or_issue_messages.issue_id
          AND (
            o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
            OR o.admin_user = (auth.jwt() ->> 'email')
          )
      )
    )
    OR EXISTS (
      SELECT 1
      FROM or_issues i
      WHERE i.id = or_issue_messages.issue_id
        AND i.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'qc_order', 'production')
    )
  );

DROP POLICY IF EXISTS "Order staff can manage issue reads" ON or_issue_reads;
CREATE POLICY "Order staff can manage issue reads"
  ON or_issue_reads FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account', 'production')
    )
  );
