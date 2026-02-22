-- ============================================
-- 118: Bill Edit Protection System
-- ระบบป้องกันการแก้ไขบิล + Amendment + Credit Note + Revision
-- ============================================

-- ═══════════════════════════════════════════
-- 0. เพิ่ม columns ใน or_orders
-- ═══════════════════════════════════════════

ALTER TABLE or_orders ADD COLUMN IF NOT EXISTS revision_no INTEGER DEFAULT 0;
ALTER TABLE or_orders ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT false;

-- ═══════════════════════════════════════════
-- 1. ตาราง or_order_amendments (ใบขอแก้ไขออเดอร์)
-- ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS or_order_amendments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amendment_no TEXT UNIQUE NOT NULL,
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  bill_no TEXT,
  reason_type TEXT NOT NULL CHECK (reason_type IN ('staff_error', 'customer_change')),
  reason_detail TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed')),
  requested_by UUID REFERENCES us_users(id),
  approved_by UUID REFERENCES us_users(id),
  rejected_reason TEXT,
  changes_json JSONB DEFAULT '{}'::jsonb,
  items_before JSONB DEFAULT '[]'::jsonb,
  items_after JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ
);

ALTER TABLE or_order_amendments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "or_order_amendments_select"
  ON or_order_amendments FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','admin-tr','admin-pump','admin_qc','account','manager')
  ));

CREATE POLICY "or_order_amendments_insert"
  ON or_order_amendments FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','admin-tr','admin-pump','admin_qc','account')
  ));

CREATE POLICY "or_order_amendments_update"
  ON or_order_amendments FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin')
  ));

CREATE INDEX idx_amendments_order_id ON or_order_amendments(order_id);
CREATE INDEX idx_amendments_status ON or_order_amendments(status);
CREATE INDEX idx_amendments_created_at ON or_order_amendments(created_at DESC);

-- ═══════════════════════════════════════════
-- 2. ตาราง ac_credit_notes (ใบลดหนี้)
-- ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ac_credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cn_no TEXT UNIQUE NOT NULL,
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  bill_no TEXT,
  cn_type TEXT NOT NULL CHECK (cn_type IN ('price_adjust', 'return_goods', 'full_cancel')),
  reason TEXT,
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected')),
  created_by UUID REFERENCES us_users(id),
  approved_by UUID REFERENCES us_users(id),
  rejected_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ
);

ALTER TABLE ac_credit_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ac_credit_notes_select"
  ON ac_credit_notes FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','admin-tr','admin-pump','account','manager')
  ));

CREATE POLICY "ac_credit_notes_insert"
  ON ac_credit_notes FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','admin-tr','admin-pump','account')
  ));

CREATE POLICY "ac_credit_notes_update"
  ON ac_credit_notes FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin')
  ));

CREATE INDEX idx_credit_notes_order_id ON ac_credit_notes(order_id);
CREATE INDEX idx_credit_notes_status ON ac_credit_notes(status);
CREATE INDEX idx_credit_notes_created_at ON ac_credit_notes(created_at DESC);

-- ═══════════════════════════════════════════
-- 3. ตาราง ac_credit_note_items
-- ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ac_credit_note_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id UUID NOT NULL REFERENCES ac_credit_notes(id) ON DELETE CASCADE,
  product_id UUID REFERENCES pr_products(id),
  product_name TEXT,
  qty NUMERIC(12,2) NOT NULL DEFAULT 0,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  return_to_stock BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ac_credit_note_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ac_credit_note_items_select"
  ON ac_credit_note_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','admin-tr','admin-pump','account','manager')
  ));

CREATE POLICY "ac_credit_note_items_insert"
  ON ac_credit_note_items FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','admin-tr','admin-pump','account')
  ));

CREATE INDEX idx_cn_items_cn_id ON ac_credit_note_items(credit_note_id);

