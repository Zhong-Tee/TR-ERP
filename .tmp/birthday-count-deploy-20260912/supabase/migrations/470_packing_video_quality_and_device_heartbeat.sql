-- Packing video diagnostics and per-device heartbeat.

ALTER TABLE public.pk_packing_upload_queue_reports
  ADD COLUMN IF NOT EXISTS quality_profile TEXT,
  ADD COLUMN IF NOT EXISTS requested_width INTEGER,
  ADD COLUMN IF NOT EXISTS requested_height INTEGER,
  ADD COLUMN IF NOT EXISTS requested_fps NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS requested_bitrate INTEGER,
  ADD COLUMN IF NOT EXISTS actual_width INTEGER,
  ADD COLUMN IF NOT EXISTS actual_height INTEGER,
  ADD COLUMN IF NOT EXISTS actual_fps NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS codec TEXT,
  ADD COLUMN IF NOT EXISTS recorder_bitrate INTEGER,
  ADD COLUMN IF NOT EXISTS actual_bitrate INTEGER;

ALTER TABLE public.pk_packing_videos
  ADD COLUMN IF NOT EXISTS quality_profile TEXT,
  ADD COLUMN IF NOT EXISTS requested_width INTEGER,
  ADD COLUMN IF NOT EXISTS requested_height INTEGER,
  ADD COLUMN IF NOT EXISTS requested_fps NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS requested_bitrate INTEGER,
  ADD COLUMN IF NOT EXISTS actual_width INTEGER,
  ADD COLUMN IF NOT EXISTS actual_height INTEGER,
  ADD COLUMN IF NOT EXISTS actual_fps NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS codec TEXT,
  ADD COLUMN IF NOT EXISTS recorder_bitrate INTEGER,
  ADD COLUMN IF NOT EXISTS actual_bitrate INTEGER;

CREATE TABLE IF NOT EXISTS public.pk_packing_devices (
  device_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  device_name TEXT NOT NULL,
  quality_profile TEXT NOT NULL DEFAULT 'standard',
  folder_name TEXT,
  folder_path TEXT,
  pending_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  uploading_count INTEGER NOT NULL DEFAULT 0 CHECK (uploading_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pk_packing_devices_last_seen
  ON public.pk_packing_devices (last_seen_at DESC);

CREATE OR REPLACE FUNCTION public.pk_touch_packing_device_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pk_touch_packing_device_updated_at
  ON public.pk_packing_devices;
CREATE TRIGGER trg_pk_touch_packing_device_updated_at
  BEFORE UPDATE ON public.pk_packing_devices
  FOR EACH ROW EXECUTE FUNCTION public.pk_touch_packing_device_updated_at();

ALTER TABLE public.pk_packing_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read packing devices"
  ON public.pk_packing_devices;
CREATE POLICY "Authenticated users can read packing devices"
  ON public.pk_packing_devices FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "Users can insert own packing device"
  ON public.pk_packing_devices;
CREATE POLICY "Users can insert own packing device"
  ON public.pk_packing_devices FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update packing device heartbeat"
  ON public.pk_packing_devices;
CREATE POLICY "Users can update packing device heartbeat"
  ON public.pk_packing_devices FOR UPDATE TO authenticated
  USING (TRUE)
  WITH CHECK (user_id = auth.uid());
