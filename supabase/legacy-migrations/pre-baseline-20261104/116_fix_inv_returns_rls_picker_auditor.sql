-- ============================================
-- Fix inv_returns & inv_return_items INSERT RLS
-- เพิ่ม picker และ auditor ที่มีเมนู "รับสินค้าตีกลับ" แต่ยัง INSERT ไม่ได้
-- ============================================

-- ─── inv_returns INSERT ───────────────────────────────────────
DROP POLICY IF EXISTS "Production can create returns" ON inv_returns;
CREATE POLICY "Production can create returns"
  ON inv_returns FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin','admin','admin-tr','store','manager',
          'production','production_mb',
          'picker','auditor'
        )
    )
  );

-- ─── inv_return_items INSERT ──────────────────────────────────
DROP POLICY IF EXISTS "Production can create return items" ON inv_return_items;
CREATE POLICY "Production can create return items"
  ON inv_return_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin','admin','admin-tr','store','manager',
          'production','production_mb',
          'picker','auditor'
        )
    )
  );
