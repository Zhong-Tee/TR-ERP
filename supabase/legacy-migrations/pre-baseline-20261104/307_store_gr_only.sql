-- =============================================================================
-- Migration 307: store is GR/receiving-only in the purchase module
--   - No PR create/edit/approve/reject/cancel.
--   - No PO create/edit/mark ordered.
--   - GR permissions remain unchanged.
-- =============================================================================

BEGIN;

-- Remove store from all active PR/PO mutation RPCs that have their own role list.
DO $$
DECLARE
  signature text;
  routine_oid oid;
  definition text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.rpc_create_pr(jsonb,text,uuid,text,uuid,text)',
    'public.rpc_update_pr(uuid,jsonb,text,text,uuid,text)',
    'public.rpc_approve_pr(uuid,uuid)',
    'public.rpc_reject_pr(uuid,uuid,text)',
    'public.rpc_mark_po_ordered(uuid,uuid)',
    'public.rpc_update_po(uuid,text,date,jsonb)',
    'public.rpc_update_po_expected_arrival_date(uuid,date,uuid)'
  ]
  LOOP
    routine_oid := to_regprocedure(signature);
    IF routine_oid IS NULL THEN
      CONTINUE;
    END IF;

    definition := pg_get_functiondef(routine_oid);
    definition := regexp_replace(
      definition,
      ',[[:space:]]*''store''',
      '',
      'g'
    );

    IF definition LIKE '%''store''%' THEN
      RAISE EXCEPTION 'Unable to safely remove store from %', signature;
    END IF;

    EXECUTE definition;
  END LOOP;
END;
$$;

-- rpc_convert_pr_to_po historically has no role check. Add a narrow store guard
-- while preserving its latest numbering, pricing and locking behavior.
DO $$
DECLARE
  routine_oid oid;
  definition text;
BEGIN
  routine_oid := to_regprocedure(
    'public.rpc_convert_pr_to_po(uuid,uuid,text,jsonb,text,uuid)'
  );

  IF routine_oid IS NOT NULL THEN
    definition := pg_get_functiondef(routine_oid);

    IF definition NOT LIKE '%Store role is limited to GR receiving%' THEN
      definition := regexp_replace(
        definition,
        'BEGIN',
        E'BEGIN\n  IF EXISTS (SELECT 1 FROM public.us_users WHERE id = auth.uid() AND role = ''store'') THEN\n    RAISE EXCEPTION ''Store role is limited to GR receiving'';\n  END IF;',
        1,
        1
      );
      EXECUTE definition;
    END IF;
  END IF;
END;
$$;

-- Remove store from direct table mutations. Existing authenticated SELECT
-- policies remain, allowing GR screens to reference PR/PO data.
DO $$
DECLARE
  policy_row record;
  role_list text;
  using_expression text;
  check_expression text;
  alter_sql text;
BEGIN
  FOR policy_row IN
    SELECT p.schemaname, p.tablename, p.policyname, p.cmd,
           p.roles, p.qual, p.with_check
    FROM pg_policies p
    JOIN (VALUES
      ('inv_pr', 'Purchase roles can manage PR'),
      ('inv_pr_items', 'Purchase roles can manage PR items'),
      ('inv_po', 'Purchase roles can manage PO'),
      ('inv_po_items', 'Purchase roles can manage PO items')
    ) AS targets(tablename, policyname)
      ON targets.tablename = p.tablename
     AND targets.policyname = p.policyname
    WHERE p.schemaname = 'public'
      AND (
        COALESCE(p.qual, '') LIKE '%''store''%'
        OR COALESCE(p.with_check, '') LIKE '%''store''%'
      )
  LOOP
    SELECT string_agg(quote_ident(role_name), ', ')
    INTO role_list
    FROM unnest(policy_row.roles) AS role_name;

    using_expression := regexp_replace(
      policy_row.qual,
      ',[[:space:]]*''store''::text',
      '',
      'g'
    );
    check_expression := regexp_replace(
      policy_row.with_check,
      ',[[:space:]]*''store''::text',
      '',
      'g'
    );

    IF COALESCE(using_expression, '') LIKE '%''store''%'
       OR COALESCE(check_expression, '') LIKE '%''store''%' THEN
      RAISE EXCEPTION 'Unable to safely remove store from policy %.%/%',
        policy_row.schemaname, policy_row.tablename, policy_row.policyname;
    END IF;

    alter_sql := format(
      'ALTER POLICY %I ON %I.%I TO %s',
      policy_row.policyname,
      policy_row.schemaname,
      policy_row.tablename,
      COALESCE(role_list, 'PUBLIC')
    );

    IF policy_row.cmd IN ('SELECT', 'UPDATE', 'DELETE', 'ALL')
       AND using_expression IS NOT NULL THEN
      alter_sql := alter_sql || format(' USING (%s)', using_expression);
    END IF;
    IF policy_row.cmd IN ('INSERT', 'UPDATE', 'ALL')
       AND check_expression IS NOT NULL THEN
      alter_sql := alter_sql || format(' WITH CHECK (%s)', check_expression);
    END IF;

    EXECUTE alter_sql;
  END LOOP;
END;
$$;

-- Defense in depth: even a SECURITY DEFINER RPC cannot let store mutate PR.
CREATE OR REPLACE FUNCTION public.block_store_pr_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND role = 'store'
  ) THEN
    RAISE EXCEPTION 'Store role is limited to GR receiving';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_store_pr_mutation ON public.inv_pr;
CREATE TRIGGER trg_block_store_pr_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.inv_pr
  FOR EACH ROW EXECUTE FUNCTION public.block_store_pr_mutation();

-- Store sees only the GR submenu. Keep purchase parent enabled so Sidebar opens GR.
INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES
  ('store', 'purchase', 'สั่งซื้อ', true),
  ('store', 'purchase-pr', 'PR', false),
  ('store', 'purchase-po', 'PO', false),
  ('store', 'purchase-gr', 'GR', true),
  ('store', 'purchase-sample', 'สินค้าตัวอย่าง', false)
ON CONFLICT (role, menu_key)
DO UPDATE SET
  menu_name = EXCLUDED.menu_name,
  has_access = EXCLUDED.has_access,
  updated_at = now();

COMMIT;
