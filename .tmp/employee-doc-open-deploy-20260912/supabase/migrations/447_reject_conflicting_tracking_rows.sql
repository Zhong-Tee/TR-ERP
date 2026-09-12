-- Prevent a single RPC batch from silently overwriting one order with multiple
-- different tracking numbers. The web client resolves whole-file conflicts first;
-- this check protects direct RPC/API calls as well.
BEGIN;

DO $migration$
DECLARE
  v_definition TEXT;
  v_anchor CONSTANT TEXT := $anchor$  FOR v_row IN
    SELECT value AS data, ordinality::INTEGER AS row_no
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY
  LOOP$anchor$;
  v_guard CONSTANT TEXT := $guard$  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_rows) AS item
    WHERE NULLIF(btrim(COALESCE(item->>'bill_no', '')), '') IS NOT NULL
      AND NULLIF(btrim(COALESCE(item->>'tracking_number', '')), '') IS NOT NULL
    GROUP BY upper(btrim(item->>'bill_no'))
    HAVING count(DISTINCT upper(btrim(item->>'tracking_number'))) > 1
  ) THEN
    RAISE EXCEPTION 'One or more order numbers have multiple tracking numbers in the same import batch';
  END IF;

$guard$;
BEGIN
  SELECT pg_get_functiondef(
    'public.rpc_plan_import_tracking_batch(text,jsonb)'::regprocedure
  ) INTO v_definition;

  IF position('multiple tracking numbers in the same import batch' IN v_definition) > 0 THEN
    RETURN;
  END IF;

  IF position(v_anchor IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Unable to locate the tracking-import loop';
  END IF;

  EXECUTE replace(v_definition, v_anchor, v_guard || v_anchor);
END;
$migration$;

COMMIT;
