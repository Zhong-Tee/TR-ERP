-- Separate inventory-adjustment duties:
--   - store may create a document but must not approve it
--   - account may create and approve a document
-- The Warehouse UI is already available to both roles; these SECURITY DEFINER
-- RPC guards enforce the authorization at the database boundary.

BEGIN;

DO $$
DECLARE
  v_target record;
  v_definition text;
  v_updated text;
BEGIN
  FOR v_target IN
    SELECT * FROM (VALUES
      (
        'public.rpc_create_inventory_adjustment(text,text,text,jsonb)',
        'v_role IS NULL OR v_role NOT IN (''superadmin'', ''admin'', ''manager'', ''store'', ''account'')'
      ),
      (
        'public.rpc_approve_inventory_adjustment(uuid)',
        'v_role IS NULL OR v_role NOT IN (''superadmin'', ''admin'', ''manager'', ''account'')'
      )
    ) AS targets(signature, required_guard)
  LOOP
    IF to_regprocedure(v_target.signature) IS NULL THEN
      RAISE EXCEPTION 'Required inventory-adjustment routine is missing: %', v_target.signature;
    END IF;

    SELECT pg_get_functiondef(to_regprocedure(v_target.signature))
    INTO v_definition;

    v_updated := regexp_replace(
      v_definition,
      'v_role IS NULL OR v_role NOT IN \([^)]*\)',
      v_target.required_guard
    );

    -- Keep the migration idempotent while refusing to silently deploy against
    -- an unexpected authorization guard.
    IF position(v_target.required_guard IN v_updated) = 0 THEN
      RAISE EXCEPTION 'Could not enforce authorization guard in %', v_target.signature;
    END IF;

    EXECUTE v_updated;
  END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
