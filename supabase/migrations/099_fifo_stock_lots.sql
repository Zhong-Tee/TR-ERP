-- ============================================
-- 099: FIFO Inventory Costing
-- Stock lots, FIFO consumption, cost tracking on all movements
-- ============================================

-- ═══════════════════════════════════════════
-- 1. NEW TABLES
-- ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS inv_stock_lots (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id    UUID NOT NULL REFERENCES pr_products(id),
  qty_initial   NUMERIC(12,2) NOT NULL,
  qty_remaining NUMERIC(12,2) NOT NULL,
  unit_cost     NUMERIC(14,4) NOT NULL DEFAULT 0,
  ref_type      TEXT,
  ref_id        UUID,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_lots_product ON inv_stock_lots(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_lots_ref ON inv_stock_lots(ref_type, ref_id);

CREATE TABLE IF NOT EXISTS inv_lot_consumptions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lot_id        UUID NOT NULL REFERENCES inv_stock_lots(id),
  movement_id   UUID NOT NULL REFERENCES inv_stock_movements(id),
  qty           NUMERIC(12,2) NOT NULL,
  unit_cost     NUMERIC(14,4) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lot_cons_lot ON inv_lot_consumptions(lot_id);
CREATE INDEX IF NOT EXISTS idx_lot_cons_movement ON inv_lot_consumptions(movement_id);

-- ═══════════════════════════════════════════
-- 2. ADD COST COLUMNS TO inv_stock_movements
-- ═══════════════════════════════════════════

ALTER TABLE inv_stock_movements ADD COLUMN IF NOT EXISTS unit_cost  NUMERIC(14,4);
ALTER TABLE inv_stock_movements ADD COLUMN IF NOT EXISTS total_cost NUMERIC(14,2);

-- ═══════════════════════════════════════════
-- 3. HELPER FUNCTIONS
-- ═══════════════════════════════════════════

-- 3a. Get weighted average cost of remaining lots for a product
CREATE OR REPLACE FUNCTION fn_get_current_avg_cost(p_product_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_avg NUMERIC;
BEGIN
  SELECT SUM(qty_remaining * unit_cost) / NULLIF(SUM(qty_remaining), 0)
  INTO v_avg
  FROM inv_stock_lots
  WHERE product_id = p_product_id AND qty_remaining > 0;

  RETURN COALESCE(v_avg, 0);
END;
$$;

-- 3b. Consume stock FIFO: deducts from oldest lots, records consumptions, updates movement cost
CREATE OR REPLACE FUNCTION fn_consume_stock_fifo(
  p_product_id  UUID,
  p_qty         NUMERIC,
  p_movement_id UUID
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_remaining   NUMERIC := p_qty;
  v_total_cost  NUMERIC := 0;
  v_lot         RECORD;
  v_consume     NUMERIC;
  v_unit_cost   NUMERIC;
BEGIN
  IF p_qty <= 0 THEN RETURN 0; END IF;

  FOR v_lot IN
    SELECT id, qty_remaining, unit_cost
    FROM inv_stock_lots
    WHERE product_id = p_product_id AND qty_remaining > 0
    ORDER BY created_at ASC
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_consume := LEAST(v_lot.qty_remaining, v_remaining);

    UPDATE inv_stock_lots
    SET qty_remaining = qty_remaining - v_consume
    WHERE id = v_lot.id;

    INSERT INTO inv_lot_consumptions (lot_id, movement_id, qty, unit_cost)
    VALUES (v_lot.id, p_movement_id, v_consume, v_lot.unit_cost);

    v_total_cost := v_total_cost + (v_consume * v_lot.unit_cost);
    v_remaining  := v_remaining - v_consume;
  END LOOP;

  v_unit_cost := CASE WHEN p_qty > 0 THEN v_total_cost / p_qty ELSE 0 END;

  UPDATE inv_stock_movements
  SET unit_cost  = v_unit_cost,
      total_cost = qty * v_unit_cost
  WHERE id = p_movement_id;

  RETURN v_total_cost;
END;
$$;

-- 3c. Recalculate weighted avg landed_cost on pr_products from remaining lots
CREATE OR REPLACE FUNCTION fn_recalc_product_landed_cost(p_product_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_avg NUMERIC;
BEGIN
  SELECT SUM(qty_remaining * unit_cost) / NULLIF(SUM(qty_remaining), 0)
  INTO v_avg
  FROM inv_stock_lots
  WHERE product_id = p_product_id AND qty_remaining > 0;

  UPDATE pr_products
  SET landed_cost = COALESCE(v_avg, 0)
  WHERE id = p_product_id;
END;
$$;

-- ═══════════════════════════════════════════
-- 4. REWRITE rpc_receive_gr (with FIFO lots)
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_receive_gr(
  p_po_id   UUID,
  p_items   JSONB,
  p_shipping JSONB DEFAULT '{}'::JSONB,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_gr_id          UUID;
  v_gr_no          TEXT;
  v_item           JSONB;
  v_has_shortage   BOOLEAN := FALSE;
  v_total_received NUMERIC := 0;
  v_dom_cost       NUMERIC(14,2);
  v_dom_cpp        NUMERIC(12,4);
  v_qty_recv       NUMERIC;
  v_qty_ord        NUMERIC;
  v_qty_short      NUMERIC;
  v_today          TEXT;
  v_seq            INT;
  v_all_fulfilled  BOOLEAN;
  v_intl_thb       NUMERIC;
  v_total_po_qty   NUMERIC;
  v_intl_cpp       NUMERIC;
  v_lot_rec        RECORD;
  v_lot_cost       NUMERIC;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inv_po WHERE id = p_po_id AND status IN ('ordered', 'partial')) THEN
    RAISE EXCEPTION 'PO ไม่อยู่ในสถานะที่รับสินค้าได้';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('gr_no_gen'));

  v_today := to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD');

  SELECT COALESCE(MAX(CAST(SPLIT_PART(gr_no, '-', 3) AS INTEGER)), 0) + 1
  INTO v_seq
  FROM inv_gr
  WHERE gr_no LIKE 'GR-' || v_today || '-___';

  v_gr_no := 'GR-' || v_today || '-' || lpad(v_seq::text, 3, '0');

  INSERT INTO inv_gr (
    gr_no, po_id, status, received_by, received_at, note,
    dom_shipping_company, dom_shipping_cost, shortage_note
  )
  VALUES (
    v_gr_no, p_po_id, 'received', p_user_id, NOW(), p_shipping->>'note',
    p_shipping->>'dom_shipping_company',
    (p_shipping->>'dom_shipping_cost')::NUMERIC,
    p_shipping->>'shortage_note'
  )
  RETURNING id INTO v_gr_id;

  -- Main loop: insert GR items, update stock, insert movements (cost set later)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty_recv  := (v_item->>'qty_received')::NUMERIC;
    v_qty_ord   := (v_item->>'qty_ordered')::NUMERIC;
    v_qty_short := GREATEST(v_qty_ord - v_qty_recv, 0);

    IF v_qty_short > 0 THEN
      v_has_shortage := TRUE;
    END IF;

    v_total_received := v_total_received + v_qty_recv;

    INSERT INTO inv_gr_items (gr_id, product_id, qty_received, qty_ordered, qty_shortage, shortage_note)
    VALUES (
      v_gr_id,
      (v_item->>'product_id')::UUID,
      v_qty_recv, v_qty_ord, v_qty_short,
      v_item->>'shortage_note'
    );

    UPDATE inv_po_items
    SET qty_received_total = qty_received_total + v_qty_recv
    WHERE po_id = p_po_id AND product_id = (v_item->>'product_id')::UUID;

    IF v_qty_recv > 0 THEN
      INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES ((v_item->>'product_id')::UUID, v_qty_recv, 0, 0)
      ON CONFLICT (product_id) DO UPDATE SET
        on_hand = inv_stock_balances.on_hand + v_qty_recv,
        updated_at = NOW();

      INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note, created_by)
      VALUES (
        (v_item->>'product_id')::UUID,
        'gr', v_qty_recv, 'inv_gr', v_gr_id,
        'รับเข้าจาก GR ' || v_gr_no, p_user_id
      );
    END IF;
  END LOOP;

  -- Domestic shipping per piece for THIS GR
  v_dom_cost := (p_shipping->>'dom_shipping_cost')::NUMERIC;
  v_dom_cpp  := CASE
    WHEN v_dom_cost IS NOT NULL AND v_dom_cost > 0 AND v_total_received > 0
    THEN v_dom_cost / v_total_received ELSE 0 END;

  IF v_dom_cost IS NOT NULL AND v_dom_cost > 0 AND v_total_received > 0 THEN
    UPDATE inv_gr SET dom_cost_per_piece = v_dom_cpp WHERE id = v_gr_id;
  END IF;

  -- International shipping per piece from PO
  SELECT COALESCE(intl_shipping_cost_thb, 0) INTO v_intl_thb FROM inv_po WHERE id = p_po_id;
  SELECT COALESCE(SUM(qty), 0) INTO v_total_po_qty FROM inv_po_items WHERE po_id = p_po_id;
  v_intl_cpp := CASE WHEN v_total_po_qty > 0 THEN v_intl_thb / v_total_po_qty ELSE 0 END;

  -- Create FIFO lots and set cost on movements
  FOR v_lot_rec IN
    SELECT sm.id AS movement_id, sm.product_id, sm.qty AS qty_recv,
           COALESCE(poi.unit_price, 0) AS unit_price
    FROM inv_stock_movements sm
    JOIN inv_po_items poi ON poi.po_id = p_po_id AND poi.product_id = sm.product_id
    WHERE sm.ref_type = 'inv_gr' AND sm.ref_id = v_gr_id
      AND sm.movement_type = 'gr' AND sm.qty > 0
  LOOP
    v_lot_cost := v_lot_rec.unit_price + v_intl_cpp + v_dom_cpp;

    INSERT INTO inv_stock_lots (product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id)
    VALUES (v_lot_rec.product_id, v_lot_rec.qty_recv, v_lot_rec.qty_recv, v_lot_cost, 'inv_gr', v_gr_id);

    UPDATE inv_stock_movements
    SET unit_cost  = v_lot_cost,
        total_cost = v_lot_rec.qty_recv * v_lot_cost
    WHERE id = v_lot_rec.movement_id;

    PERFORM fn_recalc_product_landed_cost(v_lot_rec.product_id);
  END LOOP;

  IF v_has_shortage THEN
    UPDATE inv_gr SET status = 'partial' WHERE id = v_gr_id;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM inv_po_items
    WHERE po_id = p_po_id
      AND (qty_received_total + COALESCE(resolution_qty, 0)) < qty
  ) INTO v_all_fulfilled;

  IF v_all_fulfilled THEN
    UPDATE inv_po SET status = 'received' WHERE id = p_po_id;
  ELSE
    UPDATE inv_po SET status = 'partial' WHERE id = p_po_id;
  END IF;

  RETURN jsonb_build_object(
    'id', v_gr_id,
    'gr_no', v_gr_no,
    'status', CASE WHEN v_has_shortage THEN 'partial' ELSE 'received' END,
    'total_received', v_total_received
  );
END;
$$;

-- ═══════════════════════════════════════════
-- 5. REWRITE WMS PICK TRIGGER (FIFO + cost)
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION inv_deduct_stock_on_wms_picked()
RETURNS TRIGGER AS $$
DECLARE
  v_product_id  UUID;
  v_movement_id UUID;
  v_avg_cost    NUMERIC;
BEGIN
  -- ── Pick: status → picked/correct ──
  IF NEW.status IN ('picked', 'correct')
     AND (OLD.status IS NULL OR OLD.status NOT IN ('picked', 'correct'))
  THEN
    SELECT id INTO v_product_id FROM pr_products WHERE product_code = NEW.product_code LIMIT 1;
    IF v_product_id IS NULL THEN RETURN NEW; END IF;

    UPDATE inv_stock_balances
      SET on_hand = COALESCE(on_hand, 0) - NEW.qty
      WHERE product_id = v_product_id;
    IF NOT FOUND THEN
      INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES (v_product_id, -NEW.qty, 0, 0);
    END IF;

    INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note)
    VALUES (v_product_id, 'pick', -NEW.qty, 'wms_orders', NEW.id, 'ตัดสต๊อคเมื่อจัดสินค้าแล้ว')
    RETURNING id INTO v_movement_id;

    PERFORM fn_consume_stock_fifo(v_product_id, NEW.qty, v_movement_id);
    PERFORM fn_recalc_product_landed_cost(v_product_id);
  END IF;

  -- ── Return pick: status picked/correct → wrong/not_find ──
  IF NEW.status IN ('wrong', 'not_find')
     AND OLD.status IN ('picked', 'correct')
  THEN
    SELECT id INTO v_product_id FROM pr_products WHERE product_code = NEW.product_code LIMIT 1;
    IF v_product_id IS NOT NULL THEN
      v_avg_cost := fn_get_current_avg_cost(v_product_id);

      UPDATE inv_stock_balances
        SET on_hand = COALESCE(on_hand, 0) + NEW.qty
        WHERE product_id = v_product_id;

      INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note, unit_cost, total_cost)
      VALUES (v_product_id, 'return_pick', NEW.qty, 'wms_orders', NEW.id,
              'คืนสต๊อคอัตโนมัติ — ตรวจแล้วสถานะ: ' || NEW.status,
              v_avg_cost, NEW.qty * v_avg_cost);

      INSERT INTO inv_stock_lots (product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id)
      VALUES (v_product_id, NEW.qty, NEW.qty, v_avg_cost, 'wms_orders', NEW.id);

      PERFORM fn_recalc_product_landed_cost(v_product_id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════
-- 6. REWRITE bulk_adjust_stock (FIFO lots)
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION bulk_adjust_stock(items JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  item            JSONB;
  v_product_id    UUID;
  v_qty_delta     NUMERIC(12,2);
  v_movement_type TEXT;
  v_ref_type      TEXT;
  v_ref_id        UUID;
  v_note          TEXT;
  v_movement_id   UUID;
  v_avg_cost      NUMERIC;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    v_product_id    := (item->>'product_id')::UUID;
    v_qty_delta     := (item->>'qty_delta')::NUMERIC;
    v_movement_type := item->>'movement_type';
    v_ref_type      := item->>'ref_type';
    v_ref_id        := CASE WHEN item->>'ref_id' IS NOT NULL THEN (item->>'ref_id')::UUID ELSE NULL END;
    v_note          := item->>'note';

    -- Upsert stock balance
    INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_product_id, v_qty_delta, 0, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET on_hand = inv_stock_balances.on_hand + v_qty_delta;

    v_avg_cost := fn_get_current_avg_cost(v_product_id);

    IF v_qty_delta > 0 THEN
      -- Stock IN → create lot at current avg cost (or 0 if first)
      INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note, unit_cost, total_cost)
      VALUES (v_product_id, v_movement_type, v_qty_delta, v_ref_type, v_ref_id, v_note,
              v_avg_cost, v_qty_delta * v_avg_cost);

      INSERT INTO inv_stock_lots (product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id)
      VALUES (v_product_id, v_qty_delta, v_qty_delta, v_avg_cost,
              COALESCE(v_ref_type, 'inv_adjustments'), v_ref_id);

    ELSIF v_qty_delta < 0 THEN
      -- Stock OUT → FIFO consume
      INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note)
      VALUES (v_product_id, v_movement_type, v_qty_delta, v_ref_type, v_ref_id, v_note)
      RETURNING id INTO v_movement_id;

      PERFORM fn_consume_stock_fifo(v_product_id, ABS(v_qty_delta), v_movement_id);
    ELSE
      -- Zero delta, just record the movement
      INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note, unit_cost, total_cost)
      VALUES (v_product_id, v_movement_type, 0, v_ref_type, v_ref_id, v_note, 0, 0);
    END IF;

    PERFORM fn_recalc_product_landed_cost(v_product_id);
  END LOOP;
