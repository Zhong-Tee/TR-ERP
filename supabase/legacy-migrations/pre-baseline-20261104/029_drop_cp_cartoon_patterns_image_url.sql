-- ลบคอลัมน์ image_url จาก cp_cartoon_patterns
-- รูปลายการ์ตูนดึงจาก Bucket cartoon-patterns ชื่อไฟล์ = pattern_name (.jpg/.png ฯลฯ)
ALTER TABLE cp_cartoon_patterns DROP COLUMN IF EXISTS image_url;
