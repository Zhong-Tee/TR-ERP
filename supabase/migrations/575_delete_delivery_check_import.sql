-- Delete one mistaken delivery-check import. Child rows are removed by cascade;
-- ERP orders and tracking numbers are never changed.
BEGIN;

CREATE OR REPLACE FUNCTION public.tr_delivery_check_delete_import(p_import_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_import public.tr_delivery_check_imports;
  v_row_count INTEGER;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ลบประวัติการนำเข้า';
  END IF;

  SELECT * INTO v_import FROM public.tr_delivery_check_imports WHERE id = p_import_id;
  IF v_import.id IS NULL THEN RAISE EXCEPTION 'ไม่พบประวัติการนำเข้าที่ต้องการลบ'; END IF;

  SELECT count(*) INTO v_row_count
  FROM public.tr_delivery_check_rows
  WHERE import_id = p_import_id;

  DELETE FROM public.tr_delivery_check_imports WHERE id = p_import_id;

  RETURN jsonb_build_object(
    'deleted_import_id', v_import.id,
    'file_name', v_import.file_name,
    'carrier', v_import.carrier,
    'deleted_row_count', v_row_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.tr_delivery_check_delete_import(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tr_delivery_check_delete_import(UUID) TO authenticated;

COMMIT;
