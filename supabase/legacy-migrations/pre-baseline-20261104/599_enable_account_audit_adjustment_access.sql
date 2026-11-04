-- Allow account users to review Audit results, create stock-adjustment
-- documents from them, and open the adjustment page for approval.

BEGIN;

INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES
  ('account', 'warehouse', 'คลัง', true),
  ('account', 'warehouse-audit', 'Audit', true),
  ('account', 'warehouse-adjust', 'ปรับสต๊อค', true)
ON CONFLICT (role, menu_key) DO UPDATE
SET
  menu_name = EXCLUDED.menu_name,
  has_access = true,
  updated_at = now();

COMMIT;
