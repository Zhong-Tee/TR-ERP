-- Remove pattern_code column from cp_cartoon_patterns table
-- ลบคอลัมน์ pattern_code ออกจากตาราง cp_cartoon_patterns

ALTER TABLE cp_cartoon_patterns
DROP COLUMN IF EXISTS pattern_code;

COMMENT ON TABLE cp_cartoon_patterns IS 'ตารางลายการ์ตูน (ไม่ใช้ pattern_code แล้ว)';
