-- Save the receiving note independently before receiving stock.
ALTER TABLE public.inv_po ADD COLUMN IF NOT EXISTS receiving_note TEXT;

CREATE OR REPLACE FUNCTION public.rpc_update_po_receiving_note(
  p_po_id UUID,
  p_note TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'manager', 'store', 'account', 'picker', 'auditor') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์บันทึกหมายเหตุรับสินค้า';
  END IF;

  UPDATE public.inv_po
  SET receiving_note = NULLIF(BTRIM(p_note), ''), updated_at = NOW()
  WHERE id = p_po_id AND status IN ('open', 'ordered', 'partial');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบ PO หรือ PO ไม่อยู่ในสถานะที่บันทึกหมายเหตุรับสินค้าได้';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_update_po_receiving_note(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_update_po_receiving_note(UUID, TEXT) TO authenticated;
