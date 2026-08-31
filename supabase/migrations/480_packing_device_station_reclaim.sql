-- Make packing-device registrations reclaimable after browser storage/profile
-- changes. The browser still owns its local queue, while the server keeps the
-- stable station identity and prevents two recently-online browsers claiming
-- the same station.

ALTER TABLE public.pk_packing_devices
  ADD COLUMN IF NOT EXISTS last_username TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_by UUID;

CREATE INDEX IF NOT EXISTS idx_pk_packing_devices_active_seen
  ON public.pk_packing_devices (is_active, last_seen_at DESC);

UPDATE public.pk_packing_devices d
SET last_username = COALESCE(NULLIF(BTRIM(u.username), ''), 'unknown')
FROM public.us_users u
WHERE u.id = d.user_id
  AND d.last_username IS NULL;

CREATE OR REPLACE FUNCTION public.rpc_claim_packing_device(
  p_target_device_id TEXT,
  p_current_device_id TEXT,
  p_device_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_username TEXT;
  v_target public.pk_packing_devices%ROWTYPE;
  v_name TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'กรุณาเข้าสู่ระบบก่อนผูกสถานีแพ็ค';
  END IF;

  SELECT username INTO v_username
  FROM public.us_users
  WHERE id = v_uid AND COALESCE(is_active, TRUE) IS TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบผู้ใช้งานที่เปิดใช้งานอยู่';
  END IF;

  SELECT * INTO v_target
  FROM public.pk_packing_devices
  WHERE device_id = p_target_device_id
    AND is_active IS TRUE
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบทะเบียนสถานีแพ็คที่เลือก';
  END IF;

  IF COALESCE(p_current_device_id, '') <> p_target_device_id
     AND v_target.last_seen_at >= NOW() - INTERVAL '2 minutes' THEN
    RAISE EXCEPTION 'สถานี % กำลังออนไลน์อยู่ กรุณาปิดหน้าแพ็คที่เครื่องเดิมและรอ 2 นาที', v_target.device_name;
  END IF;

  IF COALESCE(p_current_device_id, '') <> ''
     AND EXISTS (
       SELECT 1
       FROM public.pk_packing_devices current_device
       WHERE current_device.device_id = p_current_device_id
         AND current_device.user_id <> v_uid
     ) THEN
    RAISE EXCEPTION 'ทะเบียน Browser ปัจจุบันไม่ได้เป็นของผู้ใช้งานที่เข้าสู่ระบบ';
  END IF;

  IF COALESCE(p_current_device_id, '') <> ''
     AND p_current_device_id <> p_target_device_id THEN
    UPDATE public.pk_packing_upload_queue_reports
    SET device_id = p_target_device_id,
        device_name = COALESCE(NULLIF(BTRIM(p_device_name), ''), v_target.device_name)
    WHERE device_id = p_current_device_id;

    UPDATE public.pk_packing_videos
    SET device_id = p_target_device_id,
        device_name = COALESCE(NULLIF(BTRIM(p_device_name), ''), v_target.device_name)
    WHERE device_id = p_current_device_id;

    UPDATE public.pk_packing_devices
    SET is_active = FALSE,
        pending_count = 0,
        uploading_count = 0,
        failed_count = 0
    WHERE device_id = p_current_device_id;
  END IF;

  v_name := COALESCE(NULLIF(BTRIM(p_device_name), ''), v_target.device_name);

  UPDATE public.pk_packing_devices
  SET user_id = v_uid,
      last_username = COALESCE(NULLIF(BTRIM(v_username), ''), 'unknown'),
      device_name = v_name,
      is_active = TRUE,
      claimed_at = NOW(),
      claimed_by = v_uid,
      last_seen_at = NOW()
  WHERE device_id = p_target_device_id;

  RETURN jsonb_build_object(
    'success', TRUE,
    'device_id', p_target_device_id,
    'device_name', v_name,
    'last_username', COALESCE(NULLIF(BTRIM(v_username), ''), 'unknown')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_claim_packing_device(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_claim_packing_device(TEXT, TEXT, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.rpc_claim_packing_device(TEXT, TEXT, TEXT) IS
  'Reclaims an offline packing station for the current browser and remaps its queue/video records.';

NOTIFY pgrst, 'reload schema';
