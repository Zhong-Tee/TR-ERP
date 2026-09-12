-- Make packing finalization/reset atomic and auditable.
BEGIN;

CREATE TABLE IF NOT EXISTS public.pk_packing_reset_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.or_orders(id) ON DELETE CASCADE,
  work_order_name TEXT,
  reset_type TEXT NOT NULL CHECK (reset_type IN ('rescan', 'cancel_shipment')),
  reason TEXT NOT NULL,
  previous_status TEXT,
  previous_packing_meta JSONB,
  previous_shipped_by TEXT,
  previous_shipped_time TIMESTAMPTZ,
  reset_by TEXT NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pk_packing_reset_logs_order_time
  ON public.pk_packing_reset_logs(order_id, reset_at DESC);

ALTER TABLE public.pk_packing_reset_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Packing users can view reset logs" ON public.pk_packing_reset_logs
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.us_users WHERE id = auth.uid()
      AND role IN ('superadmin', 'admin', 'packing_staff', 'production')
  ));

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
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role NOT IN ('packing_staff', 'production', 'sales-tr') THEN
    RAISE EXCEPTION 'Not authorized to finalize packing';
  END IF;
  IF NULLIF(trim(COALESCE(p_work_order_name, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Work order name is required';
  END IF;

  -- Serialize finalization/reset for the same work order.
  PERFORM pg_advisory_xact_lock(hashtextextended('PACK:' || p_work_order_name, 0));

  IF COALESCE(array_length(p_order_ids, 1), 0) > 0 THEN
    IF EXISTS (
      SELECT 1 FROM unnest(p_order_ids) requested(id)
      LEFT JOIN public.or_orders o ON o.id = requested.id
      WHERE o.id IS NULL OR o.work_order_name IS DISTINCT FROM p_work_order_name OR o.status = 'ยกเลิก'
    ) THEN
      RAISE EXCEPTION 'One or more bills do not belong to this active work order';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.or_orders o
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(GREATEST(i.quantity, 1)), 0)::INTEGER AS expected
        FROM public.or_order_items i WHERE i.order_id = o.id
      ) units ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::INTEGER AS scanned
        FROM public.pk_packing_unit_scans s WHERE s.order_id = o.id
      ) scans ON true
      WHERE o.id = ANY(p_order_ids)
        AND COALESCE(o.channel_code, '') <> 'OFFICE'
        AND (
          NULLIF(trim(COALESCE(o.tracking_number, '')), '') IS NULL
          OR units.expected <= 0
          OR scans.scanned < units.expected
        )
    ) THEN
      RAISE EXCEPTION 'Cannot ship: parcel tracking or item scans are incomplete';
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

CREATE OR REPLACE FUNCTION public.pk_reset_order_packing(
  p_order_id UUID,
  p_reason TEXT,
  p_reset_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT;
  v_order public.or_orders;
  v_is_shipped BOOLEAN;
  v_tag JSONB;
  v_reset_type TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role NOT IN ('superadmin', 'admin', 'packing_staff', 'production', 'sales-tr') THEN
    RAISE EXCEPTION 'Not authorized to reset packing';
  END IF;

  SELECT * INTO v_order FROM public.or_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('PACK:' || COALESCE(v_order.work_order_name, ''), 0));

  v_is_shipped := v_order.status = 'จัดส่งแล้ว';
  IF v_is_shipped AND v_role NOT IN ('superadmin', 'admin') THEN
    RAISE EXCEPTION 'Only superadmin/admin can cancel a shipped order';
  END IF;
  IF v_is_shipped AND NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A reason is required to cancel shipment';
  END IF;
  v_reset_type := CASE WHEN v_is_shipped THEN 'cancel_shipment' ELSE 'rescan' END;

  INSERT INTO public.pk_packing_reset_logs(
    order_id, work_order_name, reset_type, reason, previous_status,
    previous_packing_meta, previous_shipped_by, previous_shipped_time, reset_by
  ) VALUES (
    v_order.id, v_order.work_order_name, v_reset_type,
    COALESCE(NULLIF(trim(p_reason), ''), 'เริ่มแพ็คใหม่'), v_order.status,
    v_order.packing_meta, v_order.shipped_by, v_order.shipped_time, p_reset_by
  );

  DELETE FROM public.pk_packing_unit_scans WHERE order_id = v_order.id;

  -- Keep the daily tag for traceability; clear only scan-state metadata.
  v_tag := CASE
    WHEN v_order.packing_meta ? 'dailyPackingTag'
      THEN jsonb_build_object('dailyPackingTag', v_order.packing_meta->'dailyPackingTag')
    ELSE NULL
  END;
  UPDATE public.or_orders
  SET status = CASE WHEN v_is_shipped THEN 'ใบงานกำลังผลิต' ELSE status END,
      packing_meta = v_tag,
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
    'reset_type', v_reset_type,
    'work_order_name', v_order.work_order_name,
    'packing_tag', v_order.packing_meta->'dailyPackingTag'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.pk_finalize_work_order(TEXT, UUID[], TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pk_reset_order_packing(UUID, TEXT, TEXT) TO authenticated;

COMMIT;