-- ═══════════════════════════════════════════
-- 4. ตาราง or_order_revisions (ประวัติ version)
-- ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS or_order_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  change_source TEXT NOT NULL CHECK (change_source IN ('direct_edit', 'amendment', 'credit_note', 'system')),
  change_source_id UUID,
  snapshot_order JSONB NOT NULL,
  snapshot_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(order_id, revision_no)
);

ALTER TABLE or_order_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "or_order_revisions_select"
  ON or_order_revisions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','admin-tr','admin-pump','admin_qc','account','manager')
  ));

CREATE POLICY "or_order_revisions_insert"
  ON or_order_revisions FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','admin-tr','admin-pump','admin_qc','account')
  ));

CREATE INDEX idx_revisions_order_id ON or_order_revisions(order_id);
CREATE INDEX idx_revisions_created_at ON or_order_revisions(created_at DESC);

-- ═══════════════════════════════════════════
-- 5. RPC: ตรวจสอบสิทธิ์แก้ไขบิล (ลำดับ 1)
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
      'reason', 'บิลนี้มีใบขอแก้ไขรออนุมัติอยู่แล้ว'
    );
  END IF;

  -- ตรวจ WMS activity
  IF v_order.work_order_name IS NOT NULL AND v_order.work_order_name <> '' THEN
    SELECT COUNT(*),
           COUNT(*) FILTER (WHERE status = 'picked'),
           COUNT(*) FILTER (WHERE status = 'correct')
    INTO v_wms_count, v_wms_picked, v_wms_correct
    FROM wms_orders
    WHERE order_id = v_order.work_order_name;

    v_has_wms := v_wms_count > 0;
  END IF;

  -- จัดส่งแล้ว → ต้องทำ Credit Note
  IF v_order.status = 'จัดส่งแล้ว' THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'needs_amendment', false,
      'needs_credit_note', true,
      'has_wms_activity', v_has_wms,
      'order_status', v_order.status,
      'reason', 'บิลจัดส่งแล้ว — ต้องสร้าง Credit Note แทนการแก้ไขโดยตรง'
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

  -- มี WMS activity หรืออยู่ในขั้นตอนผลิต → ต้องทำ Amendment
  IF v_has_wms OR v_order.status IN ('ใบสั่งงาน', 'ใบงานกำลังผลิต') THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'needs_amendment', true,
      'needs_credit_note', false,
      'has_wms_activity', v_has_wms,
      'wms_picked', v_wms_picked,
      'wms_correct', v_wms_correct,
      'order_status', v_order.status,
      'reason', 'บิลอยู่ในขั้นตอนผลิต/จัดสินค้า — ต้องส่งใบขอแก้ไข (Amendment)'
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
-- 6. fn_reverse_wms_stock — reverse FIFO สำหรับ wms_orders 1 row (ลำดับ 2)
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
  -- หา pick movement ที่เชื่อมกับ wms_orders row นี้
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

  -- คืน qty กลับแต่ละ lot ที่ถูก consume
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

  -- สร้าง reversal movement (qty เป็นบวก = คืนเข้าคลัง)
  INSERT INTO inv_stock_movements (
    product_id, movement_type, qty, ref_type, ref_id, note,
    unit_cost, total_cost
  ) VALUES (
    v_product_id, 'pick_reversal', v_total_returned,
    'wms_orders', p_wms_order_id,
    'คืนสต๊อก — ยกเลิก WMS (Amendment)',
    COALESCE(v_movement.unit_cost, 0),
    v_total_returned * COALESCE(v_movement.unit_cost, 0)
  ) RETURNING id INTO v_reversal_id;

  -- คืน on_hand
  UPDATE inv_stock_balances
  SET on_hand = COALESCE(on_hand, 0) + v_total_returned
  WHERE product_id = v_product_id;

  PERFORM fn_recalc_product_landed_cost(v_product_id);

  RETURN v_total_returned;
END;
$$;

