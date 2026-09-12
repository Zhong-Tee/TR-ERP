-- แก้สิทธิ์เขียน qc_skip_logs ให้ role 'admin' เขียนได้
-- ปัญหาเดิม: ปุ่ม "ไม่ต้อง QC" เปิดให้ admin + superadmin กดได้ (isAdminOrSuperadmin)
-- แต่ RLS write policy ล่าสุด (141_qcorder_cleanup.sql) อนุญาตเฉพาะ
--   superadmin, sales-tr, qc_order, qc_staff  → ไม่มี 'admin'
-- ทำให้เมื่อ admin กดข้าม QC: qc_sessions/qc_records ถูกเขียน (นโยบายมี admin)
-- แต่ qc_skip_logs ถูกบล็อกเงียบ ๆ → การ์ดจัดของแสดง "Pass ครบ" แทน "ไม่ต้อง QC"
-- แก้: ปรับสิทธิ์ให้ตรงกับ qc_sessions/qc_records (superadmin, admin, qc_staff)

DROP POLICY IF EXISTS "qc_skip_logs_write" ON qc_skip_logs;

CREATE POLICY "qc_skip_logs_write"
  ON qc_skip_logs FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'qc_staff')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'qc_staff')
    )
  );
