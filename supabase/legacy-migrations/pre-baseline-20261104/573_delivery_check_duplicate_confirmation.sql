-- Read-only lookup used before import so the UI can require explicit confirmation.
BEGIN;

CREATE OR REPLACE FUNCTION public.tr_delivery_check_find_previous_duplicates(
  p_tracking_keys TEXT[]
)
RETURNS TABLE (
  tracking_no_normalized TEXT,
  tracking_no TEXT,
  previous_import_id UUID,
  previous_file_name TEXT,
  previous_carrier TEXT,
  previous_imported_at TIMESTAMPTZ,
  previous_pickup_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตรวจประวัติไฟล์ขนส่ง';
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (row.tracking_no_normalized)
    row.tracking_no_normalized,
    row.tracking_no,
    import.id,
    import.file_name,
    import.carrier,
    import.uploaded_at,
    row.pickup_at
  FROM public.tr_delivery_check_rows row
  JOIN public.tr_delivery_check_imports import ON import.id = row.import_id
  WHERE row.source_kind = 'carrier'
    AND row.tracking_no_normalized = ANY(coalesce(p_tracking_keys, ARRAY[]::TEXT[]))
  ORDER BY row.tracking_no_normalized, import.uploaded_at DESC, row.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.tr_delivery_check_find_previous_duplicates(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tr_delivery_check_find_previous_duplicates(TEXT[]) TO authenticated;

COMMIT;
