-- Server-side mirror of browser-local packing upload queues.
-- This makes queue health visible across users and packing computers.

CREATE TABLE IF NOT EXISTS public.pk_packing_upload_queue_reports (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  recorded_by TEXT NOT NULL DEFAULT 'unknown',
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  folder_name TEXT,
  folder_path TEXT,
  work_order_name TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (file_size_bytes >= 0),
  duration_seconds INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'uploading', 'success', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  last_error TEXT,
  local_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_at TIMESTAMPTZ,
  client_created_at TIMESTAMPTZ NOT NULL,
  client_updated_at TIMESTAMPTZ NOT NULL,
  uploaded_at TIMESTAMPTZ,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pk_upload_queue_reports_status
  ON public.pk_packing_upload_queue_reports (status, client_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pk_upload_queue_reports_user_device
  ON public.pk_packing_upload_queue_reports (user_id, device_id, client_created_at DESC);

CREATE OR REPLACE FUNCTION public.pk_preserve_completed_upload_report()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- A late browser heartbeat must never downgrade server-confirmed success.
  IF OLD.status = 'success' AND NEW.status <> 'success' THEN
    NEW.status := 'success';
    NEW.uploaded_at := OLD.uploaded_at;
    NEW.last_error := NULL;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pk_preserve_completed_upload_report
  ON public.pk_packing_upload_queue_reports;
CREATE TRIGGER trg_pk_preserve_completed_upload_report
  BEFORE UPDATE ON public.pk_packing_upload_queue_reports
  FOR EACH ROW EXECUTE FUNCTION public.pk_preserve_completed_upload_report();

ALTER TABLE public.pk_packing_upload_queue_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read packing upload reports"
  ON public.pk_packing_upload_queue_reports;
CREATE POLICY "Authenticated users can read packing upload reports"
  ON public.pk_packing_upload_queue_reports FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "Users can insert own packing upload reports"
  ON public.pk_packing_upload_queue_reports;
CREATE POLICY "Users can insert own packing upload reports"
  ON public.pk_packing_upload_queue_reports FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own packing upload reports"
  ON public.pk_packing_upload_queue_reports;
CREATE POLICY "Users can update own packing upload reports"
  ON public.pk_packing_upload_queue_reports FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

ALTER TABLE public.pk_packing_videos
  ADD COLUMN IF NOT EXISTS upload_queue_id UUID,
  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS device_id TEXT,
  ADD COLUMN IF NOT EXISTS device_name TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pk_packing_videos_upload_queue_id
  ON public.pk_packing_videos (upload_queue_id)
  WHERE upload_queue_id IS NOT NULL;
