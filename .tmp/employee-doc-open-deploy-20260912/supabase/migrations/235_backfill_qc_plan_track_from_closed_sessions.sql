-- Backfill QC timestamps on plan_jobs for already-closed QC sessions.
-- Use the latest closed session per work order filename (WO-<name>).
--
-- This is intended to be run once after enabling
-- 234_sync_qc_plan_track_on_session_close.sql

DO $$
DECLARE
  r record;
  v_wo text;
  v_patch jsonb;
BEGIN
  FOR r IN
    WITH latest_closed AS (
      SELECT DISTINCT ON (filename)
        filename,
        start_time,
        end_time
      FROM qc_sessions
      WHERE end_time IS NOT NULL
        AND filename IS NOT NULL
        AND trim(filename) <> ''
        AND filename LIKE 'WO-%'
      ORDER BY filename, created_at DESC
    )
    SELECT
      lc.filename,
      lc.start_time,
      lc.end_time,
      pj.tracks AS plan_tracks
    FROM latest_closed lc
    JOIN plan_jobs pj
      ON pj.name = substr(lc.filename, 4)
    ORDER BY pj.date DESC
  LOOP
    v_wo := substr(r.filename, 4);
    v_wo := NULLIF(trim(both FROM v_wo), '');
    IF v_wo IS NULL THEN
      CONTINUE;
    END IF;

    -- Skip if QC end timestamp already exists on plan (avoid overwriting manual fixes).
    IF (r.plan_tracks ? 'QC')
       AND (COALESCE(r.plan_tracks->'QC'->'เสร็จแล้ว'->>'end', '') <> '') THEN
      CONTINUE;
    END IF;

    v_patch := jsonb_build_object(
      'เริ่มQC', jsonb_build_object(
        'start_if_null', to_jsonb(COALESCE(r.start_time, now())),
        'end', to_jsonb(COALESCE(r.end_time, now()))
      ),
      'เสร็จแล้ว', jsonb_build_object(
        'start_if_null', to_jsonb(COALESCE(r.start_time, now())),
        'end', to_jsonb(COALESCE(r.end_time, now()))
      )
    );

    PERFORM merge_plan_tracks_by_name(v_wo, 'QC', v_patch);
  END LOOP;
END $$;

