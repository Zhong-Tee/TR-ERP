-- Keep Plan department "เบิก" completion in sync with WMS review completion.
--
-- The old browser flow updated wms_orders first and called Plan RPC afterwards.
-- A network/RPC failure between those requests left WMS at "ตรวจเสร็จแล้ว"
-- while plan_jobs.tracks still had no actual end time.  This migration moves
-- the sync to a database trigger and also repairs existing completed jobs.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_sync_plan_pick_end_from_wms(
  p_work_order_id UUID,
  p_completed_at TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total INT;
  v_incomplete INT;
  v_job_id TEXT;
  v_job_name TEXT;
  v_tracks JSONB;
  v_dept JSONB;
  v_patch JSONB := '{}'::jsonb;
  v_ts TIMESTAMPTZ;
BEGIN
  IF p_work_order_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_work_order_id');
  END IF;

  -- Only rows visible in the WMS review flow participate. Cancelled/recalled
  -- rows remain incomplete until warehouse staff physically return them.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE w.status NOT IN ('correct', 'wrong', 'not_find', 'out_of_stock', 'returned')
    )
  INTO v_total, v_incomplete
  FROM public.wms_orders w
  WHERE w.work_order_id = p_work_order_id
    AND (
      (w.fulfillment_mode = 'warehouse_pick' AND w.status <> 'cancelled')
      OR (w.fulfillment_mode = 'warehouse_pick' AND w.status = 'cancelled' AND w.stock_action = 'recalled')
      OR (w.fulfillment_mode IS NULL AND w.status <> 'cancelled')
      OR (w.fulfillment_mode IS NULL AND w.status = 'cancelled' AND w.stock_action = 'recalled')
    );

  IF v_total = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_wms_review_rows');
  END IF;

  IF v_incomplete > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'inspect_not_complete',
      'incomplete_count', v_incomplete
    );
  END IF;

  -- Prefer the UUID relation. The name fallback repairs legacy rows created
  -- before work_order_id was added to plan_jobs.
  SELECT pj.id, pj.name, COALESCE(pj.tracks, '{}'::jsonb)
  INTO v_job_id, v_job_name, v_tracks
  FROM public.plan_jobs pj
  WHERE pj.work_order_id = p_work_order_id
  ORDER BY pj.date DESC, pj.order_index DESC
  LIMIT 1;

  IF v_job_id IS NULL THEN
    SELECT wo.work_order_name INTO v_job_name
    FROM public.or_work_orders wo
    WHERE wo.id = p_work_order_id;

    SELECT pj.id, COALESCE(pj.tracks, '{}'::jsonb)
    INTO v_job_id, v_tracks
    FROM public.plan_jobs pj
    WHERE pj.name = v_job_name
    ORDER BY pj.date DESC, pj.order_index DESC
    LIMIT 1;
  END IF;

  IF v_job_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'plan_job_not_found');
  END IF;

  v_dept := COALESCE(v_tracks -> 'เบิก', '{}'::jsonb);

  -- Preserve an existing actual end. Fill only the missing process(es).
  IF (v_dept -> 'หยิบของ' ->> 'end') IS NULL THEN
    v_patch := v_patch || jsonb_build_object(
      'หยิบของ', jsonb_build_object(
        'start_if_null', to_jsonb(COALESCE(p_completed_at, NOW())),
        'end', to_jsonb(COALESCE(p_completed_at, NOW()))
      )
    );
  END IF;

  IF (v_dept -> 'ส่งมอบ' ->> 'end') IS NULL THEN
    v_patch := v_patch || jsonb_build_object(
      'ส่งมอบ', jsonb_build_object(
        'start_if_null', to_jsonb(COALESCE(p_completed_at, NOW())),
        'end', to_jsonb(COALESCE(p_completed_at, NOW()))
      )
    );
  END IF;

  IF v_patch = '{}'::jsonb THEN
    RETURN jsonb_build_object(
      'success', true,
      'synced', false,
      'reason', 'already_stamped',
      'plan_job_id', v_job_id
    );
  END IF;

  -- For historical repair, use the WMS completion time when available.
  IF p_completed_at IS NULL THEN
    SELECT MAX(w.end_time) INTO v_ts
    FROM public.wms_orders w
    WHERE w.work_order_id = p_work_order_id
      AND (w.fulfillment_mode = 'warehouse_pick' OR w.fulfillment_mode IS NULL);

    v_ts := COALESCE(v_ts, NOW());
    v_patch := (
      SELECT jsonb_object_agg(
        entry.key,
        jsonb_set(
          jsonb_set(entry.value, '{start_if_null}', to_jsonb(v_ts), true),
          '{end}', to_jsonb(v_ts), true
        )
      )
      FROM jsonb_each(v_patch) AS entry
    );
  END IF;

  PERFORM public.merge_plan_tracks(v_job_id, 'เบิก', v_patch);

  RETURN jsonb_build_object(
    'success', true,
    'synced', true,
    'plan_job_id', v_job_id,
    'completed_at', COALESCE(p_completed_at, v_ts)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_sync_plan_pick_end_from_wms(UUID, TIMESTAMPTZ) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.rpc_sync_plan_pick_end_from_wms(
  p_work_order_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'กรุณาเข้าสู่ระบบ';
  END IF;

  RETURN public.fn_sync_plan_pick_end_from_wms(p_work_order_id, NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_sync_plan_pick_end_from_wms(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_sync_plan_pick_end_from_wms(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.trg_sync_plan_pick_end_after_wms_review()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.work_order_id IS NOT NULL
     AND NEW.status IN ('correct', 'wrong', 'not_find', 'out_of_stock', 'returned')
     AND (
       NEW.fulfillment_mode = 'warehouse_pick'
       OR NEW.fulfillment_mode IS NULL
     ) THEN
    PERFORM public.fn_sync_plan_pick_end_from_wms(NEW.work_order_id, NOW());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_plan_pick_end_after_wms_review ON public.wms_orders;
CREATE TRIGGER trg_sync_plan_pick_end_after_wms_review
AFTER UPDATE OF status, stock_action ON public.wms_orders
FOR EACH ROW
WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  OR OLD.stock_action IS DISTINCT FROM NEW.stock_action
)
EXECUTE FUNCTION public.trg_sync_plan_pick_end_after_wms_review();

-- Repair all existing work orders that have already completed WMS review.
-- This includes SPTR-210969-R1 without hard-coding an environment-specific UUID.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT w.work_order_id
    FROM public.wms_orders w
    WHERE w.work_order_id IS NOT NULL
  LOOP
    PERFORM public.fn_sync_plan_pick_end_from_wms(r.work_order_id, NULL);
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.fn_sync_plan_pick_end_from_wms(UUID, TIMESTAMPTZ) IS
  'ปิดเวลา Plan แผนกเบิกเมื่อรายการ WMS ของใบงานตรวจครบ และใช้ซ่อมข้อมูลเดิมได้';

COMMIT;
