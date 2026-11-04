-- Align Account > Bill edit menu access and history RLS with current roles.
BEGIN;

-- Ensure both roles can enter Account and see the Bill edit tab.
INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access, updated_at)
VALUES
  ('admin', 'account', 'บัญชี', TRUE, NOW()),
  ('admin', 'account-bill-edit', 'แก้ไขบิล', TRUE, NOW()),
  ('account', 'account', 'บัญชี', TRUE, NOW()),
  ('account', 'account-bill-edit', 'แก้ไขบิล', TRUE, NOW()),
  ('sales-tr', 'account', 'บัญชี', TRUE, NOW()),
  ('sales-tr', 'account-bill-edit', 'แก้ไขบิล', TRUE, NOW()),
  ('sales-pump', 'account', 'บัญชี', TRUE, NOW()),
  ('sales-pump', 'account-bill-edit', 'แก้ไขบิล', TRUE, NOW())
ON CONFLICT (role, menu_key) DO UPDATE
SET
  menu_name = EXCLUDED.menu_name,
  has_access = TRUE,
  updated_at = NOW();

-- Remove Bill edit visibility from every other DB-managed role. Superadmin is
-- intentionally unaffected because it bypasses st_user_menus.
UPDATE public.st_user_menus
SET has_access = FALSE, updated_at = NOW()
WHERE menu_key = 'account-bill-edit'
  AND role NOT IN ('admin', 'account', 'sales-tr', 'sales-pump');

-- Convert any stale user rows left by an older installation, then remove the
-- legacy permission rows so the obsolete role names are not recreated.
UPDATE public.us_users SET role = 'sales-tr' WHERE role = 'admin-tr';
UPDATE public.us_users SET role = 'sales-pump' WHERE role = 'admin-pump';

DELETE FROM public.st_user_menus
WHERE role IN ('admin-tr', 'admin-pump');

DROP POLICY IF EXISTS "ac_bill_edit_logs read" ON public.ac_bill_edit_logs;
DROP POLICY IF EXISTS "ac_bill_edit_logs write" ON public.ac_bill_edit_logs;

CREATE POLICY "ac_bill_edit_logs read"
  ON public.ac_bill_edit_logs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'account', 'sales-tr', 'sales-pump')
    )
  );

CREATE POLICY "ac_bill_edit_logs write"
  ON public.ac_bill_edit_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'account', 'sales-tr', 'sales-pump')
    )
  );

-- Revision history is part of the Bill edit screen and uses the same roles.
DROP POLICY IF EXISTS "or_order_revisions_select" ON public.or_order_revisions;
DROP POLICY IF EXISTS "or_order_revisions_insert" ON public.or_order_revisions;

CREATE POLICY "or_order_revisions_select"
  ON public.or_order_revisions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'account', 'sales-tr', 'sales-pump')
    )
  );

CREATE POLICY "or_order_revisions_insert"
  ON public.or_order_revisions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'account', 'sales-tr', 'sales-pump')
    )
  );

-- Harden the two SECURITY DEFINER entry points used by Bill edit. Rebuild the
-- installed definitions in-place so deployments with the latest function
-- body keep all existing behavior while the legacy roles are removed.
DO $$
DECLARE
  v_definition TEXT;
  v_updated TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'public.rpc_save_bill_edit_with_revision(uuid,jsonb,jsonb,text,jsonb)'::regprocedure
  ) INTO v_definition;
  v_updated := regexp_replace(
    v_definition,
    'v_role IS NULL OR v_role NOT IN \([^)]*\)',
    'v_role IS NULL OR v_role NOT IN (''superadmin'', ''admin'', ''account'', ''sales-tr'', ''sales-pump'')'
  );
  IF v_updated = v_definition
     AND v_updated NOT LIKE '%''sales-tr''%' THEN
    RAISE EXCEPTION 'Could not enforce role guard in rpc_save_bill_edit_with_revision';
  END IF;
  EXECUTE v_updated;

  SELECT pg_get_functiondef(
    'public.rpc_update_order_item_name_lines(uuid,jsonb,text)'::regprocedure
  ) INTO v_definition;
  v_updated := regexp_replace(
    v_definition,
    'v_role IS NULL OR v_role NOT IN \([^)]*\)',
    'v_role IS NULL OR v_role NOT IN (''superadmin'', ''admin'', ''account'', ''sales-tr'', ''sales-pump'')'
  );
  IF v_updated = v_definition
     AND v_updated NOT LIKE '%''sales-tr''%' THEN
    RAISE EXCEPTION 'Could not enforce role guard in rpc_update_order_item_name_lines';
  END IF;
  EXECUTE v_updated;
END;
$$;

COMMIT;
