-- ============================================
-- 119: Cancel & Recreate Workflow
-- ปรับระบบจาก "ขอแก้ไข + Credit Note" เป็น "ยกเลิกแล้วสร้างใหม่"
-- ============================================

-- ═══════════════════════════════════════════
-- 1. เพิ่มคอลัมน์ stock_action บน wms_orders
-- ═══════════════════════════════════════════

ALTER TABLE wms_orders ADD COLUMN IF NOT EXISTS stock_action TEXT
  CHECK (stock_action IN ('recalled', 'waste'));

-- ═══════════════════════════════════════════
-- 2. Safety guard: ให้ trigger ข้ามสถานะ cancelled
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION inv_deduct_stock_on_wms_picked()
RETURNS TRIGGER AS $$
DECLARE
  v_product_id  UUID;
  v_movement_id UUID;
BEGIN
  -- guard: ข้ามสถานะ cancelled ไม่ทำอะไรกับสต๊อก
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;

  SELECT id INTO v_product_id
  FROM pr_products
  WHERE product_code = NEW.product_code
  LIMIT 1;

  IF v_product_id IS NULL THEN RETURN NEW; END IF;

  -- Reserve: status → picked
  IF NEW.status = 'picked'
     AND (OLD.status IS NULL OR OLD.status NOT IN ('picked', 'correct'))
  THEN
    UPDATE inv_stock_balances
      SET reserved = COALESCE(reserved, 0) + NEW.qty
      WHERE product_id = v_product_id;
    IF NOT FOUND THEN
      INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES (v_product_id, 0, NEW.qty, 0);
    END IF;
  END IF;

  -- Deduct: status → correct
  IF NEW.status = 'correct'
     AND (OLD.status IS NULL OR OLD.status <> 'correct')
  THEN
    UPDATE inv_stock_balances
      SET on_hand  = COALESCE(on_hand, 0) - NEW.qty,
          reserved = GREATEST(COALESCE(reserved, 0) - NEW.qty, 0)
      WHERE product_id = v_product_id;
    IF NOT FOUND THEN
      INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES (v_product_id, -NEW.qty, 0, 0);
    END IF;

    INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note)
    VALUES (v_product_id, 'pick', -NEW.qty, 'wms_orders', NEW.id, 'ตัดสต๊อคเมื่อตรวจสอบถูกต้อง')
    RETURNING id INTO v_movement_id;

    PERFORM fn_consume_stock_fifo(v_product_id, NEW.qty, v_movement_id);
    PERFORM fn_recalc_product_landed_cost(v_product_id);
  END IF;

  -- Out of stock: ปลด reserve
  IF NEW.status = 'out_of_stock'
     AND OLD.status = 'picked'
  THEN
    UPDATE inv_stock_balances
      SET reserved = GREATEST(COALESCE(reserved, 0) - NEW.qty, 0)
      WHERE product_id = v_product_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════
-- 3. rpc_execute_bill_cancellation — ยกเลิกบิล (แทน rpc_cancel_wms_for_amendment)
-- ไม่คืนสต๊อกอัตโนมัติ รอหัวหน้าแผนกตัดสินใจ
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

      -- แจ้งเตือนพนักงานจัดสินค้า
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

