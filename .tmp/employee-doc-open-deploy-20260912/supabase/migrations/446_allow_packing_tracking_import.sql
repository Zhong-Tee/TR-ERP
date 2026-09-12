-- Restrict tracking import to operational/admin roles and add packing_staff.
-- Patch the already-deployed function without duplicating its import implementation.
BEGIN;

DO $migration$
DECLARE
  v_definition TEXT;
  v_old_check CONSTANT TEXT := $old$IF v_role NOT IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'production', 'store') THEN$old$;
  v_new_check CONSTANT TEXT := $new$IF v_role NOT IN ('superadmin', 'admin', 'production', 'packing_staff') THEN$new$;
BEGIN
  SELECT pg_get_functiondef(
    'public.rpc_plan_import_tracking_batch(text,jsonb)'::regprocedure
  ) INTO v_definition;

  IF position(v_new_check IN v_definition) > 0 THEN
    RETURN;
  END IF;

  IF position(v_old_check IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Unable to locate the tracking-import authorization check';
  END IF;

  EXECUTE replace(v_definition, v_old_check, v_new_check);
END;
$migration$;

COMMIT;
