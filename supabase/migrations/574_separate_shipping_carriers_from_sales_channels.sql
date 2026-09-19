-- Separate physical shipping companies from sales channels.
BEGIN;

CREATE TABLE IF NOT EXISTS public.tr_shipping_carriers (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tr_shipping_carriers_code_nonempty CHECK (btrim(code) <> ''),
  CONSTRAINT tr_shipping_carriers_name_nonempty CHECK (btrim(name) <> '')
);

INSERT INTO public.tr_shipping_carriers (code, name, sort_order) VALUES
  ('FLASH', 'Flash Express', 10),
  ('J&T', 'J&T Express', 20),
  ('SPX', 'SPX Express', 30),
  ('KEX', 'KEX Express', 40),
  ('THP', 'ไปรษณีย์ไทย', 50),
  ('OTHER', 'ขนส่งอื่น', 999)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  sort_order = EXCLUDED.sort_order;

ALTER TABLE public.tr_shipping_carriers ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.tr_shipping_carriers TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.tr_shipping_carriers TO authenticated;

CREATE POLICY tr_shipping_carriers_read
  ON public.tr_shipping_carriers FOR SELECT TO authenticated
  USING (true);

CREATE POLICY tr_shipping_carriers_admin_write
  ON public.tr_shipping_carriers FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'admin-tr')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'admin-tr')
  ));

CREATE OR REPLACE FUNCTION public.tr_delivery_check_rebuild_system_only(p_import_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_import public.tr_delivery_check_imports;
  v_count INTEGER := 0;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ประมวลผลรายการตรวจสอบการส่ง';
  END IF;

  SELECT * INTO v_import FROM public.tr_delivery_check_imports WHERE id = p_import_id;
  IF v_import.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรอบนำเข้า'; END IF;

  DELETE FROM public.tr_delivery_check_rows
  WHERE import_id = p_import_id AND source_kind = 'system';

  INSERT INTO public.tr_delivery_check_rows (
    import_id, source_kind, pickup_at, order_no, order_no_normalized,
    tracking_no, tracking_no_normalized, sender, consignee,
    consignee_phone, consignee_address, order_id, match_status, match_detail, raw_data
  )
  SELECT
    v_import.id, 'system', o.shipped_time, o.bill_no,
    public.tr_normalize_delivery_key(o.bill_no), o.tracking_number,
    public.tr_normalize_delivery_key(o.tracking_number), o.channel_code,
    coalesce(o.recipient_name, o.customer_name),
    nullif(o.billing_details->>'mobile_phone', ''), o.customer_address,
    o.id, 'system_only', 'บันทึกว่าส่งให้บริษัทขนส่งนี้แล้ว แต่ไม่พบในไฟล์ขนส่ง',
    jsonb_build_object('bill_no', o.bill_no, 'channel_code', o.channel_code, 'shipped_time', o.shipped_time)
  FROM public.or_orders o
  LEFT JOIN public.channels channel ON channel.channel_code = o.channel_code
  WHERE o.status = 'จัดส่งแล้ว'
    AND coalesce(o.fulfillment_method, CASE WHEN coalesce(channel.is_self_pickup, false) THEN 'self_pickup' ELSE 'shipping' END) = 'shipping'
    AND upper(btrim(coalesce(o.transport_meta->>'carrier', ''))) = upper(btrim(v_import.carrier))
    AND (o.shipped_time AT TIME ZONE 'Asia/Bangkok')::DATE BETWEEN v_import.pickup_date_from AND v_import.pickup_date_to
    AND NOT EXISTS (
      SELECT 1 FROM public.tr_delivery_check_rows row
      WHERE row.import_id = v_import.id AND row.order_id = o.id
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.tr_delivery_check_imports SET updated_at = now() WHERE id = v_import.id;
  RETURN jsonb_build_object('system_only_count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.tr_delivery_check_rebuild_system_only(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tr_delivery_check_rebuild_system_only(UUID) TO authenticated;

-- Correct historical results created from channel.default_carrier. Only bills with
-- an explicitly recorded physical carrier may become system-only rows.
DELETE FROM public.tr_delivery_check_rows WHERE source_kind = 'system';

INSERT INTO public.tr_delivery_check_rows (
  import_id, source_kind, pickup_at, order_no, order_no_normalized,
  tracking_no, tracking_no_normalized, sender, consignee,
  consignee_phone, consignee_address, order_id, match_status, match_detail, raw_data
)
SELECT
  import.id, 'system', orders.shipped_time, orders.bill_no,
  public.tr_normalize_delivery_key(orders.bill_no), orders.tracking_number,
  public.tr_normalize_delivery_key(orders.tracking_number), orders.channel_code,
  coalesce(orders.recipient_name, orders.customer_name),
  nullif(orders.billing_details->>'mobile_phone', ''), orders.customer_address,
  orders.id, 'system_only', 'บันทึกว่าส่งให้บริษัทขนส่งนี้แล้ว แต่ไม่พบในไฟล์ขนส่ง',
  jsonb_build_object('bill_no', orders.bill_no, 'channel_code', orders.channel_code, 'shipped_time', orders.shipped_time)
FROM public.tr_delivery_check_imports import
JOIN public.or_orders orders
  ON upper(btrim(coalesce(orders.transport_meta->>'carrier', ''))) = upper(btrim(import.carrier))
LEFT JOIN public.channels channel ON channel.channel_code = orders.channel_code
WHERE orders.status = 'จัดส่งแล้ว'
  AND coalesce(orders.fulfillment_method, CASE WHEN coalesce(channel.is_self_pickup, false) THEN 'self_pickup' ELSE 'shipping' END) = 'shipping'
  AND (orders.shipped_time AT TIME ZONE 'Asia/Bangkok')::DATE BETWEEN import.pickup_date_from AND import.pickup_date_to
  AND NOT EXISTS (
    SELECT 1 FROM public.tr_delivery_check_rows row
    WHERE row.import_id = import.id AND row.order_id = orders.id
  );

UPDATE public.tr_delivery_check_imports SET updated_at = now();

COMMIT;