-- ═══════════════════════════════════════════
-- 4. แก้ rpc_approve_amendment — เรียก rpc_execute_bill_cancellation แทน
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_approve_amendment(
  p_amendment_id UUID,
  p_approver_id  UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_role      TEXT;
  v_amendment RECORD;
  v_result    JSONB;
BEGIN
  -- ตรวจ role
  SELECT role INTO v_role FROM us_users WHERE id = p_approver_id;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติ — ต้องเป็น superadmin หรือ admin เท่านั้น (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT * INTO v_amendment FROM or_order_amendments WHERE id = p_amendment_id;
  IF v_amendment.id IS NULL THEN RAISE EXCEPTION 'ไม่พบใบขอยกเลิก'; END IF;
  IF v_amendment.status <> 'pending' THEN
    RAISE EXCEPTION 'ใบขอยกเลิกนี้ไม่อยู่ในสถานะรออนุมัติ (status: %)', v_amendment.status;
  END IF;

  -- อัปเดต approved_by ก่อนเรียก execute
  UPDATE or_order_amendments
  SET approved_by = p_approver_id, approved_at = NOW(), status = 'approved'
  WHERE id = p_amendment_id;

  -- เรียกยกเลิกบิล
  v_result := rpc_execute_bill_cancellation(p_amendment_id);

  RETURN v_result;
END;
$$;

-- ═══════════════════════════════════════════
-- 5. แก้ rpc_check_order_edit_eligibility — ลบ credit note, เปลี่ยนข้อความ
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_check_order_edit_eligibility(p_order_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_order        RECORD;
  v_wms_count    INT := 0;
  v_wms_picked   INT := 0;
  v_wms_correct  INT := 0;
  v_has_wms      BOOLEAN := false;
  v_pending_amend INT := 0;
BEGIN
  SELECT id, status, work_order_name, bill_no, is_locked
  INTO v_order
  FROM or_orders
  WHERE id = p_order_id;

  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('error', 'ไม่พบออเดอร์');
  END IF;

  IF v_order.is_locked THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'needs_amendment', false,
      'needs_credit_note', false,
      'is_locked', true,
      'reason', 'บิลนี้ถูกล็อกแล้ว ไม่สามารถแก้ไขได้'
    );
  END IF;

  -- ตรวจ pending amendment
  SELECT COUNT(*) INTO v_pending_amend
  FROM or_order_amendments
  WHERE order_id = p_order_id AND status = 'pending';

  IF v_pending_amend > 0 THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'needs_amendment', false,
      'needs_credit_note', false,
      'has_pending_amendment', true,
      'reason', 'บิลนี้มีคำขอยกเลิกรออนุมัติอยู่แล้ว'
    );
  END IF;

  -- ตรวจ WMS activity
  IF v_order.work_order_name IS NOT NULL AND v_order.work_order_name <> '' THEN
    SELECT COUNT(*),
           COUNT(*) FILTER (WHERE status = 'picked'),
           COUNT(*) FILTER (WHERE status = 'correct')
    INTO v_wms_count, v_wms_picked, v_wms_correct
    FROM wms_orders
    WHERE order_id = v_order.work_order_name
      AND status NOT IN ('cancelled');

    v_has_wms := v_wms_count > 0;
  END IF;

  -- จัดส่งแล้ว → ใช้ระบบเคลม (ไม่ใช่ credit note)
  IF v_order.status = 'จัดส่งแล้ว' THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'needs_amendment', false,
      'needs_credit_note', false,
      'is_shipped', true,
      'has_wms_activity', v_has_wms,
      'order_status', v_order.status,
      'reason', 'บิลจัดส่งแล้ว — กรุณาใช้ระบบเคลมแทน'
    );
  END IF;

  -- ยกเลิกแล้ว → ไม่ทำอะไร
  IF v_order.status = 'ยกเลิก' THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'needs_amendment', false,
      'needs_credit_note', false,
      'reason', 'บิลถูกยกเลิกแล้ว ไม่สามารถแก้ไขได้'
    );
  END IF;

  -- มี WMS activity หรืออยู่ในขั้นตอนผลิต → ต้องขอยกเลิกบิล
  IF v_has_wms OR v_order.status IN ('ใบสั่งงาน', 'ใบงานกำลังผลิต') THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'needs_amendment', true,
      'needs_credit_note', false,
      'has_wms_activity', v_has_wms,
      'wms_picked', v_wms_picked,
      'wms_correct', v_wms_correct,
      'order_status', v_order.status,
      'reason', 'บิลอยู่ในขั้นตอนผลิต/จัดสินค้า — ต้องขอยกเลิกบิลก่อนแล้วสร้างใหม่'
    );
  END IF;

  -- สถานะปกติก่อน WMS → แก้ได้เลย
  RETURN jsonb_build_object(
    'can_direct_edit', true,
    'needs_amendment', false,
    'needs_credit_note', false,
    'has_wms_activity', false,
    'order_status', v_order.status,
    'reason', 'สามารถแก้ไขได้โดยตรง'
  );
END;
$$;

