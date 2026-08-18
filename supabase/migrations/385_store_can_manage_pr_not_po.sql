-- =============================================================================
-- Migration 385: allow store to create/edit PR, while keeping approvals and PO
-- mutations restricted.
--
-- Migration 307 made store GR-only by removing the role from every PR/PO RPC
-- and adding a trigger that blocked all PR writes. The required permission is
-- now narrower:
--   - store may create and edit pending PRs through the existing RPCs
--   - store may not approve/reject PRs
--   - store may not create, edit, approve/mark ordered, or otherwise mutate PO
-- =============================================================================

BEGIN;

DO $$
DECLARE
  signature text;
  routine_oid oid;
  definition text;
  updated_definition text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.rpc_create_pr(jsonb,text,uuid,text,uuid,text)',
    'public.rpc_update_pr(uuid,jsonb,text,text,uuid,text)'
  ]
  LOOP
    routine_oid := to_regprocedure(signature);
    IF routine_oid IS NULL THEN
      RAISE EXCEPTION 'Required PR function does not exist: %', signature;
    END IF;

    definition := pg_get_functiondef(routine_oid);

    IF definition LIKE '%''store''%' THEN
      CONTINUE;
    END IF;

    updated_definition := replace(
      definition,
      '(''superadmin'', ''admin'', ''account'')',
      '(''superadmin'', ''admin'', ''store'', ''account'')'
    );

    IF updated_definition = definition OR updated_definition NOT LIKE '%''store''%' THEN
      RAISE EXCEPTION 'Unable to safely add store to %', signature;
    END IF;

    EXECUTE updated_definition;
  END LOOP;
END;
$$;

-- The blanket trigger from migration 307 also blocks SECURITY DEFINER PR RPCs.
-- Removing it is safe because store remains absent from direct PR table RLS
-- mutation policies and from approve/reject PR RPC authorization.
DROP TRIGGER IF EXISTS trg_block_store_pr_mutation ON public.inv_pr;
DROP FUNCTION IF EXISTS public.block_store_pr_mutation();

-- Fail the migration if a previous schema change has unexpectedly granted
-- store any approval or PO mutation RPC. This keeps the permission boundary
-- explicit and auditable.
DO $$
DECLARE
  signature text;
  routine_oid oid;
  definition text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.rpc_approve_pr(uuid,uuid)',
    'public.rpc_reject_pr(uuid,uuid,text)',
    'public.rpc_convert_pr_to_po(uuid,uuid,text,jsonb,text,uuid)',
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
    IF definition LIKE '%''store''%' AND
       definition NOT LIKE '%Store role is limited to GR receiving%' THEN
      RAISE EXCEPTION 'Store must not be authorized by sensitive function %', signature;
    END IF;
  END LOOP;
END;
$$;

-- Expose PR in the menu, but continue hiding PO for store.
INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES
  ('store', 'purchase', 'สั่งซื้อ', true),
  ('store', 'purchase-pr', 'PR', true),
  ('store', 'purchase-po', 'PO', false),
  ('store', 'purchase-gr', 'GR', true)
ON CONFLICT (role, menu_key)
DO UPDATE SET
  menu_name = EXCLUDED.menu_name,
  has_access = EXCLUDED.has_access,
  updated_at = now();

COMMIT;
