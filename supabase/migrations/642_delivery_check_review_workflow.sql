BEGIN;
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
  SET note = nullif(btrim(coalesce(p_note, '')), ''),
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

CREATE OR REPLACE FUNCTION public.tr_delivery_check_move_to_review(p_row_id UUID, p_note TEXT)
RETURNS public.tr_delivery_check_rows
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_row public.tr_delivery_check_rows;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขผลตรวจสอบการส่ง';
  END IF;
  SELECT * INTO v_row FROM public.tr_delivery_check_rows WHERE id = p_row_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.source_kind <> 'carrier' OR NOT v_row.is_consignment THEN
    RAISE EXCEPTION 'รายการนี้ไม่ใช่รายการฝากส่ง';
  END IF;
  -- Serialize summary refreshes for this import.
  PERFORM 1 FROM public.tr_delivery_check_imports WHERE id = v_row.import_id FOR UPDATE;
  UPDATE public.tr_delivery_check_rows
  SET is_consignment = false, match_status = 'unmatched', match_method = 'manual_review',
      match_detail = 'เจ้าหน้าที่เปลี่ยนจากฝากส่งเป็นต้องตรวจ',
      note = nullif(btrim(coalesce(p_note, '')), ''), review_status = 'open',
      reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
  WHERE id = p_row_id RETURNING * INTO v_row;
  UPDATE public.tr_delivery_check_imports i
  SET consignment_count = (SELECT count(*) FROM public.tr_delivery_check_rows r WHERE r.import_id = i.id AND r.source_kind = 'carrier' AND r.match_status = 'consignment'), updated_at = now()
  WHERE i.id = v_row.import_id;
  PERFORM public.tr_delivery_check_rebuild_system_only(v_row.import_id);
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.tr_delivery_check_move_to_review(UUID,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tr_delivery_check_move_to_review(UUID,TEXT) TO authenticated;

COMMIT;