-- ═══════════════════════════════════════════
-- 7. rpc_cancel_wms_for_amendment — ยกเลิก WMS ทั้งใบงาน
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_cancel_wms_for_amendment(
  p_work_order_name TEXT,
  p_amendment_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wms      RECORD;
  v_reversed INT := 0;
  v_released INT := 0;
  v_product_id UUID;
BEGIN
  FOR v_wms IN
    SELECT id, product_code, qty, status
    FROM wms_orders
    WHERE order_id = p_work_order_name
      AND status NOT IN ('cancelled')
  LOOP
    -- หา product_id จาก product_code
    SELECT id INTO v_product_id
    FROM pr_products
    WHERE product_code = v_wms.product_code
    LIMIT 1;

    IF v_wms.status = 'correct' AND v_product_id IS NOT NULL THEN
      PERFORM fn_reverse_wms_stock(v_wms.id);
      v_reversed := v_reversed + 1;

    ELSIF v_wms.status = 'picked' AND v_product_id IS NOT NULL THEN
      UPDATE inv_stock_balances
      SET reserved = GREATEST(COALESCE(reserved, 0) - v_wms.qty, 0)
      WHERE product_id = v_product_id;
      v_released := v_released + 1;
    END IF;

    -- ยกเลิก wms row (ไม่ใช้ update status เพราะ trigger จะทำงาน)
    -- ลบ row แทนเพื่อไม่ให้ trigger inv_deduct_stock_on_wms_picked ทำงานซ้ำ
    DELETE FROM wms_orders WHERE id = v_wms.id;
  END LOOP;

  RETURN jsonb_build_object(
    'reversed_count', v_reversed,
    'released_count', v_released,
    'work_order_name', p_work_order_name
  );
END;
$$;

-- ═══════════════════════════════════════════
-- 8. RPC: สร้าง Amendment Request (ลำดับ 3)
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_generate_amendment_no()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_today TEXT;
  v_seq   INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('amendment_no_gen'));
  v_today := to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD');

  SELECT COALESCE(MAX(CAST(SPLIT_PART(amendment_no, '-', 3) AS INTEGER)), 0) + 1
  INTO v_seq
  FROM or_order_amendments
  WHERE amendment_no LIKE 'AM-' || v_today || '-%';

  RETURN 'AM-' || v_today || '-' || lpad(v_seq::text, 3, '0');
END;
$$;

