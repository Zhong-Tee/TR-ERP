-- ============================================
-- Allow packing_staff to UPDATE or_order_items
-- Fix: packing_status and item_scan_time updates
-- were silently rejected by RLS
-- ============================================

CREATE POLICY "Packing staff can update order items"
  ON or_order_items FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role = 'packing_staff'
    )
  );
