-- Store the actual fulfillment method per bill. Channel configuration is only
-- the default for newly-created bills, so changing one SHOPP bill to shipping
-- never changes other bills from the same channel.

ALTER TABLE public.or_orders
  ADD COLUMN IF NOT EXISTS fulfillment_method TEXT,
  ADD COLUMN IF NOT EXISTS converted_from_self_pickup_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS converted_from_self_pickup_by TEXT;

UPDATE public.or_orders o
SET fulfillment_method = CASE
  WHEN COALESCE(c.is_self_pickup, false) THEN 'self_pickup'
  ELSE 'shipping'
END
FROM public.channels c
WHERE c.channel_code = o.channel_code
  AND o.fulfillment_method IS NULL;

UPDATE public.or_orders
SET fulfillment_method = 'shipping'
WHERE fulfillment_method IS NULL;

ALTER TABLE public.or_orders
  ALTER COLUMN fulfillment_method SET NOT NULL;

ALTER TABLE public.or_orders
  DROP CONSTRAINT IF EXISTS or_orders_fulfillment_method_check;
ALTER TABLE public.or_orders
  ADD CONSTRAINT or_orders_fulfillment_method_check
  CHECK (fulfillment_method IN ('self_pickup', 'shipping'));

COMMENT ON COLUMN public.or_orders.fulfillment_method IS
'Actual bill fulfillment method. Channel is only the creation default; self_pickup may be converted to shipping per bill.';

CREATE TABLE IF NOT EXISTS public.or_fulfillment_change_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.or_orders(id) ON DELETE CASCADE,
  bill_no TEXT,
  from_method TEXT NOT NULL,
  to_method TEXT NOT NULL,
  reason TEXT,
  previous_status TEXT,
  previous_customer_address TEXT,
  previous_recipient_name TEXT,
  previous_tracking_number TEXT,
  changed_by TEXT NOT NULL,
  changed_by_user_id UUID REFERENCES auth.users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_method IN ('self_pickup', 'shipping')),
  CHECK (to_method IN ('self_pickup', 'shipping'))
);

CREATE INDEX IF NOT EXISTS idx_or_fulfillment_change_logs_order_time
  ON public.or_fulfillment_change_logs(order_id, changed_at DESC);

ALTER TABLE public.or_fulfillment_change_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Fulfillment users can view change logs" ON public.or_fulfillment_change_logs;
CREATE POLICY "Fulfillment users can view change logs"
  ON public.or_fulfillment_change_logs FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid()
      AND role IN ('superadmin', 'admin', 'packing_staff', 'production', 'sales-tr', 'account')
  ));

-- Assign the channel default only when an insert did not provide a method.
-- Tracking normalization now follows the bill method, not channel_code.
CREATE OR REPLACE FUNCTION public.normalize_shop_pickup_tracking_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_default_method TEXT;
BEGIN
  IF NEW.fulfillment_method IS NULL THEN
    SELECT CASE WHEN COALESCE(c.is_self_pickup, false) THEN 'self_pickup' ELSE 'shipping' END
    INTO v_default_method
    FROM public.channels c
    WHERE c.channel_code = NEW.channel_code;
    NEW.fulfillment_method := COALESCE(v_default_method, 'shipping');
  END IF;

  IF NEW.fulfillment_method = 'self_pickup' THEN
    NEW.tracking_number := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_00_normalize_shop_pickup_tracking ON public.or_orders;
CREATE TRIGGER trg_00_normalize_shop_pickup_tracking
BEFORE INSERT OR UPDATE OF channel_code, fulfillment_method, tracking_number ON public.or_orders
FOR EACH ROW
EXECUTE FUNCTION public.normalize_shop_pickup_tracking_number();

