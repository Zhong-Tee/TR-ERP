-- A PO can arrive in multiple vehicles/parcels. Keep tracking_number populated
-- with the first parcel number for legacy consumers that still expect one value.
ALTER TABLE public.inv_po
  ADD COLUMN IF NOT EXISTS shipment_entries JSONB NOT NULL DEFAULT '[]'::JSONB;

COMMENT ON COLUMN public.inv_po.shipment_entries IS
  'Array of {vehicle_number, tracking_number, box_count} for inbound PO shipments';

ALTER TABLE public.inv_po
  DROP CONSTRAINT IF EXISTS inv_po_shipment_entries_shape_check;

ALTER TABLE public.inv_po
  ADD CONSTRAINT inv_po_shipment_entries_shape_check CHECK (
    jsonb_typeof(shipment_entries) = 'array'
    AND jsonb_array_length(shipment_entries) <= 50
  );

CREATE OR REPLACE FUNCTION public.rpc_update_po_shipment_entries(
  p_po_id UUID,
  p_entries JSONB DEFAULT '[]'::JSONB,
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
  v_entries JSONB := COALESCE(p_entries, '[]'::JSONB);
  v_entry JSONB;
  v_tracking_summary TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'manager', 'store', 'account', 'picker', 'auditor') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์บันทึกข้อมูลขนส่ง PO (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  IF jsonb_typeof(v_entries) <> 'array' OR jsonb_array_length(v_entries) > 50 THEN
    RAISE EXCEPTION 'ข้อมูลขนส่งต้องเป็นรายการและมีได้ไม่เกิน 50 รายการ';
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(v_entries)
  LOOP
    IF jsonb_typeof(v_entry) <> 'object'
      OR NULLIF(BTRIM(v_entry->>'vehicle_number'), '') IS NULL
      OR NULLIF(BTRIM(v_entry->>'tracking_number'), '') IS NULL
      OR char_length(BTRIM(v_entry->>'vehicle_number')) > 50
      OR char_length(BTRIM(v_entry->>'tracking_number')) > 100
      OR COALESCE(v_entry->>'box_count', '') !~ '^[1-9][0-9]*$'
    THEN
      RAISE EXCEPTION 'แต่ละรายการต้องมีเลขรถ เลขพัสดุ และจำนวนลังที่ถูกต้อง';
    END IF;
  END LOOP;

  SELECT NULLIF(BTRIM(value->>'tracking_number'), '')
  INTO v_tracking_summary
  FROM jsonb_array_elements(v_entries) WITH ORDINALITY AS rows(value, ordinality)
  ORDER BY ordinality
  LIMIT 1;

  UPDATE public.inv_po
  SET shipment_entries = v_entries,
      tracking_number = v_tracking_summary,
      updated_at = NOW()
  WHERE id = p_po_id
    AND status IN ('open', 'ordered', 'partial');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบ PO หรือ PO ไม่อยู่ในสถานะที่บันทึกข้อมูลขนส่งได้';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_update_po_shipment_entries(UUID, JSONB, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_update_po_shipment_entries(UUID, JSONB, UUID) TO authenticated;
