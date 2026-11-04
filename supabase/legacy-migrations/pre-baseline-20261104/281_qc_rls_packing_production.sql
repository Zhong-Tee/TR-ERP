-- =====================================================================
-- Migration 281: เปิดสิทธิ์ RLS ให้ role packing_staff และ production
--   ทำงานเมนู QC ได้ครบ (QC Operation / Reject / Settings / ไม่ต้อง QC)
--   หมายเหตุ: เมนู (st_user_menus) เปิดให้แล้ว เหลือ RLS ที่ตาราง QC
--   คงสิทธิ์ role เดิมไว้ทั้งหมด แค่เพิ่ม packing_staff, production
-- =====================================================================

BEGIN;

-- 1) qc_sessions — สร้าง/ปิด session (QC Operation) --------------------
DROP POLICY IF EXISTS "QC staff can manage sessions" ON qc_sessions;
CREATE POLICY "QC staff can manage sessions"
  ON qc_sessions FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'qc_staff', 'packing_staff', 'production')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'qc_staff', 'packing_staff', 'production')
    )
  );

-- 2) qc_records — บันทึกผล Pass/Fail/Reject (QC Operation / Reject) -----
DROP POLICY IF EXISTS "QC staff can manage records" ON qc_records;
CREATE POLICY "QC staff can manage records"
  ON qc_records FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'qc_staff', 'packing_staff', 'production')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'qc_staff', 'packing_staff', 'production')
    )
  );

-- 3) qc_skip_logs — ปุ่ม "ไม่ต้อง QC" ---------------------------------
DROP POLICY IF EXISTS "qc_skip_logs_write" ON qc_skip_logs;
CREATE POLICY "qc_skip_logs_write"
  ON qc_skip_logs FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'qc_staff', 'packing_staff', 'production')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'qc_staff', 'packing_staff', 'production')
    )
  );

-- 4) settings_reasons — เหตุผล FAIL (QC Settings) ---------------------
DROP POLICY IF EXISTS "QC staff and admin can manage settings_reasons" ON settings_reasons;
CREATE POLICY "QC staff and admin can manage settings_reasons"
  ON settings_reasons FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'qc_staff', 'packing_staff', 'production')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'qc_staff', 'packing_staff', 'production')
    )
  );

-- 5) ink_types — สีหมึก (QC Settings แก้ไข hex) -----------------------
--    (ปรับให้ทันสมัย: ตัด role เก่า order_staff, เพิ่ม qc_staff + สอง role ใหม่)
DROP POLICY IF EXISTS "Admins can manage ink types" ON ink_types;
CREATE POLICY "Admins can manage ink types"
  ON ink_types FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'qc_staff', 'packing_staff', 'production')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'qc_staff', 'packing_staff', 'production')
    )
  );

-- 6) qc_checklist_topics — เช็คลิสต์ (QC Settings) --------------------
DROP POLICY IF EXISTS "Admin and QC staff can manage checklist topics" ON qc_checklist_topics;
CREATE POLICY "Admin and QC staff can manage checklist topics"
  ON qc_checklist_topics FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'qc_order', 'qc_staff', 'packing_staff', 'production')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'qc_order', 'qc_staff', 'packing_staff', 'production')
    )
  );

-- 7) qc_checklist_items ----------------------------------------------
DROP POLICY IF EXISTS "Admin and QC staff can manage checklist items" ON qc_checklist_items;
CREATE POLICY "Admin and QC staff can manage checklist items"
  ON qc_checklist_items FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'qc_order', 'qc_staff', 'packing_staff', 'production')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'qc_order', 'qc_staff', 'packing_staff', 'production')
    )
  );

-- 8) qc_checklist_topic_products -------------------------------------
DROP POLICY IF EXISTS "Admin and QC staff can manage checklist topic products" ON qc_checklist_topic_products;
CREATE POLICY "Admin and QC staff can manage checklist topic products"
  ON qc_checklist_topic_products FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'qc_order', 'qc_staff', 'packing_staff', 'production')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'qc_order', 'qc_staff', 'packing_staff', 'production')
    )
  );

COMMIT;
