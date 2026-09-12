-- ═══════════════════════════════════════════
-- Migration 120: Fix picker_id → assigned_to in rpc_execute_bill_cancellation
-- wms_orders ใช้ assigned_to ไม่ใช่ picker_id
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_execute_bill_cancellation(p_amendment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_amendment    RECORD;
  v_order        RECORD;
  v_wms          RECORD;
  v_cancelled_wms INT := 0;
  v_snapshot_order JSONB;
  v_new_rev      INT;
BEGIN
  SELECT * INTO v_amendment FROM or_order_amendments WHERE id = p_amendment_id;
  IF v_amendment.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขอยกเลิก'; END IF;

  SELECT * INTO v_order FROM or_orders WHERE id = v_amendment.order_id;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'ไม่พบออเดอร์'; END IF;

  -- เก็บ snapshot ก่อนยกเลิก
  SELECT row_to_json(o)::jsonb INTO v_snapshot_order
  FROM or_orders o WHERE o.id = v_amendment.order_id;

  -- UPDATE wms_orders เป็น cancelled (ไม่ DELETE, ไม่คืนสต๊อก)
  IF v_order.work_order_name IS NOT NULL AND v_order.work_order_name <> '' THEN
    FOR v_wms IN
      SELECT id, assigned_to
      FROM wms_orders
      WHERE order_id = v_order.work_order_name
        AND status NOT IN ('cancelled')
    LOOP
      UPDATE wms_orders SET status = 'cancelled' WHERE id = v_wms.id;
      v_cancelled_wms := v_cancelled_wms + 1;

      -- แจ้งเตือนพนักงานจัดสินค้า (wms_notifications ใช้คอลัมน์ picker_id)
      IF v_wms.assigned_to IS NOT NULL THEN
        INSERT INTO wms_notifications (type, order_id, picker_id, status, is_read)
        VALUES ('ยกเลิกบิล', v_order.work_order_name, v_wms.assigned_to, 'unread', false);
      END IF;
    END LOOP;
  END IF;

  -- อัปเดตสถานะออเดอร์เป็นยกเลิก (คง work_order_name ไว้)
  UPDATE or_orders
  SET status = 'ยกเลิก', updated_at = NOW()
  WHERE id = v_amendment.order_id;

  -- สร้าง revision
  v_new_rev := COALESCE(v_order.revision_no, 0) + 1;

  INSERT INTO or_order_revisions (
    order_id, revision_no, change_source, change_source_id,
    snapshot_order, snapshot_items, created_by
  ) VALUES (
    v_amendment.order_id, v_new_rev, 'amendment', p_amendment_id,
    v_snapshot_order,
    (SELECT COALESCE(jsonb_agg(row_to_json(oi)::jsonb), '[]'::jsonb)
     FROM or_order_items oi WHERE oi.order_id = v_amendment.order_id),
    (SELECT COALESCE(username, email) FROM us_users WHERE id = v_amendment.approved_by)
  );

  UPDATE or_orders SET revision_no = v_new_rev WHERE id = v_amendment.order_id;

  -- อัปเดตสถานะ amendment
  UPDATE or_order_amendments
  SET status = 'executed', executed_at = NOW()
  WHERE id = p_amendment_id;

  RETURN jsonb_build_object(
    'success', true,
    'amendment_no', v_amendment.amendment_no,
    'bill_no', v_order.bill_no,
    'cancelled_wms_count', v_cancelled_wms,
    'revision_no', v_new_rev
  );
END;
$$;
