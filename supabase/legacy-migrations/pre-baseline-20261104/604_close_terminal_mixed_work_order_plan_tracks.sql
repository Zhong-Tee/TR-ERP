-- Close open QC/PACK Plan tracks when a mixed work order has no fulfillment
-- work left: remaining bills are shipped and the other bills/items cancelled.
-- This is different from a fully-cancelled work order, which stays voided.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_close_terminal_mixed_work_order_tracks(
  p_work_order_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wo public.or_work_orders%ROWTYPE;
  v_open_orders INTEGER := 0;
  v_shipped_orders INTEGER := 0;
  v_plan_job_id TEXT;
  v_tracks JSONB := '{}'::JSONB;
  v_qc_start TIMESTAMPTZ;
  v_qc_end TIMESTAMPTZ;
  v_pack_start TIMESTAMPTZ;
  v_pack_end TIMESTAMPTZ;
  v_qc_patch JSONB;
  v_pack_patch JSONB;
BEGIN
  IF p_work_order_id IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'reason', 'missing_work_order_id');
  END IF;

  SELECT * INTO v_wo
  FROM public.or_work_orders
  WHERE id = p_work_order_id;
  IF v_wo.id IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'reason', 'work_order_not_found');
  END IF;

  SELECT
    COUNT(*) FILTER (
      WHERE COALESCE(o.status, '') NOT IN ('ยกเลิก', 'จัดส่งแล้ว')
        AND EXISTS (
          SELECT 1 FROM public.or_order_items oi
          WHERE oi.order_id = o.id
            AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action, '')), '') IS NULL
        )
    )::INTEGER,
    COUNT(*) FILTER (WHERE COALESCE(o.status, '') = 'จัดส่งแล้ว')::INTEGER,
    MAX(COALESCE(o.shipped_time, o.updated_at)) FILTER (WHERE COALESCE(o.status, '') = 'จัดส่งแล้ว')
  INTO v_open_orders, v_shipped_orders, v_pack_end
  FROM public.or_orders o
  WHERE o.work_order_id = v_wo.id
     OR (o.work_order_id IS NULL AND BTRIM(COALESCE(o.work_order_name, '')) = BTRIM(v_wo.work_order_name));

  IF v_open_orders > 0 THEN
    RETURN jsonb_build_object('success', TRUE, 'closed', FALSE, 'reason', 'active_orders_remain');
  END IF;
  IF v_shipped_orders = 0 THEN
    RETURN jsonb_build_object('success', TRUE, 'closed', FALSE, 'reason', 'fully_cancelled_or_no_shipped_order');
  END IF;

  SELECT pj.id, COALESCE(pj.tracks, '{}'::JSONB)
  INTO v_plan_job_id, v_tracks
  FROM public.plan_jobs pj
  WHERE pj.work_order_id = v_wo.id
     OR (pj.work_order_id IS NULL AND pj.name = v_wo.work_order_name)
  ORDER BY pj.date DESC, pj.order_index DESC
  LIMIT 1;
  IF v_plan_job_id IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'reason', 'plan_job_not_found');
  END IF;

  v_qc_start := NULLIF(v_tracks -> 'QC' -> 'เริ่มQC' ->> 'start', '')::TIMESTAMPTZ;
  v_pack_start := NULLIF(v_tracks -> 'PACK' -> 'เริ่มแพ็ค' ->> 'start', '')::TIMESTAMPTZ;

  SELECT MAX(q.end_time)
  INTO v_qc_end
  FROM public.qc_sessions q
  WHERE q.filename = 'WO-' || v_wo.work_order_name
    AND q.end_time IS NOT NULL;

  -- Starting PACK proves the active QC work was handed off. Prefer a real
  -- closed QC session, then PACK start, then the latest shipment timestamp.
  v_qc_end := COALESCE(v_qc_end, v_pack_start, v_pack_end);
  IF v_qc_start IS NOT NULL AND v_qc_end IS NOT NULL THEN
    v_qc_end := GREATEST(v_qc_start, v_qc_end);
  END IF;
  IF v_pack_start IS NOT NULL AND v_pack_end IS NOT NULL THEN
    v_pack_end := GREATEST(v_pack_start, v_pack_end);
  END IF;

  IF v_qc_start IS NOT NULL
     AND NULLIF(v_tracks -> 'QC' -> 'เสร็จแล้ว' ->> 'end', '') IS NULL
     AND v_qc_end IS NOT NULL THEN
    v_qc_patch := jsonb_build_object(
      'เริ่มQC', jsonb_build_object('start_if_null', to_jsonb(v_qc_start), 'end', to_jsonb(v_qc_end)),
      'เสร็จแล้ว', jsonb_build_object('start_if_null', to_jsonb(v_qc_start), 'end', to_jsonb(v_qc_end))
    );
    PERFORM public.merge_plan_tracks(v_plan_job_id, 'QC', v_qc_patch);
  END IF;

  -- Reload after the QC merge so the PACK merge cannot overwrite it.
  SELECT COALESCE(tracks, '{}'::JSONB) INTO v_tracks
  FROM public.plan_jobs WHERE id = v_plan_job_id;

  IF v_pack_start IS NOT NULL
     AND NULLIF(v_tracks -> 'PACK' -> 'เสร็จแล้ว' ->> 'end', '') IS NULL
     AND v_pack_end IS NOT NULL THEN
    v_pack_patch := jsonb_build_object(
      'เริ่มแพ็ค', jsonb_build_object('start_if_null', to_jsonb(v_pack_start), 'end', to_jsonb(v_pack_end)),
      'เสร็จแล้ว', jsonb_build_object('start_if_null', to_jsonb(v_pack_start), 'end', to_jsonb(v_pack_end))
    );
    PERFORM public.merge_plan_tracks(v_plan_job_id, 'PACK', v_pack_patch);
  END IF;

  RETURN jsonb_build_object(
    'success', TRUE,
    'closed', TRUE,
    'plan_job_id', v_plan_job_id,
    'qc_end', v_qc_end,
    'pack_end', v_pack_end,
    'shipped_orders', v_shipped_orders
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_close_terminal_mixed_work_order_tracks(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_close_terminal_mixed_work_order_tracks(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.trg_close_terminal_mixed_work_order_tracks()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.fn_close_terminal_mixed_work_order_tracks(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_close_terminal_mixed_work_order_tracks ON public.or_work_orders;
CREATE TRIGGER trg_close_terminal_mixed_work_order_tracks
AFTER UPDATE OF status, cancellation_state, order_count ON public.or_work_orders
FOR EACH ROW
EXECUTE FUNCTION public.trg_close_terminal_mixed_work_order_tracks();

-- Backfill existing terminal mixed work orders, including the reported case.
DO $$
DECLARE
  v_id UUID;
BEGIN
  FOR v_id IN
    SELECT DISTINCT wo.id
    FROM public.or_work_orders wo
    JOIN public.or_orders o
      ON o.work_order_id = wo.id
      OR (o.work_order_id IS NULL AND BTRIM(COALESCE(o.work_order_name, '')) = BTRIM(wo.work_order_name))
    WHERE EXISTS (
      SELECT 1 FROM public.or_orders shipped
      WHERE (shipped.work_order_id = wo.id
        OR (shipped.work_order_id IS NULL AND BTRIM(COALESCE(shipped.work_order_name, '')) = BTRIM(wo.work_order_name)))
        AND shipped.status = 'จัดส่งแล้ว'
    )
  LOOP
    PERFORM public.fn_close_terminal_mixed_work_order_tracks(v_id);
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.fn_close_terminal_mixed_work_order_tracks(UUID) IS
  'Closes missing QC/PACK Plan end tracks only when no active fulfillment order remains and at least one bill was shipped.';

NOTIFY pgrst, 'reload schema';

COMMIT;
