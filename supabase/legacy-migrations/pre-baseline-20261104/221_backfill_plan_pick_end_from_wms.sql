-- ย้อนประทับเวลาเสร็จแผนก "เบิก" ใน plan_jobs จาก WMS
-- กรณีใบงานเดิมที่ตรวจครบแล้ว (รวมคืนคลัง) แต่ไม่เคยเรียก ensurePlanDeptEnd เพราะบั๊ก allCorrect
--
-- ใช้งาน:
--   SELECT rpc_backfill_plan_pick_end_from_wms(NULL);              -- ทุกใบงานที่มี plan_jobs + ตรวจครบ
--   SELECT rpc_backfill_plan_pick_end_from_wms('uuid-ใบงาน');      -- ใบเดียว
--   SELECT rpc_backfill_plan_pick_end_from_wms(NULL, true);        -- บังคับเขียนทับ end ที่มีอยู่แล้ว

CREATE OR REPLACE FUNCTION rpc_backfill_plan_pick_end_from_wms(
  p_work_order_id UUID DEFAULT NULL,
  p_force BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_wid UUID;
  v_ts TIMESTAMPTZ;
  v_patch JSONB;
  v_berk JSONB;
  v_has_pick_end BOOLEAN;
  v_has_deliver_end BOOLEAN;
  v_review_count INT;
  v_bad_count INT;
  v_updated JSONB := '[]'::jsonb;
  v_skipped JSONB := '[]'::jsonb;
  v_n_updated INT := 0;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'store', 'manager', 'production') THEN
    RETURN jsonb_build_object('success', false, 'error', 'ไม่มีสิทธิ์ใช้ฟังก์ชันนี้');
  END IF;

  IF p_work_order_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM plan_jobs WHERE work_order_id = p_work_order_id) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'ไม่พบ plan_jobs สำหรับ work_order_id นี้'
      );
    END IF;
  END IF;

  FOR v_wid IN
    SELECT DISTINCT pj.work_order_id
    FROM plan_jobs pj
    WHERE pj.work_order_id IS NOT NULL
      AND (p_work_order_id IS NULL OR pj.work_order_id = p_work_order_id)
  LOOP
    SELECT COUNT(*) INTO v_review_count
    FROM wms_orders w
    WHERE w.work_order_id = v_wid
      AND (
        (w.fulfillment_mode = 'warehouse_pick' AND w.status <> 'cancelled')
        OR (w.fulfillment_mode = 'warehouse_pick' AND w.status = 'cancelled' AND w.stock_action = 'recalled')
        OR (w.fulfillment_mode IS NULL AND w.status <> 'cancelled')
        OR (w.fulfillment_mode IS NULL AND w.status = 'cancelled' AND w.stock_action = 'recalled')
      );

    IF v_review_count = 0 THEN
      v_skipped := v_skipped || jsonb_build_object('work_order_id', v_wid, 'reason', 'no_wms_review_rows');
      CONTINUE;
    END IF;

    SELECT COUNT(*) INTO v_bad_count
    FROM wms_orders w
    WHERE w.work_order_id = v_wid
      AND (
        (w.fulfillment_mode = 'warehouse_pick' AND w.status <> 'cancelled')
        OR (w.fulfillment_mode = 'warehouse_pick' AND w.status = 'cancelled' AND w.stock_action = 'recalled')
        OR (w.fulfillment_mode IS NULL AND w.status <> 'cancelled')
        OR (w.fulfillment_mode IS NULL AND w.status = 'cancelled' AND w.stock_action = 'recalled')
      )
      AND w.status NOT IN ('correct', 'wrong', 'not_find', 'out_of_stock', 'returned');

    IF v_bad_count > 0 THEN
      v_skipped := v_skipped || jsonb_build_object('work_order_id', v_wid, 'reason', 'inspect_not_complete');
      CONTINUE;
    END IF;

    SELECT tracks -> 'เบิก' INTO v_berk
    FROM plan_jobs
    WHERE work_order_id = v_wid
    ORDER BY date DESC
    LIMIT 1;

    v_has_pick_end :=
      jsonb_typeof(COALESCE(v_berk -> 'หยิบของ' -> 'end', 'null'::jsonb)) = 'string';
    v_has_deliver_end :=
      jsonb_typeof(COALESCE(v_berk -> 'ส่งมอบ' -> 'end', 'null'::jsonb)) = 'string';

    IF NOT p_force AND v_has_pick_end AND v_has_deliver_end THEN
      v_skipped := v_skipped || jsonb_build_object('work_order_id', v_wid, 'reason', 'already_stamped');
      CONTINUE;
    END IF;

    SELECT MAX(w.end_time) INTO v_ts
    FROM wms_orders w
    WHERE w.work_order_id = v_wid
      AND (w.fulfillment_mode = 'warehouse_pick' OR w.fulfillment_mode IS NULL);

    IF v_ts IS NULL THEN
      SELECT MAX(w.updated_at) INTO v_ts
      FROM wms_orders w
      WHERE w.work_order_id = v_wid
        AND (
          (w.fulfillment_mode = 'warehouse_pick' AND w.status <> 'cancelled')
          OR (w.fulfillment_mode = 'warehouse_pick' AND w.status = 'cancelled' AND w.stock_action = 'recalled')
          OR (w.fulfillment_mode IS NULL AND w.status <> 'cancelled')
          OR (w.fulfillment_mode IS NULL AND w.status = 'cancelled' AND w.stock_action = 'recalled')
        )
        AND w.status IN ('correct', 'wrong', 'not_find', 'out_of_stock', 'returned');
    END IF;

    IF v_ts IS NULL THEN
      v_ts := NOW();
    END IF;

    v_patch := jsonb_build_object(
      'หยิบของ', jsonb_build_object('start_if_null', to_jsonb(v_ts), 'end', to_jsonb(v_ts)),
      'ส่งมอบ', jsonb_build_object('start_if_null', to_jsonb(v_ts), 'end', to_jsonb(v_ts))
    );

    PERFORM merge_plan_tracks_by_work_order_id(v_wid, 'เบิก', v_patch);

    v_updated := v_updated || to_jsonb(v_wid);
    v_n_updated := v_n_updated + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'updated_count', v_n_updated,
    'updated_work_order_ids', v_updated,
    'skipped', v_skipped
  );
END;
$$;

REVOKE ALL ON FUNCTION rpc_backfill_plan_pick_end_from_wms(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_backfill_plan_pick_end_from_wms(UUID, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION rpc_backfill_plan_pick_end_from_wms(UUID, BOOLEAN) IS
  'ย้อนประทับเวลาเสร็จแผนก เบิก (หยิบของ/ส่งมอบ) เมื่อ WMS ตรวจครบแล้ว — แก้ใบงานเดิมที่ไม่ถูก stamp จากบั๊ก allCorrect';