CREATE OR REPLACE FUNCTION rpc_submit_amendment(
  p_order_id     UUID,
  p_reason_type  TEXT,
  p_reason_detail TEXT,
  p_changes_json JSONB,
  p_items_after  JSONB,
  p_user_id      UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_amendment_no TEXT;
  v_bill_no      TEXT;
  v_items_before JSONB;
  v_amendment_id UUID;
  v_pending      INT;
BEGIN
  -- ตรวจว่ายังไม่มี pending amendment
  SELECT COUNT(*) INTO v_pending
  FROM or_order_amendments
  WHERE order_id = p_order_id AND status = 'pending';

  IF v_pending > 0 THEN
    RAISE EXCEPTION 'บิลนี้มีใบขอแก้ไขรออนุมัติอยู่แล้ว';
  END IF;

  SELECT bill_no INTO v_bill_no FROM or_orders WHERE id = p_order_id;

  -- เก็บ snapshot items ปัจจุบัน
  SELECT COALESCE(jsonb_agg(row_to_json(oi)::jsonb), '[]'::jsonb)
  INTO v_items_before
  FROM or_order_items oi
  WHERE oi.order_id = p_order_id;

  v_amendment_no := rpc_generate_amendment_no();

  INSERT INTO or_order_amendments (
    amendment_no, order_id, bill_no, reason_type, reason_detail,
    status, requested_by, changes_json, items_before, items_after
  ) VALUES (
    v_amendment_no, p_order_id, v_bill_no, p_reason_type, p_reason_detail,
    'pending', p_user_id, p_changes_json, v_items_before, p_items_after
  ) RETURNING id INTO v_amendment_id;

  RETURN jsonb_build_object(
    'id', v_amendment_id,
    'amendment_no', v_amendment_no,
    'status', 'pending'
  );
END;
$$;

-- ═══════════════════════════════════════════
-- 9. RPC: อนุมัติ Amendment (ลำดับ 3 + ลำดับ 2 stock reversal)
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
  v_role          TEXT;
  v_amendment     RECORD;
  v_order         RECORD;
  v_reversal_result JSONB;
  v_new_rev       INT;
  v_snapshot_order JSONB;
  v_key           TEXT;
  v_val           JSONB;
  v_item          JSONB;
  v_idx           INT := 0;
  v_item_uid      TEXT;
BEGIN
  -- Safety net: ตรวจ role
  SELECT role INTO v_role FROM us_users WHERE id = p_approver_id;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติ — ต้องเป็น superadmin หรือ admin เท่านั้น (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT * INTO v_amendment FROM or_order_amendments WHERE id = p_amendment_id;
  IF v_amendment.id IS NULL THEN RAISE EXCEPTION 'ไม่พบใบขอแก้ไข'; END IF;
  IF v_amendment.status <> 'pending' THEN
    RAISE EXCEPTION 'ใบขอแก้ไขนี้ไม่อยู่ในสถานะรออนุมัติ (status: %)', v_amendment.status;
  END IF;

  SELECT * INTO v_order FROM or_orders WHERE id = v_amendment.order_id;

  -- เก็บ snapshot ก่อน revision
  SELECT row_to_json(o)::jsonb INTO v_snapshot_order
  FROM or_orders o WHERE o.id = v_amendment.order_id;

  -- Reverse WMS stock (ถ้ามี)
  IF v_order.work_order_name IS NOT NULL AND v_order.work_order_name <> '' THEN
    v_reversal_result := rpc_cancel_wms_for_amendment(v_order.work_order_name, p_amendment_id);
  END IF;

  -- Update or_orders ตาม changes_json
  IF v_amendment.changes_json IS NOT NULL AND v_amendment.changes_json <> '{}'::jsonb THEN
    FOR v_key, v_val IN SELECT * FROM jsonb_each(v_amendment.changes_json)
    LOOP
      -- ข้าม key ที่ไม่ควร update ตรง
      IF v_key NOT IN ('id', 'created_at', 'updated_at', 'bill_no') THEN
        EXECUTE format(
          'UPDATE or_orders SET %I = $1 WHERE id = $2',
          v_key
        ) USING v_val #>> '{}', v_amendment.order_id;
      END IF;
    END LOOP;
  END IF;

  -- ลบ order items เดิม + insert items ใหม่ (ถ้ามี)
  IF v_amendment.items_after IS NOT NULL AND jsonb_array_length(v_amendment.items_after) > 0 THEN
    DELETE FROM or_order_items WHERE order_id = v_amendment.order_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_amendment.items_after)
    LOOP
      v_idx := v_idx + 1;
      v_item_uid := COALESCE(v_order.bill_no, 'AM') || '-' || v_idx;

      INSERT INTO or_order_items (
        order_id, item_uid, product_id, product_name, quantity,
        unit_price, ink_color, product_type, cartoon_pattern,
        line_pattern, font, line_1, line_2, line_3,
        no_name_line, is_free, notes, file_attachment
      ) VALUES (
        v_amendment.order_id,
        v_item_uid,
        (v_item->>'product_id')::uuid,
        COALESCE(v_item->>'product_name', ''),
        COALESCE((v_item->>'quantity')::int, 1),
        COALESCE((v_item->>'unit_price')::numeric, 0),
        v_item->>'ink_color',
        COALESCE(v_item->>'product_type', 'ชั้น1'),
        v_item->>'cartoon_pattern',
        v_item->>'line_pattern',
        v_item->>'font',
        v_item->>'line_1',
        v_item->>'line_2',
        v_item->>'line_3',
        COALESCE((v_item->>'no_name_line')::boolean, false),
        COALESCE((v_item->>'is_free')::boolean, false),
        v_item->>'notes',
        v_item->>'file_attachment'
      );
    END LOOP;
  END IF;

  -- สร้าง revision
  v_new_rev := COALESCE(v_order.revision_no, 0) + 1;

  INSERT INTO or_order_revisions (
    order_id, revision_no, change_source, change_source_id,
    snapshot_order, snapshot_items, created_by
  ) VALUES (
    v_amendment.order_id, v_new_rev, 'amendment', p_amendment_id,
    v_snapshot_order, v_amendment.items_before,
    (SELECT COALESCE(username, email) FROM us_users WHERE id = p_approver_id)
  );

  UPDATE or_orders
  SET revision_no = v_new_rev
  WHERE id = v_amendment.order_id;

  -- Update amendment status
  UPDATE or_order_amendments
  SET status = 'executed', approved_by = p_approver_id,
      approved_at = NOW(), executed_at = NOW()
  WHERE id = p_amendment_id;

  RETURN jsonb_build_object(
    'success', true,
    'amendment_no', v_amendment.amendment_no,
    'revision_no', v_new_rev,
    'reversal_result', COALESCE(v_reversal_result, '{}'::jsonb)
  );
END;
$$;

-- ═══════════════════════════════════════════
-- 10. RPC: ปฏิเสธ Amendment
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_reject_amendment(
  p_amendment_id UUID,
  p_approver_id  UUID,
  p_reason       TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_role   TEXT;
  v_status TEXT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = p_approver_id;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ปฏิเสธ — ต้องเป็น superadmin หรือ admin เท่านั้น';
  END IF;

  SELECT status INTO v_status FROM or_order_amendments WHERE id = p_amendment_id;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'ใบขอแก้ไขนี้ไม่อยู่ในสถานะรออนุมัติ';
  END IF;

  UPDATE or_order_amendments
  SET status = 'rejected', approved_by = p_approver_id,
      approved_at = NOW(), rejected_reason = p_reason
  WHERE id = p_amendment_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ═══════════════════════════════════════════
-- 11. RPC: สร้าง Credit Note (ลำดับ 4)
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_generate_cn_no()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_today TEXT;
  v_seq   INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cn_no_gen'));
  v_today := to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD');

  SELECT COALESCE(MAX(CAST(SPLIT_PART(cn_no, '-', 3) AS INTEGER)), 0) + 1
  INTO v_seq
  FROM ac_credit_notes
  WHERE cn_no LIKE 'CN-' || v_today || '-%';

  RETURN 'CN-' || v_today || '-' || lpad(v_seq::text, 3, '0');
END;
$$;

CREATE OR REPLACE FUNCTION rpc_submit_credit_note(
  p_order_id UUID,
  p_cn_type  TEXT,
  p_reason   TEXT,
  p_items    JSONB,
  p_user_id  UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cn_no      TEXT;
  v_cn_id      UUID;
  v_bill_no    TEXT;
  v_total      NUMERIC := 0;
  v_item       JSONB;
  v_item_amt   NUMERIC;
BEGIN
  SELECT bill_no INTO v_bill_no FROM or_orders WHERE id = p_order_id;

  v_cn_no := rpc_generate_cn_no();

  INSERT INTO ac_credit_notes (
    cn_no, order_id, bill_no, cn_type, reason,
    total_amount, status, created_by
  ) VALUES (
    v_cn_no, p_order_id, v_bill_no, p_cn_type, p_reason,
    0, 'draft', p_user_id
  ) RETURNING id INTO v_cn_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_amt := COALESCE((v_item->>'qty')::numeric, 0)
               * COALESCE((v_item->>'unit_price')::numeric, 0);

    INSERT INTO ac_credit_note_items (
      credit_note_id, product_id, product_name, qty,
      unit_price, amount, return_to_stock
    ) VALUES (
      v_cn_id,
      CASE WHEN v_item->>'product_id' IS NOT NULL AND v_item->>'product_id' <> ''
           THEN (v_item->>'product_id')::uuid ELSE NULL END,
      v_item->>'product_name',
      COALESCE((v_item->>'qty')::numeric, 0),
      COALESCE((v_item->>'unit_price')::numeric, 0),
      v_item_amt,
      COALESCE((v_item->>'return_to_stock')::boolean, false)
    );

    v_total := v_total + v_item_amt;
  END LOOP;

  UPDATE ac_credit_notes SET total_amount = v_total WHERE id = v_cn_id;

  RETURN jsonb_build_object(
    'id', v_cn_id,
    'cn_no', v_cn_no,
    'total_amount', v_total,
    'status', 'draft'
  );
END;
$$;

-- ═══════════════════════════════════════════
-- 12. RPC: อนุมัติ Credit Note
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_approve_credit_note(
  p_cn_id       UUID,
  p_approver_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_role       TEXT;
  v_cn         RECORD;
  v_item       RECORD;
  v_avg_cost   NUMERIC;
  v_movement_id UUID;
  v_returned   INT := 0;
  v_order      RECORD;
  v_snapshot_order JSONB;
  v_snapshot_items JSONB;
  v_new_rev    INT;
BEGIN
  -- Safety net: ตรวจ role
  SELECT role INTO v_role FROM us_users WHERE id = p_approver_id;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติ Credit Note — ต้องเป็น superadmin หรือ admin เท่านั้น';
  END IF;

  SELECT * INTO v_cn FROM ac_credit_notes WHERE id = p_cn_id;
  IF v_cn.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Credit Note'; END IF;
  IF v_cn.status <> 'draft' THEN
    RAISE EXCEPTION 'Credit Note นี้ไม่อยู่ในสถานะ draft (status: %)', v_cn.status;
  END IF;

  -- อนุมัติ
  UPDATE ac_credit_notes
  SET status = 'approved', approved_by = p_approver_id, approved_at = NOW()
  WHERE id = p_cn_id;

  -- คืนสต๊อก (เฉพาะ item ที่ return_to_stock = true)
  FOR v_item IN
    SELECT * FROM ac_credit_note_items
    WHERE credit_note_id = p_cn_id AND return_to_stock = true AND product_id IS NOT NULL
  LOOP
    v_avg_cost := fn_get_current_avg_cost(v_item.product_id);

    UPDATE inv_stock_balances
    SET on_hand = COALESCE(on_hand, 0) + v_item.qty
    WHERE product_id = v_item.product_id;

    IF NOT FOUND THEN
      INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES (v_item.product_id, v_item.qty, 0, 0);
    END IF;

    INSERT INTO inv_stock_movements (
      product_id, movement_type, qty, ref_type, ref_id, note,
      unit_cost, total_cost
    ) VALUES (
      v_item.product_id, 'cn_return', v_item.qty,
      'ac_credit_notes', p_cn_id,
      'คืนสต๊อกจาก Credit Note ' || v_cn.cn_no,
      v_avg_cost, v_item.qty * v_avg_cost
    );

    INSERT INTO inv_stock_lots (
      product_id, qty_initial, qty_remaining, unit_cost,
      ref_type, ref_id
    ) VALUES (
      v_item.product_id, v_item.qty, v_item.qty, v_avg_cost,
      'ac_credit_notes', p_cn_id
    );

    PERFORM fn_recalc_product_landed_cost(v_item.product_id);
    v_returned := v_returned + 1;
  END LOOP;

  -- สร้าง revision สำหรับออเดอร์ที่เกี่ยวข้อง
  SELECT * INTO v_order FROM or_orders WHERE id = v_cn.order_id;
  IF v_order.id IS NOT NULL THEN
    SELECT row_to_json(o)::jsonb INTO v_snapshot_order
    FROM or_orders o WHERE o.id = v_cn.order_id;

    SELECT COALESCE(jsonb_agg(row_to_json(oi)::jsonb), '[]'::jsonb)
    INTO v_snapshot_items
    FROM or_order_items oi WHERE oi.order_id = v_cn.order_id;

    v_new_rev := COALESCE(v_order.revision_no, 0) + 1;

    INSERT INTO or_order_revisions (
      order_id, revision_no, change_source, change_source_id,
      snapshot_order, snapshot_items, created_by
    ) VALUES (
      v_cn.order_id, v_new_rev, 'credit_note', p_cn_id,
      v_snapshot_order, v_snapshot_items,
      (SELECT COALESCE(username, email) FROM us_users WHERE id = p_approver_id)
    );

    UPDATE or_orders SET revision_no = v_new_rev WHERE id = v_cn.order_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'cn_no', v_cn.cn_no,
    'total_amount', v_cn.total_amount,
    'items_returned_to_stock', v_returned
  );
END;
$$;

-- ═══════════════════════════════════════════
-- 13. RPC: ปฏิเสธ Credit Note
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_reject_credit_note(
  p_cn_id       UUID,
  p_approver_id UUID,
  p_reason      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_role   TEXT;
  v_status TEXT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = p_approver_id;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ปฏิเสธ Credit Note';
  END IF;

  SELECT status INTO v_status FROM ac_credit_notes WHERE id = p_cn_id;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Credit Note นี้ไม่อยู่ในสถานะ draft';
  END IF;

  UPDATE ac_credit_notes
  SET status = 'rejected', approved_by = p_approver_id,
      approved_at = NOW(), rejected_reason = p_reason
  WHERE id = p_cn_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ═══════════════════════════════════════════
-- 14. RPC: บันทึกแก้ไขบิลตรง + revision (ลำดับ 5)
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_save_bill_edit_with_revision(
  p_order_id     UUID,
  p_order_data   JSONB,
  p_items        JSONB,
  p_user_name    TEXT,
  p_edit_changes JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order         RECORD;
  v_snapshot_order JSONB;
  v_snapshot_items JSONB;
  v_new_rev       INT;
  v_bill_no       TEXT;
  v_item          JSONB;
  v_idx           INT := 0;
  v_item_uid      TEXT;
BEGIN
  SELECT * INTO v_order FROM or_orders WHERE id = p_order_id;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'ไม่พบออเดอร์'; END IF;

  -- เก็บ snapshot ก่อนแก้
  SELECT row_to_json(o)::jsonb INTO v_snapshot_order
  FROM or_orders o WHERE o.id = p_order_id;

  SELECT COALESCE(jsonb_agg(row_to_json(oi)::jsonb), '[]'::jsonb)
  INTO v_snapshot_items
  FROM or_order_items oi WHERE oi.order_id = p_order_id;

  -- Update or_orders
  UPDATE or_orders SET
    customer_name    = COALESCE(p_order_data->>'customer_name', customer_name),
    customer_address = COALESCE(p_order_data->>'customer_address', customer_address),
    channel_code     = COALESCE(p_order_data->>'channel_code', channel_code),
    total_amount     = COALESCE((p_order_data->>'total_amount')::numeric, total_amount),
    price            = COALESCE((p_order_data->>'price')::numeric, price),
    shipping_cost    = COALESCE((p_order_data->>'shipping_cost')::numeric, shipping_cost),
    discount         = COALESCE((p_order_data->>'discount')::numeric, discount),
    payment_method   = COALESCE(p_order_data->>'payment_method', payment_method),
    payment_date     = COALESCE(p_order_data->>'payment_date', payment_date),
    payment_time     = COALESCE(p_order_data->>'payment_time', payment_time),
    promotion        = COALESCE(p_order_data->>'promotion', promotion),
    tracking_number  = COALESCE(p_order_data->>'tracking_number', tracking_number),
    recipient_name   = COALESCE(p_order_data->>'recipient_name', recipient_name),
    channel_order_no = COALESCE(p_order_data->>'channel_order_no', channel_order_no),
    confirm_note     = COALESCE(p_order_data->>'confirm_note', confirm_note),
    status           = COALESCE(p_order_data->>'status', status),
    billing_details  = CASE
      WHEN p_order_data ? 'billing_details' THEN (p_order_data->'billing_details')
      ELSE billing_details
    END,
    updated_at       = NOW()
  WHERE id = p_order_id;

  v_bill_no := COALESCE(v_order.bill_no, '');

  -- ลบ items เดิม + insert ใหม่ (ถ้ามี)
  IF p_items IS NOT NULL AND jsonb_array_length(p_items) > 0 THEN
    DELETE FROM or_order_items WHERE order_id = p_order_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_idx := v_idx + 1;
      v_item_uid := CASE WHEN v_bill_no <> '' THEN v_bill_no || '-' || v_idx
                         ELSE 'EDIT-' || v_idx END;

      INSERT INTO or_order_items (
        order_id, item_uid, product_id, product_name, quantity,
        unit_price, ink_color, product_type, cartoon_pattern,
        line_pattern, font, line_1, line_2, line_3,
        no_name_line, is_free, notes, file_attachment
      ) VALUES (
        p_order_id,
        v_item_uid,
        CASE WHEN v_item->>'product_id' IS NOT NULL AND v_item->>'product_id' <> ''
             THEN (v_item->>'product_id')::uuid ELSE NULL END,
        COALESCE(v_item->>'product_name', ''),
        COALESCE((v_item->>'quantity')::int, 1),
        COALESCE((v_item->>'unit_price')::numeric, 0),
        v_item->>'ink_color',
        COALESCE(v_item->>'product_type', 'ชั้น1'),
        v_item->>'cartoon_pattern',
        v_item->>'line_pattern',
        v_item->>'font',
        v_item->>'line_1',
        v_item->>'line_2',
        v_item->>'line_3',
        COALESCE((v_item->>'no_name_line')::boolean, false),
        COALESCE((v_item->>'is_free')::boolean, false),
        v_item->>'notes',
        v_item->>'file_attachment'
      );
    END LOOP;
  END IF;

  -- สร้าง revision
  v_new_rev := COALESCE(v_order.revision_no, 0) + 1;

  INSERT INTO or_order_revisions (
    order_id, revision_no, change_source, snapshot_order,
    snapshot_items, created_by
  ) VALUES (
    p_order_id, v_new_rev, 'direct_edit',
    v_snapshot_order, v_snapshot_items, p_user_name
  );

  UPDATE or_orders SET revision_no = v_new_rev WHERE id = p_order_id;

  -- บันทึก edit log (เก็บย้อนหลัง)
  IF p_edit_changes IS NOT NULL AND jsonb_array_length(p_edit_changes) > 0 THEN
    INSERT INTO ac_bill_edit_logs (
      order_id, bill_no, edited_by, changes,
      snapshot_before, snapshot_after
    ) VALUES (
      p_order_id, v_bill_no, p_user_name, p_edit_changes,
      v_snapshot_order,
      (SELECT row_to_json(o)::jsonb FROM or_orders o WHERE o.id = p_order_id)
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'revision_no', v_new_rev
  );
END;
$$;

-- ═══════════════════════════════════════════
-- 15. แก้ rpc_trial_balance_summary — เพิ่ม Credit Notes
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
  v_credit_notes     NUMERIC := 0;
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
      WHEN 'cn_return'            THEN v_returns     := v_returns + v_rec.total;
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

  -- Revenue metrics
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

  -- Credit Notes (ใหม่)
  SELECT COALESCE(SUM(cn.total_amount), 0)
  INTO v_credit_notes
  FROM ac_credit_notes cn
  WHERE cn.status = 'approved'
    AND cn.approved_at >= v_month_start
    AND cn.approved_at < v_month_end;

  v_net_sales := v_gross_sales - v_refunds_approved - v_credit_notes;
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
    'credit_notes',        ROUND(v_credit_notes, 2),
    'net_sales',           ROUND(v_net_sales, 2),
    'gross_profit',        ROUND(v_gross_profit, 2),
    'gross_margin_pct',    ROUND(v_gross_margin_pct, 2),
    'movement_count',      v_movement_count,
    'product_count',       v_product_count
  );
END;
$$;
