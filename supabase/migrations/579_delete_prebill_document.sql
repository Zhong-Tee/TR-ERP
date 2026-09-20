-- Delete QT/PC documents through a narrow permission-checked operation.
-- Converted documents remain as immutable references to their created bills.

CREATE OR REPLACE FUNCTION public.rpc_delete_prebill_document(p_document_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc public.or_prebill_documents;
  v_role TEXT;
BEGIN
  SELECT role INTO v_role
  FROM public.us_users
  WHERE id = auth.uid();

  SELECT * INTO v_doc
  FROM public.or_prebill_documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF v_doc.id IS NULL THEN
    RAISE EXCEPTION 'ไม่พบเอกสารที่ต้องการลบ';
  END IF;

  IF v_doc.status = 'converted' OR v_doc.converted_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'ไม่สามารถลบเอกสารที่เปิดบิลแล้วได้';
  END IF;

  IF v_role = 'superadmin' THEN
    DELETE FROM public.or_prebill_documents WHERE id = p_document_id;
    RETURN true;
  END IF;

  IF v_role NOT IN ('sales-tr', 'sales-pump')
     OR v_doc.owner_id <> auth.uid()
     OR v_doc.status NOT IN ('draft', 'active', 'rejected') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ลบเอกสารนี้';
  END IF;

  DELETE FROM public.or_prebill_documents WHERE id = p_document_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_delete_prebill_document(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_delete_prebill_document(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