CREATE OR REPLACE FUNCTION public.pk_convert_self_pickup_to_shipping(
  p_order_id UUID,
  p_recipient_name TEXT,
  p_original_address TEXT,
  p_address_line TEXT,
  p_sub_district TEXT,
  p_district TEXT,
  p_province TEXT,
  p_postal_code TEXT,
  p_mobile_phone TEXT,
  p_reason TEXT,
  p_changed_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT;
  v_order public.or_orders;
  v_is_shipped BOOLEAN;
  v_tag JSONB;
  v_customer_address TEXT;
  v_changed_at TIMESTAMPTZ := now();
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role NOT IN ('superadmin', 'admin', 'packing_staff', 'production', 'sales-tr') THEN
    RAISE EXCEPTION 'Not authorized to change fulfillment method';
  END IF;

  SELECT * INTO v_order FROM public.or_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_order.fulfillment_method <> 'self_pickup' THEN
    RAISE EXCEPTION 'This bill is not a self-pickup bill';
  END IF;

  IF NULLIF(btrim(COALESCE(p_recipient_name, '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(p_address_line, '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(p_province, '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(p_postal_code, '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(p_mobile_phone, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Recipient, address, province, postal code and phone are required';
  END IF;

  v_is_shipped := v_order.status = 'จัดส่งแล้ว';
  IF v_is_shipped AND v_role NOT IN ('superadmin', 'admin') THEN
    RAISE EXCEPTION 'Only superadmin/admin can reopen a shipped bill';
  END IF;
  IF v_is_shipped AND NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A reason is required to cancel shipment';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('PACK:' || COALESCE(v_order.work_order_name, ''), 0));

  INSERT INTO public.or_fulfillment_change_logs(
    order_id, bill_no, from_method, to_method, reason, previous_status,
    previous_customer_address, previous_recipient_name, previous_tracking_number,
    changed_by, changed_by_user_id, changed_at
  ) VALUES (
    v_order.id, v_order.bill_no, 'self_pickup', 'shipping',
    NULLIF(btrim(COALESCE(p_reason, '')), ''), v_order.status,
    v_order.customer_address, v_order.recipient_name, v_order.tracking_number,
    COALESCE(NULLIF(btrim(COALESCE(p_changed_by, '')), ''), 'unknown'), auth.uid(), v_changed_at
  );

  INSERT INTO public.pk_packing_reset_logs(
    order_id, work_order_name, reset_type, reason, previous_status,
    previous_packing_meta, previous_shipped_by, previous_shipped_time, reset_by
  ) VALUES (
    v_order.id, v_order.work_order_name,
    CASE WHEN v_is_shipped THEN 'cancel_shipment' ELSE 'rescan' END,
    COALESCE(NULLIF(btrim(COALESCE(p_reason, '')), ''), 'เปลี่ยนจากรับสินค้าเองเป็นจัดส่ง'),
    v_order.status, v_order.packing_meta, v_order.shipped_by, v_order.shipped_time,
    COALESCE(NULLIF(btrim(COALESCE(p_changed_by, '')), ''), 'unknown')
  );

  DELETE FROM public.pk_packing_unit_scans WHERE order_id = v_order.id;
  v_tag := CASE
    WHEN COALESCE(v_order.packing_meta, '{}'::jsonb) ? 'dailyPackingTag'
      THEN jsonb_build_object('dailyPackingTag', v_order.packing_meta->'dailyPackingTag')
    ELSE NULL
  END;
  v_customer_address := concat_ws(' ',
    NULLIF(btrim(COALESCE(p_address_line, '')), ''),
    NULLIF(btrim(COALESCE(p_sub_district, '')), ''),
    NULLIF(btrim(COALESCE(p_district, '')), ''),
    NULLIF(btrim(COALESCE(p_province, '')), ''),
    NULLIF(btrim(COALESCE(p_postal_code, '')), '')
  );

  UPDATE public.or_orders
  SET fulfillment_method = 'shipping',
      converted_from_self_pickup_at = v_changed_at,
      converted_from_self_pickup_by = COALESCE(NULLIF(btrim(COALESCE(p_changed_by, '')), ''), 'unknown'),
      recipient_name = btrim(p_recipient_name),
      customer_address = v_customer_address,
      billing_details = COALESCE(v_order.billing_details, '{}'::jsonb) || jsonb_build_object(
        'address_line', NULLIF(btrim(COALESCE(p_address_line, '')), ''),
        'sub_district', NULLIF(btrim(COALESCE(p_sub_district, '')), ''),
        'district', NULLIF(btrim(COALESCE(p_district, '')), ''),
        'province', NULLIF(btrim(COALESCE(p_province, '')), ''),
        'postal_code', NULLIF(btrim(COALESCE(p_postal_code, '')), ''),
        'mobile_phone', NULLIF(btrim(COALESCE(p_mobile_phone, '')), ''),
        'original_customer_address', COALESCE(NULLIF(btrim(COALESCE(p_original_address, '')), ''), v_customer_address)
      ),
      tracking_number = NULL,
      packing_meta = v_tag,
      status = CASE WHEN v_is_shipped THEN 'ใบงานกำลังผลิต' ELSE status END,
      shipped_by = CASE WHEN v_is_shipped THEN NULL ELSE shipped_by END,
      shipped_time = CASE WHEN v_is_shipped THEN NULL ELSE shipped_time END
  WHERE id = v_order.id;

  IF v_is_shipped AND v_order.work_order_name IS NOT NULL THEN
    UPDATE public.or_work_orders SET status = 'กำลังผลิต'
    WHERE work_order_name = v_order.work_order_name;
    PERFORM public.merge_plan_tracks_by_name(
      v_order.work_order_name,
      'PACK',
      jsonb_build_object(
        'เริ่มแพ็ค', jsonb_build_object('end', NULL),
        'เสร็จแล้ว', jsonb_build_object('start', NULL, 'end', NULL)
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order.id,
    'work_order_name', v_order.work_order_name,
    'reopened_shipment', v_is_shipped,
    'changed_at', v_changed_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pk_convert_self_pickup_to_shipping(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pk_convert_self_pickup_to_shipping(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO authenticated;

-- Finalization follows the per-bill method. Shipping conversions therefore
-- require parcel tracking even though their channel is still SHOPP.
CREATE OR REPLACE FUNCTION public.pk_finalize_work_order(
  p_work_order_name TEXT,
  p_order_ids UUID[],
  p_shipped_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT;
  v_now TIMESTAMPTZ := now();
  v_pending INTEGER;
  v_updated INTEGER := 0;
  v_header_updated INTEGER := 0;
  v_incomplete RECORD;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role NOT IN ('packing_staff', 'production', 'sales-tr') THEN
    RAISE EXCEPTION 'Not authorized to finalize packing';
  END IF;
  IF NULLIF(trim(COALESCE(p_work_order_name, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Work order name is required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('PACK:' || p_work_order_name, 0));

  IF COALESCE(array_length(p_order_ids, 1), 0) > 0 THEN
    IF EXISTS (
      SELECT 1 FROM unnest(p_order_ids) requested(id)
      LEFT JOIN public.or_orders o ON o.id = requested.id
      WHERE o.id IS NULL OR o.work_order_name IS DISTINCT FROM p_work_order_name OR o.status = 'ยกเลิก'
    ) THEN
      RAISE EXCEPTION 'One or more bills do not belong to this active work order';
    END IF;

    SELECT
      COALESCE(NULLIF(trim(o.bill_no), ''), o.id::TEXT) AS bill_ref,
      o.fulfillment_method,
      NULLIF(trim(COALESCE(o.tracking_number, '')), '') AS tracking_number,
      units.expected,
      scans.scanned
    INTO v_incomplete
    FROM public.or_orders o
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(LEAST(GREATEST(i.quantity, 1), 9999)), 0)::INTEGER AS expected
      FROM public.or_order_items i
      WHERE i.order_id = o.id
        AND NULLIF(trim(COALESCE(i.cancellation_stock_action, '')), '') IS NULL
    ) units ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::INTEGER AS scanned
      FROM public.pk_packing_unit_scans s
      WHERE s.order_id = o.id
    ) scans ON true
    WHERE o.id = ANY(p_order_ids)
      AND COALESCE(o.channel_code, '') <> 'OFFICE'
      AND (
        (o.fulfillment_method = 'shipping' AND NULLIF(trim(COALESCE(o.tracking_number, '')), '') IS NULL)
        OR units.expected <= 0
        OR scans.scanned < units.expected
      )
    ORDER BY o.bill_no NULLS LAST, o.id
    LIMIT 1;

    IF FOUND THEN
      IF v_incomplete.tracking_number IS NULL AND v_incomplete.fulfillment_method = 'shipping' THEN
        RAISE EXCEPTION 'จัดส่งไม่ได้: บิล % ยังไม่มีเลขพัสดุ', v_incomplete.bill_ref;
      ELSIF v_incomplete.expected <= 0 THEN
        RAISE EXCEPTION 'จัดส่งไม่ได้: บิล % ไม่มีรายการสินค้าที่ต้องจัดส่ง', v_incomplete.bill_ref;
      ELSE
        RAISE EXCEPTION 'จัดส่งไม่ได้: บิล % สแกนสินค้าไม่ครบ (%/%)',
          v_incomplete.bill_ref, v_incomplete.scanned, v_incomplete.expected;
      END IF;
    END IF;

    UPDATE public.or_orders
    SET status = 'จัดส่งแล้ว', shipped_by = p_shipped_by, shipped_time = v_now
    WHERE id = ANY(p_order_ids)
      AND work_order_name = p_work_order_name
      AND status <> 'ยกเลิก';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  END IF;

  SELECT count(*)::INTEGER INTO v_pending
  FROM public.or_orders
  WHERE work_order_name = p_work_order_name
    AND status <> 'ยกเลิก'
    AND status <> 'จัดส่งแล้ว';
  IF v_pending > 0 THEN
    RAISE EXCEPTION 'Cannot close work order: % bill(s) are not shipped', v_pending;
  END IF;

  UPDATE public.or_work_orders SET status = 'จัดส่งแล้ว'
  WHERE work_order_name = p_work_order_name;
  GET DIAGNOSTICS v_header_updated = ROW_COUNT;
  IF v_header_updated = 0 THEN RAISE EXCEPTION 'Work order header not found'; END IF;

  PERFORM public.merge_plan_tracks_by_name(
    p_work_order_name, 'PACK',
    jsonb_build_object(
      'เริ่มแพ็ค', jsonb_build_object('start_if_null', to_jsonb(v_now), 'end', to_jsonb(v_now)),
      'เสร็จแล้ว', jsonb_build_object('start_if_null', to_jsonb(v_now), 'end', to_jsonb(v_now))
    )
  );
  RETURN jsonb_build_object('success', true, 'shipped_count', v_updated, 'closed_at', v_now);
END;
$$;

GRANT EXECUTE ON FUNCTION public.pk_finalize_work_order(TEXT, UUID[], TEXT) TO authenticated;
