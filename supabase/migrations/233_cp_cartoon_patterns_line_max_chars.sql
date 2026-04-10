-- ลิมิตจำนวนตัวอักษรต่อบรรทัด (0 = ไม่จำกัด, NULL = ไม่ใช้บรรทัดนั้นหรือยังไม่ตั้ง)
alter table if exists cp_cartoon_patterns
  add column if not exists line_1_max_chars smallint,
  add column if not exists line_2_max_chars smallint,
  add column if not exists line_3_max_chars smallint;

alter table if exists cp_cartoon_patterns
  drop constraint if exists cp_cartoon_patterns_line_1_max_chars_check;
alter table if exists cp_cartoon_patterns
  add constraint cp_cartoon_patterns_line_1_max_chars_check
  check (line_1_max_chars is null or (line_1_max_chars >= 0 and line_1_max_chars <= 99));

alter table if exists cp_cartoon_patterns
  drop constraint if exists cp_cartoon_patterns_line_2_max_chars_check;
alter table if exists cp_cartoon_patterns
  add constraint cp_cartoon_patterns_line_2_max_chars_check
  check (line_2_max_chars is null or (line_2_max_chars >= 0 and line_2_max_chars <= 99));

alter table if exists cp_cartoon_patterns
  drop constraint if exists cp_cartoon_patterns_line_3_max_chars_check;
alter table if exists cp_cartoon_patterns
  add constraint cp_cartoon_patterns_line_3_max_chars_check
  check (line_3_max_chars is null or (line_3_max_chars >= 0 and line_3_max_chars <= 99));
