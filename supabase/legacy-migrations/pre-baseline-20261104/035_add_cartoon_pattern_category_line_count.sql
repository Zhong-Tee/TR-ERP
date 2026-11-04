alter table if exists cp_cartoon_patterns
  add column if not exists product_category text,
  add column if not exists line_count smallint;

alter table if exists cp_cartoon_patterns
  add constraint cp_cartoon_patterns_line_count_check
  check (line_count is null or line_count between 1 and 3);
