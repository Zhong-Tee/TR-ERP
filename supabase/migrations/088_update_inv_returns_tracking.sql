-- ============================================
-- Add tracking_number and disposition to inv_returns
-- ============================================
ALTER TABLE inv_returns ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE inv_returns ADD COLUMN IF NOT EXISTS disposition TEXT DEFAULT NULL;

-- Allow production_mb to INSERT inv_returns and inv_return_items
CREATE POLICY "Production can create returns"
  ON inv_returns FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','admin-tr','store','manager','production','production_mb')
    )
  );

CREATE POLICY "Production can create return items"
  ON inv_return_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','admin-tr','store','manager','production','production_mb')
    )
  );