-- ═══════════════════════════════════════════
-- 6. แก้ fn_reverse_wms_stock — เพิ่ม stock_action = 'recalled'
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_reverse_wms_stock(p_wms_order_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_movement    RECORD;
  v_consumption RECORD;
  v_product_id  UUID;
  v_total_returned NUMERIC := 0;
  v_reversal_id UUID;
BEGIN
  SELECT sm.id, sm.product_id, sm.qty, sm.unit_cost, sm.total_cost
  INTO v_movement
  FROM inv_stock_movements sm
  WHERE sm.ref_type = 'wms_orders'
    AND sm.ref_id = p_wms_order_id
    AND sm.movement_type = 'pick'
  ORDER BY sm.created_at DESC
  LIMIT 1;

  IF v_movement.id IS NULL THEN RETURN 0; END IF;

  v_product_id := v_movement.product_id;

  FOR v_consumption IN
    SELECT lc.lot_id, lc.qty, lc.unit_cost
    FROM inv_lot_consumptions lc
    WHERE lc.movement_id = v_movement.id
  LOOP
    UPDATE inv_stock_lots
    SET qty_remaining = qty_remaining + v_consumption.qty
    WHERE id = v_consumption.lot_id;

    v_total_returned := v_total_returned + v_consumption.qty;
  END LOOP;

  INSERT INTO inv_stock_movements (
    product_id, movement_type, qty, ref_type, ref_id, note,
    unit_cost, total_cost
  ) VALUES (
    v_product_id, 'pick_reversal', v_total_returned,
    'wms_orders', p_wms_order_id,
    'คืนสต๊อก — ยกเลิกบิล (เรียกคืนได้)',
    COALESCE(v_movement.unit_cost, 0),
    v_total_returned * COALESCE(v_movement.unit_cost, 0)
  ) RETURNING id INTO v_reversal_id;

  UPDATE inv_stock_balances
  SET on_hand = COALESCE(on_hand, 0) + v_total_returned
  WHERE product_id = v_product_id;

  PERFORM fn_recalc_product_landed_cost(v_product_id);

  -- บันทึกว่าเรียกคืนแล้ว
  UPDATE wms_orders SET stock_action = 'recalled' WHERE id = p_wms_order_id;

  RETURN v_total_returned;
END;
$$;

-- ═══════════════════════════════════════════
-- 7. RPC ใหม่: rpc_record_cancellation_waste — ตีเป็นของเสีย
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_record_cancellation_waste(
  p_wms_order_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_movement    RECORD;
  v_product_id  UUID;
  v_qty         NUMERIC;
  v_avg_cost    NUMERIC;
BEGIN
  -- หา pick movement ของ wms_orders row นี้
  SELECT sm.id, sm.product_id, ABS(sm.qty) AS qty, sm.unit_cost
  INTO v_movement
  FROM inv_stock_movements sm
  WHERE sm.ref_type = 'wms_orders'
    AND sm.ref_id = p_wms_order_id
    AND sm.movement_type = 'pick'
  ORDER BY sm.created_at DESC
  LIMIT 1;

  IF v_movement.id IS NULL THEN
    -- ไม่มี pick movement (เช่นยังไม่ถึงขั้น correct) แค่ mark เป็น waste
    UPDATE wms_orders SET stock_action = 'waste' WHERE id = p_wms_order_id;
    RETURN jsonb_build_object('success', true, 'note', 'ไม่มี pick movement — mark เป็นของเสียเท่านั้น');
  END IF;

  v_product_id := v_movement.product_id;
  v_qty := v_movement.qty;
  v_avg_cost := COALESCE(v_movement.unit_cost, 0);

  -- บันทึกเป็น waste movement (สต๊อกถูกตัดไปแล้วจาก correct trigger)
  INSERT INTO inv_stock_movements (
    product_id, movement_type, qty, ref_type, ref_id, note,
    unit_cost, total_cost, created_by
  ) VALUES (
    v_product_id, 'waste', 0,
    'wms_orders', p_wms_order_id,
    'ของเสียจากบิลที่ยกเลิก (สต๊อกตัดไปแล้ว)',
    v_avg_cost, 0,
    p_user_id
  );

  -- บันทึกว่าตีเป็นของเสียแล้ว
  UPDATE wms_orders SET stock_action = 'waste' WHERE id = p_wms_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'product_id', v_product_id,
    'qty', v_qty,
    'action', 'waste'
  );
END;
$$;

-- ═══════════════════════════════════════════
-- 8. ลบตาราง/ฟังก์ชัน Credit Note
-- ═══════════════════════════════════════════

DROP FUNCTION IF EXISTS rpc_submit_credit_note(UUID, TEXT, TEXT, JSONB, UUID);
DROP FUNCTION IF EXISTS rpc_approve_credit_note(UUID, UUID);
DROP FUNCTION IF EXISTS rpc_reject_credit_note(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS rpc_generate_cn_no();

DROP TABLE IF EXISTS ac_credit_note_items CASCADE;
DROP TABLE IF EXISTS ac_credit_notes CASCADE;

-- ═══════════════════════════════════════════
-- 9. แก้ rpc_trial_balance_summary — ลบ credit_notes ออก
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_trial_balance_summary(p_year INT, p_month INT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_month_start TIMESTAMPTZ;
  v_month_end   TIMESTAMPTZ;
  v_purchases        NUMERIC := 0;
  v_cogs             NUMERIC := 0;
  v_returns          NUMERIC := 0;
  v_waste            NUMERIC := 0;
  v_adjustments      NUMERIC := 0;
  v_current_lot_val  NUMERIC := 0;
  v_current_ss_val   NUMERIC := 0;
  v_after_month_net  NUMERIC := 0;
  v_month_net        NUMERIC := 0;
  v_ending           NUMERIC := 0;
  v_beginning        NUMERIC := 0;
  v_movement_count   INT := 0;
  v_product_count    INT := 0;
  v_gross_sales      NUMERIC := 0;
  v_refunds_approved NUMERIC := 0;
  v_net_sales        NUMERIC := 0;
  v_gross_profit     NUMERIC := 0;
  v_gross_margin_pct NUMERIC := 0;
  v_rec              RECORD;
BEGIN
  v_month_start := make_timestamptz(p_year, p_month, 1, 0, 0, 0, 'Asia/Bangkok');
  v_month_end   := v_month_start + INTERVAL '1 month';

  FOR v_rec IN
    SELECT movement_type,
           SUM(total_cost) AS total,
           COUNT(*)        AS cnt
    FROM inv_stock_movements
    WHERE created_at >= v_month_start AND created_at < v_month_end
      AND total_cost IS NOT NULL
    GROUP BY movement_type
  LOOP
    v_movement_count := v_movement_count + v_rec.cnt;
    CASE v_rec.movement_type
      WHEN 'gr'                   THEN v_purchases   := v_rec.total;
      WHEN 'pick'                 THEN v_cogs        := ABS(v_rec.total);
      WHEN 'pick_reversal'        THEN v_cogs        := v_cogs - v_rec.total;
      WHEN 'return_requisition'   THEN v_returns     := v_returns + v_rec.total;
      WHEN 'return'               THEN v_returns     := v_returns + v_rec.total;
      WHEN 'waste'                THEN v_waste       := ABS(v_rec.total);
      WHEN 'adjust'               THEN v_adjustments := v_rec.total;
      ELSE NULL;
    END CASE;
  END LOOP;

  SELECT COUNT(DISTINCT product_id) INTO v_product_count
  FROM inv_stock_movements
  WHERE created_at >= v_month_start AND created_at < v_month_end;

  SELECT COALESCE(SUM(qty_remaining * unit_cost), 0)
  INTO v_current_lot_val
  FROM inv_stock_lots
  WHERE qty_remaining > 0 AND is_safety_stock = FALSE;

  SELECT COALESCE(SUM(qty_remaining * unit_cost), 0)
  INTO v_current_ss_val
  FROM inv_stock_lots
  WHERE qty_remaining > 0 AND is_safety_stock = TRUE;

  SELECT COALESCE(SUM(total_cost), 0)
  INTO v_after_month_net
  FROM inv_stock_movements
  WHERE created_at >= v_month_end
    AND movement_type <> 'waste'
    AND total_cost IS NOT NULL;

  v_ending := v_current_lot_val - v_after_month_net;

  SELECT COALESCE(SUM(total_cost), 0)
  INTO v_month_net
  FROM inv_stock_movements
  WHERE created_at >= v_month_start AND created_at < v_month_end
    AND movement_type <> 'waste'
    AND total_cost IS NOT NULL;

  v_beginning := v_ending - v_month_net;

  SELECT COALESCE(SUM(o.total_amount), 0)
  INTO v_gross_sales
  FROM or_orders o
  WHERE o.status = 'จัดส่งแล้ว'
    AND o.shipped_time IS NOT NULL
    AND o.shipped_time >= v_month_start
    AND o.shipped_time < v_month_end;

  SELECT COALESCE(SUM(r.amount), 0)
  INTO v_refunds_approved
  FROM ac_refunds r
  JOIN or_orders o ON o.id = r.order_id
  WHERE r.status = 'approved'
    AND o.status = 'จัดส่งแล้ว'
    AND o.shipped_time IS NOT NULL
    AND o.shipped_time >= v_month_start
    AND o.shipped_time < v_month_end;

  v_net_sales := v_gross_sales - v_refunds_approved;
  v_gross_profit := v_net_sales - v_cogs;
  v_gross_margin_pct := CASE
    WHEN ABS(v_net_sales) < 0.000001 THEN 0
    ELSE (v_gross_profit / v_net_sales) * 100
  END;

  RETURN jsonb_build_object(
    'beginning_inventory', ROUND(v_beginning, 2),
    'ending_inventory',    ROUND(v_ending, 2),
    'safety_stock_value',  ROUND(v_current_ss_val, 2),
    'purchases',           ROUND(v_purchases, 2),
    'cogs',                ROUND(v_cogs, 2),
    'returns',             ROUND(v_returns, 2),
    'waste',               ROUND(v_waste, 2),
    'adjustments',         ROUND(v_adjustments, 2),
    'gross_sales',         ROUND(v_gross_sales, 2),
    'refunds_approved',    ROUND(v_refunds_approved, 2),
    'net_sales',           ROUND(v_net_sales, 2),
    'gross_profit',        ROUND(v_gross_profit, 2),
    'gross_margin_pct',    ROUND(v_gross_margin_pct, 2),
    'movement_count',      v_movement_count,
    'product_count',       v_product_count
  );
END;
$$;
