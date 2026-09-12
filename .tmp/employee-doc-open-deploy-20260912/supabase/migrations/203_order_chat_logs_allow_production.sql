-- Production uses Order Confirm board chat; RLS previously blocked INSERT on or_order_chat_logs.

DROP POLICY IF EXISTS "Order staff can manage chat logs" ON or_order_chat_logs;

CREATE POLICY "Order staff can manage chat logs"
  ON or_order_chat_logs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin',
          'admin',
          'sales-tr',
          'sales-pump',
          'qc_order',
          'account',
          'production'
        )
    )
  );
