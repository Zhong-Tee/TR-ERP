-- When a QC session is closed (end_time set), stamp QC on plan_jobs.tracks
-- This prevents missing Plan timestamps due to client/network issues.
--
-- Source of truth:
-- - qc_sessions.filename = 'WO-<work_order_name>'
-- - qc_sessions.start_time / end_time
--
-- Target:
-- - plan_jobs.tracks.QC['เริ่มQC'] and ['เสร็จแล้ว']
--   using merge_plan_tracks_by_name(name, 'QC', patch)

CREATE OR REPLACE FUNCTION tr_qc_sessions_sync_qc_plan_on_close()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo text;
  v_start timestamptz;
  v_end timestamptz;
  v_patch jsonb;
BEGIN
  -- Only act when the session is being closed (end_time from NULL to NOT NULL)
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF OLD.end_time IS NOT NULL OR NEW.end_time IS NULL THEN
    RETURN NEW;
  END IF;

  v_wo := NULLIF(trim(both FROM coalesce(NEW.filename, '')), '');
  IF v_wo IS NULL THEN
    RETURN NEW;
  END IF;

  -- Expect filename like "WO-<work_order_name>"
  IF v_wo LIKE 'WO-%' THEN
    v_wo := substr(v_wo, 4);
  END IF;
  v_wo := NULLIF(trim(both FROM v_wo), '');
  IF v_wo IS NULL THEN
    RETURN NEW;
  END IF;

  v_start := COALESCE(NEW.start_time, now());
  v_end := COALESCE(NEW.end_time, now());

  -- Mirror QC.tsx ensurePlanDeptEnd behavior:
  -- set end on both "เริ่มQC" and "เสร็จแล้ว", keep start stable if already set.
  v_patch := jsonb_build_object(
    'เริ่มQC', jsonb_build_object(
      'start_if_null', to_jsonb(v_start),
      'end', to_jsonb(v_end)
    ),
    'เสร็จแล้ว', jsonb_build_object(
      'start_if_null', to_jsonb(v_start),
      'end', to_jsonb(v_end)
    )
  );

  PERFORM merge_plan_tracks_by_name(v_wo, 'QC', v_patch);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS qc_sessions_sync_qc_plan_on_close ON qc_sessions;

CREATE TRIGGER qc_sessions_sync_qc_plan_on_close
  AFTER UPDATE OF end_time ON qc_sessions
  FOR EACH ROW
  EXECUTE FUNCTION tr_qc_sessions_sync_qc_plan_on_close();

COMMENT ON FUNCTION tr_qc_sessions_sync_qc_plan_on_close() IS
  'After qc_sessions.end_time is set (session closed), stamp QC เริ่มQC+เสร็จแล้ว on latest plan_jobs row for the related work order (filename WO-<name>).';

