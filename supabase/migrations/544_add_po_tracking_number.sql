-- Parcel tracking is saved on the PO before stock is received. Saving it must
-- not create a GR, change PO status, or add inventory.
ALTER TABLE public.inv_po
  ADD COLUMN IF NOT EXISTS tracking_number TEXT;

COMMENT ON COLUMN public.inv_po.tracking_number IS
  'Parcel tracking number saved before goods are received';

ALTER TABLE public.inv_po
  DROP CONSTRAINT IF EXISTS inv_po_tracking_number_length_check;

ALTER TABLE public.inv_po
  ADD CONSTRAINT inv_po_tracking_number_length_check
  CHECK (tracking_number IS NULL OR char_length(tracking_number) <= 100);

CREATE OR REPLACE FUNCTION public.rpc_update_po_tracking_number(
  p_po_id UUID,
  p_tracking_number TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_uid UUID := COALESCE(auth.uid(), p_user_id);
  v_tracking_number TEXT := NULLIF(BTRIM(p_tracking_number), '');
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'manager', 'store', 'account', 'picker', 'auditor') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์บันทึกเลขพัสดุ PO (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  IF v_tracking_number IS NOT NULL AND char_length(v_tracking_number) > 100 THEN
    RAISE EXCEPTION 'เลขพัสดุต้องไม่เกิน 100 ตัวอักษร';
  END IF;

  UPDATE public.inv_po
  SET tracking_number = v_tracking_number,
      updated_at = NOW()
  WHERE id = p_po_id
    AND status IN ('open', 'ordered', 'partial');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบ PO หรือ PO ไม่อยู่ในสถานะที่บันทึกเลขพัสดุได้';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_update_po_tracking_number(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_update_po_tracking_number(UUID, TEXT, UUID) TO authenticated;
