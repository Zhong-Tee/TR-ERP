-- ============================================
-- 103: WMS Borrow Requisitions (ยืมของ)
-- แนวทาง Reserve: จองตอนอนุมัติ, ปลดตอนคืน,
-- ตัดสต๊อก FIFO + waste ตอนตัดเป็นของเสีย
-- ============================================

-- 1. Tables
CREATE TABLE IF NOT EXISTS wms_borrow_requisitions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  borrow_no TEXT UNIQUE NOT NULL,
  topic TEXT,
  status TEXT DEFAULT 'pending',
  due_date DATE NOT NULL,
  created_by UUID REFERENCES us_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_by UUID REFERENCES us_users(id),
  approved_at TIMESTAMPTZ,
  returned_at TIMESTAMPTZ,
  note TEXT
);

CREATE TABLE IF NOT EXISTS wms_borrow_requisition_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  borrow_requisition_id UUID NOT NULL REFERENCES wms_borrow_requisitions(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES pr_products(id),
  qty NUMERIC(12,2) NOT NULL,
  returned_qty NUMERIC(12,2) DEFAULT 0,
  written_off_qty NUMERIC(12,2) DEFAULT 0,
  topic TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. RLS
ALTER TABLE wms_borrow_requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_borrow_requisition_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can view borrow requisitions"
  ON wms_borrow_requisitions FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Production and admins can create borrow requisitions"
  ON wms_borrow_requisitions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','admin-tr','store','manager','production','production_mb')
    )
  );

CREATE POLICY "Admins can manage borrow requisitions"
  ON wms_borrow_requisitions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','admin-tr','store','manager')
    )
  );

CREATE POLICY "Admins can delete borrow requisitions"
  ON wms_borrow_requisitions FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','admin-tr','store','manager')
    )
  );

CREATE POLICY "Anyone authenticated can view borrow requisition items"
  ON wms_borrow_requisition_items FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Production and admins can create borrow requisition items"
  ON wms_borrow_requisition_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','admin-tr','store','manager','production','production_mb')
    )
  );

CREATE POLICY "Admins can manage borrow requisition items"
  ON wms_borrow_requisition_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','admin-tr','store','manager')
    )
  );

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_wms_borrow_req_status ON wms_borrow_requisitions(status);
CREATE INDEX IF NOT EXISTS idx_wms_borrow_req_created_by ON wms_borrow_requisitions(created_by);
CREATE INDEX IF NOT EXISTS idx_wms_borrow_req_due_date ON wms_borrow_requisitions(due_date);
CREATE INDEX IF NOT EXISTS idx_wms_borrow_items_req_id ON wms_borrow_requisition_items(borrow_requisition_id);

-- 4. Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE wms_borrow_requisitions;

-- ============================================
-- 5. RPCs
-- ============================================

