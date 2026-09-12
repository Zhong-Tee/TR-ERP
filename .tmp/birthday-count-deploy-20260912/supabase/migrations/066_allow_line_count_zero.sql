-- อนุญาตให้ line_count = 0 (ไม่รับข้อความบรรทัด)
ALTER TABLE cp_cartoon_patterns
  DROP CONSTRAINT IF EXISTS cp_cartoon_patterns_line_count_check;

ALTER TABLE cp_cartoon_patterns
  ADD CONSTRAINT cp_cartoon_patterns_line_count_check
  CHECK (line_count IS NULL OR line_count BETWEEN 0 AND 3);
