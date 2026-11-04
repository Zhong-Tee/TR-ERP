-- Store is an allowed sample editor; sales-tr must not access this submenu.
INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES
  ('store', 'purchase-sample', 'สินค้าตัวอย่าง', true),
  ('sales-tr', 'purchase-sample', 'สินค้าตัวอย่าง', false)
ON CONFLICT (role, menu_key)
DO UPDATE SET
  menu_name = EXCLUDED.menu_name,
  has_access = EXCLUDED.has_access,
  updated_at = now();
