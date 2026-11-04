-- =============================================================================
-- ให้ sales-tr / sales-pump สร้างคำขอโอนคืน + ส่งตรวจสลิปมือได้
--   - migration 276/277 เพิ่มแค่สิทธิ์ SELECT ให้ sales
--   - policy ฝั่ง write (จาก 060) จำกัดแค่ superadmin/admin-tr/account
--     → sales จึง INSERT ไม่ได้ = "new row violates row-level security policy"
--   แก้: เพิ่ม policy write เฉพาะที่จำเป็น และล็อกไว้ที่สถานะ pending
--        เพื่อกันไม่ให้ sales อนุมัติ/ตัดสินเอง (ยังเป็นสิทธิ์ของบัญชี)
-- IDEMPOTENT: รันซ้ำได้
-- =============================================================================

-- ─── ac_refunds : สร้าง/แก้ไขคำขอโอนคืน (หน้าออเดอร์ → โอนเกิน) ──────────────
DROP POLICY IF EXISTS "Sales can create pending refunds" ON ac_refunds;
CREATE POLICY "Sales can create pending refunds"
  ON ac_refunds FOR INSERT
  WITH CHECK (
    status = 'pending'
    AND EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('sales-tr', 'sales-pump')
    )
  );

DROP POLICY IF EXISTS "Sales can update pending refunds" ON ac_refunds;
CREATE POLICY "Sales can update pending refunds"
  ON ac_refunds FOR UPDATE
  USING (
    status = 'pending'
    AND EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('sales-tr', 'sales-pump')
    )
  )
  WITH CHECK (
    status = 'pending'
    AND EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('sales-tr', 'sales-pump')
    )
  );

-- ─── ac_manual_slip_checks : ส่งตรวจสลิปมือ (หน้าออเดอร์ → ตรวจสอบไม่ผ่าน) ───
-- โค้ดฝั่ง client ลบรายการเดิมของออเดอร์ก่อนแล้ว insert ใหม่ → ต้องมีทั้ง INSERT + DELETE
DROP POLICY IF EXISTS "Sales can insert manual slip checks" ON ac_manual_slip_checks;
CREATE POLICY "Sales can insert manual slip checks"
  ON ac_manual_slip_checks FOR INSERT
  WITH CHECK (
    status = 'pending'
    AND EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('sales-tr', 'sales-pump')
    )
  );

DROP POLICY IF EXISTS "Sales can delete manual slip checks" ON ac_manual_slip_checks;
CREATE POLICY "Sales can delete manual slip checks"
  ON ac_manual_slip_checks FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('sales-tr', 'sales-pump')
    )
  );

NOTIFY pgrst, 'reload schema';
