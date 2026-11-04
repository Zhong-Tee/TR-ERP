-- SHOPP is SHOP PICKUP: the customer collects the order at the shop, so a
-- parcel tracking number must not be required. Product-unit scan validation
-- remains unchanged.

CREATE OR REPLACE FUNCTION public.normalize_shop_pickup_tracking_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF upper(btrim(COALESCE(NEW.channel_code, ''))) = 'SHOPP' THEN
    NEW.tracking_number := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Run before the existing duplicate-tracking guard (trigger names execute in
-- alphabetical order), so SHOPP never reaches that guard with a parcel number.
DROP TRIGGER IF EXISTS trg_00_normalize_shop_pickup_tracking ON public.or_orders;
CREATE TRIGGER trg_00_normalize_shop_pickup_tracking
BEFORE INSERT OR UPDATE OF channel_code, tracking_number ON public.or_orders
FOR EACH ROW
EXECUTE FUNCTION public.normalize_shop_pickup_tracking_number();

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
      COALESCE(NULLIF(trim(o.channel_code), ''), '') AS channel_code,
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
        (
          COALESCE(o.channel_code, '') <> 'SHOPP'
          AND NULLIF(trim(COALESCE(o.tracking_number, '')), '') IS NULL
        )
        OR units.expected <= 0
        OR scans.scanned < units.expected
      )
    ORDER BY o.bill_no NULLS LAST, o.id
    LIMIT 1;

    IF FOUND THEN
      IF v_incomplete.tracking_number IS NULL AND v_incomplete.channel_code <> 'SHOPP' THEN
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

  UPDATE public.or_work_orders
  SET status = 'จัดส่งแล้ว'
  WHERE work_order_name = p_work_order_name;
  GET DIAGNOSTICS v_header_updated = ROW_COUNT;
  IF v_header_updated = 0 THEN RAISE EXCEPTION 'Work order header not found'; END IF;

  PERFORM public.merge_plan_tracks_by_name(
    p_work_order_name,
    'PACK',
    jsonb_build_object(
      'เริ่มแพ็ค', jsonb_build_object('start_if_null', to_jsonb(v_now), 'end', to_jsonb(v_now)),
      'เสร็จแล้ว', jsonb_build_object('start_if_null', to_jsonb(v_now), 'end', to_jsonb(v_now))
    )
  );

  RETURN jsonb_build_object('success', true, 'shipped_count', v_updated, 'closed_at', v_now);
END;
$$;

GRANT EXECUTE ON FUNCTION public.pk_finalize_work_order(TEXT, UUID[], TEXT) TO authenticated;

COMMENT ON FUNCTION public.pk_finalize_work_order(TEXT, UUID[], TEXT) IS
'Finalize packing atomically; SHOPP skips tracking validation but still requires all active product units to be scanned.';
