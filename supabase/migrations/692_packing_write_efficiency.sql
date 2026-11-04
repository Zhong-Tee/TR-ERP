-- Phase 3: reduce redundant writes; retain existing RLS, locks and stock formulas.
-- Apply before deploying the matching Packing client. No backfill or physical stock changes.
BEGIN;

CREATE OR REPLACE FUNCTION merge_plan_tracks(
  p_job_id TEXT,
  p_dept   TEXT,
  p_patch  JSONB
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_tracks JSONB;
  v_dept_tracks    JSONB;
  v_proc           TEXT;
  v_proc_patch     JSONB;
  v_current_proc   JSONB;
  v_result         JSONB;
BEGIN
  -- Lock the row to prevent concurrent writes
  SELECT COALESCE(tracks, '{}'::jsonb)
    INTO v_current_tracks
    FROM plan_jobs
   WHERE id = p_job_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE WARNING 'merge_plan_tracks: plan_job id=% not found', p_job_id;
    RETURN NULL;
  END IF;

  v_dept_tracks := COALESCE(v_current_tracks -> p_dept, '{}'::jsonb);

  FOR v_proc IN SELECT jsonb_object_keys(p_patch)
  LOOP
    v_proc_patch  := p_patch -> v_proc;
    v_current_proc := COALESCE(v_dept_tracks -> v_proc,
                               '{"start":null,"end":null}'::jsonb);

    -- start_if_null: set start only when current value IS NULL
    IF v_proc_patch ? 'start_if_null'
       AND (v_current_proc ->> 'start') IS NULL THEN
      v_current_proc := jsonb_set(v_current_proc, '{start}',
                                  v_proc_patch -> 'start_if_null');
    END IF;

    -- explicit start (always overwrites)
    IF v_proc_patch ? 'start' THEN
      v_current_proc := jsonb_set(v_current_proc, '{start}',
                                  v_proc_patch -> 'start');
    END IF;

    -- explicit end (always overwrites)
    IF v_proc_patch ? 'end' THEN
      v_current_proc := jsonb_set(v_current_proc, '{end}',
                                  v_proc_patch -> 'end');
    END IF;

    v_dept_tracks := jsonb_set(v_dept_tracks, ARRAY[v_proc],
                               v_current_proc, true);
  END LOOP;

  v_result := jsonb_set(v_current_tracks, ARRAY[p_dept],
                         v_dept_tracks, true);

  -- Keep the row lock and merge semantics, but emit no UPDATE/WAL/Realtime
  -- when start_if_null or a retry did not change the stored tracks.
  IF v_result IS DISTINCT FROM v_current_tracks THEN
    UPDATE plan_jobs SET tracks = v_result WHERE id = p_job_id;
  END IF;

  RETURN v_result;
END;
$$;


CREATE OR REPLACE FUNCTION public.fn_document_reservation_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_type text; v_old uuid; v_new uuid; v_fields text[];
BEGIN
  -- Item-save RPCs deliberately touch the header's updated_at to reconcile
  -- once after suppressing per-line reservations. Never skip that final touch.
  -- Limit the header optimization to actual packing-meta-only changes, allowing
  -- updated_at stamped by other triggers. Keep prebill expiry behavior intact.
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'or_orders'
      AND (to_jsonb(OLD)->'packing_meta') IS DISTINCT FROM (to_jsonb(NEW)->'packing_meta')
      AND (to_jsonb(OLD) - ARRAY['packing_meta','updated_at'])
        IS NOT DISTINCT FROM (to_jsonb(NEW) - ARRAY['packing_meta','updated_at'])
    THEN RETURN NULL; END IF;
    v_fields := CASE TG_TABLE_NAME
      WHEN 'or_order_items' THEN ARRAY['id','order_id','product_id','quantity','is_detail_row','cancellation_stock_action']
      ELSE NULL END;
    IF v_fields IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM unnest(v_fields) AS f(key)
      WHERE (to_jsonb(OLD)->f.key) IS DISTINCT FROM (to_jsonb(NEW)->f.key)
    ) THEN RETURN NULL; END IF;
  END IF;
  v_type:=CASE WHEN TG_TABLE_NAME LIKE 'or_prebill%' THEN 'prebill' ELSE 'order' END;
  IF TG_OP <> 'INSERT' THEN
    v_old:=CASE WHEN TG_TABLE_NAME IN ('or_orders','or_prebill_documents') THEN OLD.id
      WHEN v_type='prebill' THEN (to_jsonb(OLD)->>'document_id')::uuid ELSE (to_jsonb(OLD)->>'order_id')::uuid END;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new:=CASE WHEN TG_TABLE_NAME IN ('or_orders','or_prebill_documents') THEN NEW.id
      WHEN v_type='prebill' THEN (to_jsonb(NEW)->>'document_id')::uuid ELSE (to_jsonb(NEW)->>'order_id')::uuid END;
  END IF;
  IF v_old IS NOT NULL AND v_old IS DISTINCT FROM v_new THEN PERFORM public.fn_sync_document_reservations(v_type,v_old); END IF;
  IF v_new IS NOT NULL THEN PERFORM public.fn_sync_document_reservations(v_type,v_new); END IF;
  RETURN NULL;