-- 5a. Approve borrow: reserve stock
CREATE OR REPLACE FUNCTION approve_borrow_requisition(
  p_borrow_id UUID,
  p_user_id   UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   TEXT;
  v_status TEXT;
  v_item   RECORD;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = p_user_id;
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','manager') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติรายการยืม (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT status INTO v_status FROM wms_borrow_requisitions WHERE id = p_borrow_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการยืม'; END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'รายการนี้ไม่อยู่ในสถานะรออนุมัติ (status: %)', v_status;
  END IF;

  FOR v_item IN
    SELECT product_id, qty
    FROM wms_borrow_requisition_items
    WHERE borrow_requisition_id = p_borrow_id
  LOOP
    INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_item.product_id, 0, v_item.qty, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET reserved = inv_stock_balances.reserved + v_item.qty;
  END LOOP;

  UPDATE wms_borrow_requisitions
  SET status = 'approved', approved_by = p_user_id, approved_at = NOW()
  WHERE id = p_borrow_id;
END;
$$;

-- 5b. Return borrow: release reserve
CREATE OR REPLACE FUNCTION return_borrow_requisition(
  p_borrow_id UUID,
  p_items     JSONB,
  p_user_id   UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status     TEXT;
  v_item       JSONB;
  v_product_id UUID;
  v_return_qty NUMERIC;
  v_borrow_item RECORD;
  v_all_done   BOOLEAN;
BEGIN
  SELECT status INTO v_status FROM wms_borrow_requisitions WHERE id = p_borrow_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการยืม'; END IF;
  IF v_status NOT IN ('approved', 'partial_returned', 'overdue') THEN
    RAISE EXCEPTION 'ไม่สามารถคืนได้ (status: %)', v_status;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_return_qty := (v_item->>'return_qty')::NUMERIC;
    IF v_return_qty IS NULL OR v_return_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_borrow_item
    FROM wms_borrow_requisition_items
    WHERE borrow_requisition_id = p_borrow_id AND product_id = v_product_id;

    IF v_borrow_item IS NULL THEN CONTINUE; END IF;
    IF v_borrow_item.returned_qty + v_borrow_item.written_off_qty + v_return_qty > v_borrow_item.qty THEN
      RAISE EXCEPTION 'จำนวนคืนเกินจำนวนที่ยืม (สินค้า: %)', v_product_id;
    END IF;

    UPDATE wms_borrow_requisition_items
    SET returned_qty = returned_qty + v_return_qty
    WHERE id = v_borrow_item.id;

    UPDATE inv_stock_balances
    SET reserved = GREATEST(COALESCE(reserved, 0) - v_return_qty, 0)
    WHERE product_id = v_product_id;
  END LOOP;

  SELECT NOT EXISTS (
    SELECT 1 FROM wms_borrow_requisition_items
    WHERE borrow_requisition_id = p_borrow_id
      AND (returned_qty + written_off_qty) < qty
  ) INTO v_all_done;

  IF v_all_done THEN
    UPDATE wms_borrow_requisitions
    SET status = 'returned', returned_at = NOW()
    WHERE id = p_borrow_id;
  ELSE
    UPDATE wms_borrow_requisitions
    SET status = 'partial_returned'
    WHERE id = p_borrow_id AND status <> 'partial_returned';
  END IF;
END;
$$;

-- 5c. Write-off borrow: deduct stock + FIFO consume + waste movement
CREATE OR REPLACE FUNCTION write_off_borrow_requisition(
  p_borrow_id UUID,
  p_items     JSONB,
  p_user_id   UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status      TEXT;
  v_item        JSONB;
  v_product_id  UUID;
  v_wo_qty      NUMERIC;
  v_borrow_item RECORD;
  v_movement_id UUID;
  v_all_done    BOOLEAN;
BEGIN
  SELECT status INTO v_status FROM wms_borrow_requisitions WHERE id = p_borrow_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการยืม'; END IF;
  IF v_status NOT IN ('approved', 'partial_returned', 'overdue') THEN
    RAISE EXCEPTION 'ไม่สามารถตัดเป็นของเสียได้ (status: %)', v_status;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_wo_qty     := (v_item->>'write_off_qty')::NUMERIC;
    IF v_wo_qty IS NULL OR v_wo_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_borrow_item
    FROM wms_borrow_requisition_items
    WHERE borrow_requisition_id = p_borrow_id AND product_id = v_product_id;

    IF v_borrow_item IS NULL THEN CONTINUE; END IF;
    IF v_borrow_item.returned_qty + v_borrow_item.written_off_qty + v_wo_qty > v_borrow_item.qty THEN
      RAISE EXCEPTION 'จำนวนตัดเสียเกินจำนวนที่ยืม (สินค้า: %)', v_product_id;
    END IF;

    UPDATE wms_borrow_requisition_items
    SET written_off_qty = written_off_qty + v_wo_qty
    WHERE id = v_borrow_item.id;

    UPDATE inv_stock_balances
    SET on_hand  = COALESCE(on_hand, 0) - v_wo_qty,
        reserved = GREATEST(COALESCE(reserved, 0) - v_wo_qty, 0)
    WHERE product_id = v_product_id;

    INSERT INTO inv_stock_movements (
      product_id, movement_type, qty, ref_type, ref_id, note, created_by
    )
    VALUES (
      v_product_id, 'waste', -v_wo_qty,
      'wms_borrow_requisitions', p_borrow_id,
      'ตัดเป็นของเสีย (ยืมแล้วคืนไม่ได้)', p_user_id
    )
    RETURNING id INTO v_movement_id;

    PERFORM fn_consume_stock_fifo(v_product_id, v_wo_qty, v_movement_id);
    PERFORM fn_recalc_product_landed_cost(v_product_id);
  END LOOP;

  SELECT NOT EXISTS (
    SELECT 1 FROM wms_borrow_requisition_items
    WHERE borrow_requisition_id = p_borrow_id
      AND (returned_qty + written_off_qty) < qty
  ) INTO v_all_done;

  IF v_all_done THEN
    UPDATE wms_borrow_requisitions
    SET status = 'written_off', returned_at = NOW()
    WHERE id = p_borrow_id;
  END IF;
END;
$$;

-- 5d. Reject borrow
CREATE OR REPLACE FUNCTION reject_borrow_requisition(
  p_borrow_id UUID,
  p_user_id   UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   TEXT;
  v_status TEXT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = p_user_id;
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','manager') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ปฏิเสธรายการยืม';
  END IF;

  SELECT status INTO v_status FROM wms_borrow_requisitions WHERE id = p_borrow_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการยืม'; END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'รายการนี้ไม่อยู่ในสถานะรออนุมัติ (status: %)', v_status;
  END IF;

  UPDATE wms_borrow_requisitions
  SET status = 'rejected', approved_by = p_user_id, approved_at = NOW()
  WHERE id = p_borrow_id;
END;
$$;
