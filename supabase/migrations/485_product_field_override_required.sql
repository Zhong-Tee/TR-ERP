-- เก็บฟิลด์ที่เลือก "Override เปิด (บังคับกรอก)" แยกจาก boolean เดิม
-- เพื่อคง backward compatibility: ค่า boolean ของฟิลด์นั้นยังเป็น true (เปิดแสดง)
ALTER TABLE pr_product_field_overrides
  ADD COLUMN IF NOT EXISTS required_fields TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN pr_product_field_overrides.required_fields IS
  'รายชื่อ field key ที่ Override เปิดและบังคับกรอกก่อนเปิดบิล';
