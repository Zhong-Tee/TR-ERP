-- ============================================
-- 074: Update Audit RLS Policies
-- อนุญาตเฉพาะ: superadmin, admin, auditor, account
-- ============================================

-- ─── inv_audits ─────────────────────────────────────────────

-- ลบ policy เก่าทั้งหมด
DROP POLICY IF EXISTS "Anyone authenticated can view audits" ON inv_audits;
DROP POLICY IF EXISTS "Admins can manage audits" ON inv_audits;
DROP POLICY IF EXISTS "Auditors can update assigned audits" ON inv_audits;

-- SELECT: เฉพาะ superadmin, admin, auditor, account
CREATE POLICY "Anyone authenticated can view audits"
  ON inv_audits FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'auditor', 'account')
    )
  );

-- FOR ALL: เฉพาะ superadmin, admin, auditor, account
CREATE POLICY "Admins can manage audits"
  ON inv_audits FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'auditor', 'account')
    )
  );

-- ─── inv_audit_items ────────────────────────────────────────

-- ลบ policy เก่าทั้งหมด
DROP POLICY IF EXISTS "Anyone authenticated can view audit items" ON inv_audit_items;
DROP POLICY IF EXISTS "Admins can manage audit items" ON inv_audit_items;
DROP POLICY IF EXISTS "Auditors can update assigned audit items" ON inv_audit_items;

-- SELECT: เฉพาะ superadmin, admin, auditor, account
CREATE POLICY "Anyone authenticated can view audit items"
  ON inv_audit_items FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'auditor', 'account')
    )
  );

-- FOR ALL: เฉพาะ superadmin, admin, auditor, account
CREATE POLICY "Admins can manage audit items"
  ON inv_audit_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'auditor', 'account')
    )
  );