END;
$$;

-- ═══════════════════════════════════════════
-- 7. REWRITE approve_return_requisition (FIFO lots)
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION approve_return_requisition(
  p_return_id UUID,
  p_user_id   UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     TEXT;
  v_status   TEXT;
  v_item     RECORD;
  v_avg_cost NUMERIC;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = p_user_id;
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','manager') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติรายการคืน (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT status INTO v_status FROM wms_return_requisitions WHERE id = p_return_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการคืน'; END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'รายการนี้ไม่อยู่ในสถานะรออนุมัติ (status: %)', v_status;
  END IF;

  FOR v_item IN
    SELECT product_id, qty
    FROM wms_return_requisition_items
    WHERE return_requisition_id = p_return_id
  LOOP
    v_avg_cost := fn_get_current_avg_cost(v_item.product_id);

    INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_item.product_id, v_item.qty, 0, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET on_hand = inv_stock_balances.on_hand + v_item.qty;

    INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note, unit_cost, total_cost)
    VALUES (
      v_item.product_id, 'return_requisition', v_item.qty,
      'wms_return_requisitions', p_return_id,
      'อนุมัติใบคืน (RPC)', v_avg_cost, v_item.qty * v_avg_cost
    );

    INSERT INTO inv_stock_lots (product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id)
    VALUES (v_item.product_id, v_item.qty, v_item.qty, v_avg_cost,
            'wms_return_requisitions', p_return_id);

    PERFORM fn_recalc_product_landed_cost(v_item.product_id);
  END LOOP;

  UPDATE wms_return_requisitions
  SET status = 'approved', approved_by = p_user_id, approved_at = NOW()
  WHERE id = p_return_id;
