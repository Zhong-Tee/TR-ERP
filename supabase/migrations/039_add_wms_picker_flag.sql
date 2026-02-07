alter table if exists us_users
  add column if not exists wms_picker boolean default false;

update us_users
  set wms_picker = false
  where wms_picker is null;
