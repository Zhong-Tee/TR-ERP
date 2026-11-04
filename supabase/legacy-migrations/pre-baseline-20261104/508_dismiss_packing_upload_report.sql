-- Allow failed/stale Packing upload report rows to be removed from the shared
-- report without letting a later heartbeat recreate the same visible row.

BEGIN;

ALTER TABLE public.pk_packing_upload_queue_reports
  ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dismissed_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pk_upload_queue_reports_visible_created
  ON public.pk_packing_upload_queue_reports (client_created_at DESC)
  WHERE dismissed_at IS NULL;

CREATE OR REPLACE FUNCTION public.rpc_dismiss_packing_upload_report(p_report_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_owner UUID;
  v_status TEXT;
  v_reported_at TIMESTAMPTZ;
  v_is_admin BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'กรุณาเข้าสู่ระบบ';
  END IF;

  SELECT r.user_id,r.status,r.reported_at
  INTO v_owner,v_status,v_reported_at
  FROM public.pk_packing_upload_queue_reports r
  WHERE r.id=p_report_id AND r.dismissed_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id=v_uid AND u.role IN ('superadmin','admin')
  ) INTO v_is_admin;

  IF NOT v_is_admin AND v_owner IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ลบรายการของเครื่องหรือผู้ใช้อื่น';
  END IF;

  IF NOT (
    v_status='failed'
    OR (v_status='uploading' AND v_reported_at < NOW()-INTERVAL '10 minutes')
    OR (v_status='pending' AND v_reported_at < NOW()-INTERVAL '30 minutes')
  ) THEN
    RAISE EXCEPTION 'ลบได้เฉพาะรายการที่มีปัญหาหรือค้างเท่านั้น';
  END IF;

  UPDATE public.pk_packing_upload_queue_reports
  SET dismissed_at=NOW(),dismissed_by=v_uid
  WHERE id=p_report_id;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_dismiss_packing_upload_report(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_dismiss_packing_upload_report(UUID) TO authenticated,service_role;

COMMENT ON FUNCTION public.rpc_dismiss_packing_upload_report(UUID) IS
  'Soft-deletes a failed/stale Packing upload report. Admins may dismiss any row; owners may dismiss their own.';

COMMIT;
