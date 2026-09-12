alter table if exists us_users
  add column if not exists email text;