END;
$$;

-- ═══════════════════════════════════════════
-- 8. NEW RPC: record waste cost (no stock change)
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_record_waste_cost(
  p_items  JSONB,
  p_ref_id UUID DEFAULT NULL,
  p_user_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_item       JSONB;
  v_product_id UUID;
  v_qty        NUMERIC;
  v_avg_cost   NUMERIC;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_qty        := (v_item->>'qty')::NUMERIC;

    IF v_qty IS NULL OR v_qty <= 0 THEN CONTINUE; END IF;

    v_avg_cost := fn_get_current_avg_cost(v_product_id);

    INSERT INTO inv_stock_movements (
      product_id, movement_type, qty, ref_type, ref_id, note, created_by,
      unit_cost, total_cost
    )
    VALUES (
      v_product_id, 'waste', -v_qty, 'inv_returns', p_ref_id,
      'ตีเป็นของเสีย', p_user_id,
      v_avg_cost, -v_qty * v_avg_cost
    );
  END LOOP;
END;
$$;

-- ═══════════════════════════════════════════
-- 9. REWRITE rpc_recalc_po_landed_cost (update lot costs when PO shipping changes)
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_update_product_landed_costs(p_po_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total_po_qty  NUMERIC;
  v_intl_thb      NUMERIC;
  v_intl_cpp      NUMERIC;
  v_gr_rec        RECORD;
  v_dom_cpp       NUMERIC;
  v_gr_total_recv NUMERIC;
  v_lot_rec       RECORD;
  v_unit_price    NUMERIC;
BEGIN
  SELECT COALESCE(SUM(qty), 0) INTO v_total_po_qty FROM inv_po_items WHERE po_id = p_po_id;
  IF v_total_po_qty = 0 THEN RETURN; END IF;

  SELECT COALESCE(intl_shipping_cost_thb, 0) INTO v_intl_thb FROM inv_po WHERE id = p_po_id;
  v_intl_cpp := v_intl_thb / v_total_po_qty;

  FOR v_gr_rec IN
    SELECT gr.id AS gr_id, COALESCE(gr.dom_shipping_cost, 0) AS dom_cost
    FROM inv_gr gr WHERE gr.po_id = p_po_id
  LOOP
    SELECT COALESCE(SUM(qty_received), 0) INTO v_gr_total_recv
    FROM inv_gr_items WHERE gr_id = v_gr_rec.gr_id;

    v_dom_cpp := CASE WHEN v_gr_total_recv > 0 THEN v_gr_rec.dom_cost / v_gr_total_recv ELSE 0 END;

    FOR v_lot_rec IN
      SELECT sl.id AS lot_id, sl.product_id
      FROM inv_stock_lots sl
      WHERE sl.ref_type = 'inv_gr' AND sl.ref_id = v_gr_rec.gr_id
    LOOP
      SELECT COALESCE(unit_price, 0) INTO v_unit_price
      FROM inv_po_items
      WHERE po_id = p_po_id AND product_id = v_lot_rec.product_id
      LIMIT 1;

      UPDATE inv_stock_lots
      SET unit_cost = v_unit_price + v_intl_cpp + v_dom_cpp
      WHERE id = v_lot_rec.lot_id;
    END LOOP;
  END LOOP;

  -- Recalc landed_cost for all products in this PO
  FOR v_lot_rec IN
    SELECT DISTINCT product_id FROM inv_po_items WHERE po_id = p_po_id
  LOOP
    PERFORM fn_recalc_product_landed_cost(v_lot_rec.product_id);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION rpc_recalc_po_landed_cost(p_po_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM fn_update_product_landed_costs(p_po_id);
END;
$$;

-- ═══════════════════════════════════════════
-- 10. BACKFILL: create initial lots from existing stock
-- ═══════════════════════════════════════════

DO $$
DECLARE
  v_rec RECORD;
  v_cost NUMERIC;
BEGIN
  FOR v_rec IN
    SELECT sb.product_id, sb.on_hand,
           COALESCE(pp.landed_cost, pp.unit_cost, 0) AS best_cost
    FROM inv_stock_balances sb
    JOIN pr_products pp ON pp.id = sb.product_id
    WHERE sb.on_hand > 0
  LOOP
    v_cost := CASE WHEN v_rec.best_cost > 0 THEN v_rec.best_cost ELSE 0 END;

    INSERT INTO inv_stock_lots (product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id)
    VALUES (v_rec.product_id, v_rec.on_hand, v_rec.on_hand, v_cost, 'backfill', NULL);

    UPDATE pr_products SET landed_cost = v_cost WHERE id = v_rec.product_id;
  END LOOP;
END;
$$;
