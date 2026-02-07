alter table if exists or_orders
  add column if not exists transport_meta jsonb;
