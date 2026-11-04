-- Keep attendance records indefinitely while retaining their photos for 7 days.
-- Storage deletion is performed by the hr-time-clock-cleanup Edge Function.

BEGIN;

ALTER TABLE public.hr_time_entries
  ADD COLUMN IF NOT EXISTS photo_expired_at TIMESTAMPTZ;

COMMENT ON COLUMN public.hr_time_entries.photo_expired_at IS
  'Time the attendance photo was removed by the 7-day retention cleanup';

CREATE TABLE IF NOT EXISTS public.hr_time_clock_photo_cleanup_queue (
  path TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'time_entry_deleted',
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.hr_time_clock_photo_cleanup_queue ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.queue_deleted_time_clock_photo()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.photo_url IS NOT NULL AND btrim(OLD.photo_url) <> '' THEN
    INSERT INTO public.hr_time_clock_photo_cleanup_queue (path, reason, queued_at)
    VALUES (OLD.photo_url, 'time_entry_deleted', NOW())
    ON CONFLICT (path) DO UPDATE
      SET reason = EXCLUDED.reason,
          queued_at = EXCLUDED.queued_at;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_queue_deleted_time_clock_photo
  ON public.hr_time_entries;
CREATE TRIGGER trg_queue_deleted_time_clock_photo
BEFORE DELETE ON public.hr_time_entries
FOR EACH ROW
EXECUTE FUNCTION public.queue_deleted_time_clock_photo();

COMMIT;

