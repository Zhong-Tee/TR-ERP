-- Atomic merge for plan_jobs.tracks to prevent race conditions.
-- Instead of read-modify-write on the entire JSONB, this function
-- locks the row and merges only the specified department/process data.
--
-- p_patch format per process:
--   { "start": "iso" }           → always set start
--   { "end": "iso" }             → always set end
--   { "start_if_null": "iso" }   → set start only when current start IS NULL
--   Values can be JSON null to clear a field.
--
-- Example call:
--   SELECT merge_plan_tracks('J123', 'STAMP', '{"proc1":{"start":"2026-02-17T09:00:00Z"}}');

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

  UPDATE plan_jobs SET tracks = v_result WHERE id = p_job_id;

  RETURN v_result;
END;
$$;

-- Name-based variant used by WMS / QC / Packing pages.
-- Picks the latest plan_job (ORDER BY date DESC) to avoid the .single()
-- crash when the same work-order name appears on multiple dates.

CREATE OR REPLACE FUNCTION merge_plan_tracks_by_name(
  p_job_name TEXT,
  p_dept     TEXT,
  p_patch    JSONB
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_job_id TEXT;
  v_count  INT;
BEGIN
  SELECT count(*) INTO v_count
    FROM plan_jobs
   WHERE name = p_job_name;

  IF v_count = 0 THEN
    RAISE WARNING 'merge_plan_tracks_by_name: no plan_job with name=%', p_job_name;
    RETURN NULL;
  END IF;

  IF v_count > 1 THEN
    RAISE WARNING 'merge_plan_tracks_by_name: % rows for name=%, using latest date',
                  v_count, p_job_name;
  END IF;

  SELECT id INTO v_job_id
    FROM plan_jobs
   WHERE name = p_job_name
   ORDER BY date DESC
   LIMIT 1;

  RETURN merge_plan_tracks(v_job_id, p_dept, p_patch);
END;
$$;
