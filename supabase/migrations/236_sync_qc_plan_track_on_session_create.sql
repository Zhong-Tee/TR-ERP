-- When a QC session is created (INSERT), stamp QC start on plan_jobs.tracks.
-- - qc_sessions.filename = 'WO-<work_order_name>'
-- - qc_sessions.start_time is the start timestamp
-- - Skip stamping for admin/superadmin (preserve existing QC page logic)

CREATE OR REPLACE FUNCTION tr_qc_sessions_sync_qc_plan_on_create()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo text;
  v_start timestamptz;
  v_patch jsonb;
  v_role text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Skip for admin/superadmin (same rule as QC UI).
  -- auth.uid() is available when called via Supabase authenticated clients.
  IF auth.uid() IS NOT NULL THEN
    SELECT u.role INTO v_role
    FROM us_users u
    WHERE u.id = auth.uid()
    LIMIT 1;
    IF v_role IN ('admin', 'superadmin') THEN
      RETURN NEW;
    END IF;
  END IF;

  v_wo := NULLIF(trim(both FROM coalesce(NEW.filename, '')), '');
  IF v_wo IS NULL OR v_wo NOT LIKE 'WO-%' THEN
    RETURN NEW;
  END IF;

  v_wo := substr(v_wo, 4);
  v_wo := NULLIF(trim(both FROM v_wo), '');
  IF v_wo IS NULL THEN
    RETURN NEW;
  END IF;

  v_start := COALESCE(NEW.start_time, now());
  v_patch := jsonb_build_object(
    'เริ่มQC', jsonb_build_object(
      'start_if_null', to_jsonb(v_start)
    )
  );

  PERFORM merge_plan_tracks_by_name(v_wo, 'QC', v_patch);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS qc_sessions_sync_qc_plan_on_create ON qc_sessions;

CREATE TRIGGER qc_sessions_sync_qc_plan_on_create
  AFTER INSERT ON qc_sessions
  FOR EACH ROW
  EXECUTE FUNCTION tr_qc_sessions_sync_qc_plan_on_create();

COMMENT ON FUNCTION tr_qc_sessions_sync_qc_plan_on_create() IS
  'After qc_sessions is inserted (filename WO-<name>), set QC เริ่มQC.start on latest plan_jobs row via merge_plan_tracks_by_name, skipping admin/superadmin.';

