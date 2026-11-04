-- =============================================================================
-- ประเภทการลา: เพิ่มชื่อเอกสารที่ต้องแนบ (ใช้เป็นป้ายปุ่มอัปโหลดตอนขอลา)
-- IDEMPOTENT: safe to re-run
-- =============================================================================

ALTER TABLE hr_leave_types ADD COLUMN IF NOT EXISTS doc_label TEXT;

-- ตั้งชื่อเอกสารเริ่มต้นให้ลาป่วย (ที่ requires_doc = true อยู่แล้ว)
UPDATE hr_leave_types
SET doc_label = 'ใบรับรองแพทย์'
WHERE requires_doc = true AND (doc_label IS NULL OR doc_label = '') AND name ILIKE '%ป่วย%';
