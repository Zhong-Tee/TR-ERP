-- Adapt delivery checking to the carrier's current export format and retire the
-- unreliable "system has it but file does not" comparison.
BEGIN;

CREATE OR REPLACE FUNCTION public.tr_delivery_check_rebuild_system_only(p_import_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_issue_count INTEGER := 0;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ประมวลผลรายการตรวจสอบการส่ง';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tr_delivery_check_imports WHERE id = p_import_id) THEN
    RAISE EXCEPTION 'ไม่พบรอบนำเข้า';
  END IF;

  DELETE FROM public.tr_delivery_check_rows
  WHERE import_id = p_import_id AND source_kind = 'system';

  SELECT count(*) INTO v_issue_count
  FROM public.tr_delivery_check_rows row
  WHERE row.import_id = p_import_id
    AND row.source_kind = 'carrier'
    AND row.review_status = 'open'
    AND (
      row.match_status NOT IN ('matched', 'manual_match', 'consignment')
      OR row.has_duplicate
      OR row.has_previous_import
    );

  UPDATE public.tr_delivery_check_imports
  SET system_only_count = 0,
      issue_count = v_issue_count,
      updated_at = now()
  WHERE id = p_import_id;

  RETURN jsonb_build_object('system_only_count', 0, 'issue_count', v_issue_count);
END;
$$;

REVOKE ALL ON FUNCTION public.tr_delivery_check_rebuild_system_only(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tr_delivery_check_rebuild_system_only(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.tr_delivery_check_review_row(
  p_row_id UUID,
  p_note TEXT,
  p_resolved BOOLEAN DEFAULT false
)
RETURNS public.tr_delivery_check_rows
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_row public.tr_delivery_check_rows;
  v_issue_count INTEGER := 0;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขผลตรวจสอบการส่ง';
  END IF;

  UPDATE public.tr_delivery_check_rows
  SET note = CASE
        WHEN is_consignment THEN nullif(btrim(coalesce(p_note, '')), '')
        ELSE note
      END,
      review_status = CASE WHEN p_resolved THEN 'resolved' ELSE review_status END,
      reviewed_by = CASE WHEN p_resolved THEN auth.uid() ELSE reviewed_by END,
      reviewed_at = CASE WHEN p_resolved THEN now() ELSE reviewed_at END,
      updated_at = now()
  WHERE id = p_row_id
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการตรวจสอบ'; END IF;

  SELECT count(*) INTO v_issue_count
  FROM public.tr_delivery_check_rows row
  WHERE row.import_id = v_row.import_id
    AND row.source_kind = 'carrier'
    AND row.review_status = 'open'
    AND (
      row.match_status NOT IN ('matched', 'manual_match', 'consignment')
      OR row.has_duplicate
      OR row.has_previous_import
    );

  UPDATE public.tr_delivery_check_imports
  SET issue_count = v_issue_count,
      updated_at = now()
  WHERE id = v_row.import_id;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.tr_delivery_check_review_row(UUID,TEXT,BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tr_delivery_check_review_row(UUID,TEXT,BOOLEAN) TO authenticated;

-- Remove historical system-only rows because this feature is no longer used.
DELETE FROM public.tr_delivery_check_rows WHERE source_kind = 'system';

UPDATE public.tr_delivery_check_imports import
SET system_only_count = 0,
    issue_count = (
      SELECT count(*)
      FROM public.tr_delivery_check_rows row
      WHERE row.import_id = import.id
        AND row.source_kind = 'carrier'
        AND row.review_status = 'open'
        AND (
          row.match_status NOT IN ('matched', 'manual_match', 'consignment')
          OR row.has_duplicate
          OR row.has_previous_import
        )
    ),
    updated_at = now();

COMMIT;
