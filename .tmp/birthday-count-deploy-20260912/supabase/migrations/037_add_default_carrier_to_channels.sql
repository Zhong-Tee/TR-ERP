alter table if exists channels
  add column if not exists default_carrier text;
