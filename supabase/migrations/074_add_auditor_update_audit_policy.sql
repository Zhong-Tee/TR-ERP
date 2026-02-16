-- ============================================
-- 074: Add RLS policy for auditor to UPDATE inv_audits
-- แก้ปัญหา: auditor ส่งรีวิวแล้วสถานะไม่เปลี่ยน
-- เพราะไม่มี UPDATE policy บน inv_audits สำหรับ role auditor
-- ============================================

-- ให้ auditor UPDATE audit ที่ตนถูกมอบหมาย (เช่น เปลี่ยนสถานะเป็น review)
DROP POLICY IF EXISTS "Auditors can update assigned audits" ON inv_audits;
CREATE POLICY "Auditors can update assigned audits"
  ON inv_audits FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM us_users WHERE id = auth.uid() AND role = 'auditor'
    )
    AND auth.uid() = ANY(assigned_to)
    AND status = 'in_progress'
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users WHERE id = auth.uid() AND role = 'auditor'
    )
    AND auth.uid() = ANY(assigned_to)
  );