END $$;

-- Merge against the current row under a lock. The first saved tag wins when
-- two packing stations open a bill together; parcel scan metadata is preserved.
CREATE OR REPLACE FUNCTION public.rpc_assign_packing_tags(p_tags jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  v_tag jsonb;
  v_result jsonb := '{}'::jsonb;
  v_count integer := 0;
BEGIN
  IF jsonb_typeof(p_tags) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_tags must be an array';
  END IF;
  IF jsonb_array_length(p_tags) > 500 THEN
    RAISE EXCEPTION 'At most 500 tags per request';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_tags) AS t(value)
    WHERE jsonb_typeof(value) IS DISTINCT FROM 'object'
      OR jsonb_typeof(value->'order_id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(value->'tag') IS DISTINCT FROM 'number'
  ) THEN RAISE EXCEPTION 'Invalid packing tag'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_tags) AS t(order_id uuid, tag numeric)
    WHERE order_id IS NULL OR tag IS NULL OR tag < 1
      OR tag > 9007199254740991 OR tag <> trunc(tag)
  ) OR (
    SELECT count(DISTINCT order_id) FROM jsonb_to_recordset(p_tags) AS t(order_id uuid, tag numeric)
  ) <> jsonb_array_length(p_tags) THEN
    RAISE EXCEPTION 'Invalid or duplicate packing tag';
  END IF;

  FOR r IN
    SELECT o.id, o.packing_meta, t.tag
    FROM public.or_orders o
    JOIN jsonb_to_recordset(p_tags) AS t(order_id uuid, tag numeric) ON t.order_id = o.id
    ORDER BY o.id FOR UPDATE OF o
  LOOP
    v_tag := r.packing_meta->'dailyPackingTag';
    IF v_tag IS NULL OR v_tag = 'null'::jsonb THEN
      UPDATE public.or_orders
      SET packing_meta = jsonb_set(
        CASE WHEN jsonb_typeof(packing_meta) = 'object' THEN packing_meta ELSE '{}'::jsonb END,
        '{dailyPackingTag}', to_jsonb(r.tag), true)
      WHERE id = r.id
      RETURNING packing_meta->'dailyPackingTag' INTO v_tag;
      IF NOT FOUND THEN RAISE EXCEPTION 'Cannot update a requested packing order'; END IF;
    END IF;
    v_result := v_result || jsonb_build_object(r.id::text, v_tag);
    v_count := v_count + 1;
  END LOOP;
  -- Do not silently display tags that RLS prevented us from saving. An error
  -- rolls the whole request back, including preceding rows in this batch.
  IF v_count <> jsonb_array_length(p_tags) THEN
    RAISE EXCEPTION 'A requested packing order is unavailable';
  END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_assign_packing_tags(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_assign_packing_tags(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
