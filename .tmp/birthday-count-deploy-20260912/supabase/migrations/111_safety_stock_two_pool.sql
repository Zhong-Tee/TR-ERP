-- ============================================
-- 111: Safety Stock Two-Pool Model
-- แยก safety stock เป็นสินค้าจริง มี lot + ต้นทุนติดตาม
-- FIFO ป้องกันไม่ให้ตัด safety lot
-- ============================================

-- ═══════════════════════════════════════════
-- 1. แก้ fn_consume_stock_fifo — เพิ่ม filter is_safety_stock = FALSE
-- ═══════════════════════════════════════════

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
    WHERE product_id = p_product_id
      AND qty_remaining > 0
      AND is_safety_stock = FALSE
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

-- ═══════════════════════════════════════════
-- 2. แก้ fn_get_current_avg_cost — คิดเฉพาะ lot ปกติ
-- ═══════════════════════════════════════════

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
  WHERE product_id = p_product_id
    AND qty_remaining > 0
    AND is_safety_stock = FALSE;

  RETURN COALESCE(v_avg, 0);
END;
$$;

-- ═══════════════════════════════════════════
-- 3. สร้าง fn_transfer_to_safety_stock (on_hand → safety)
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_transfer_to_safety_stock(
  p_product_id UUID,
  p_qty        NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_remaining    NUMERIC := p_qty;
  v_lot          RECORD;
  v_consume      NUMERIC;
  v_current_oh   NUMERIC;
BEGIN
  IF p_qty <= 0 THEN RETURN; END IF;

  SELECT COALESCE(on_hand, 0) INTO v_current_oh
  FROM inv_stock_balances WHERE product_id = p_product_id;

  IF NOT FOUND OR v_current_oh < p_qty THEN
    RAISE EXCEPTION 'on_hand ไม่เพียงพอสำหรับย้ายเข้า safety stock (ต้องการ %, มี %)',
      p_qty, COALESCE(v_current_oh, 0);
  END IF;

  FOR v_lot IN
    SELECT id, qty_remaining, unit_cost
    FROM inv_stock_lots
    WHERE product_id = p_product_id
      AND qty_remaining > 0
      AND is_safety_stock = FALSE
    ORDER BY created_at ASC
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_consume := LEAST(v_lot.qty_remaining, v_remaining);

    UPDATE inv_stock_lots
    SET qty_remaining = qty_remaining - v_consume
    WHERE id = v_lot.id;

    INSERT INTO inv_stock_lots (
      product_id, qty_initial, qty_remaining, unit_cost,
      ref_type, ref_id, is_safety_stock
    )
    VALUES (
      p_product_id, v_consume, v_consume, v_lot.unit_cost,
      'safety_transfer', v_lot.id, TRUE
    );

    v_remaining := v_remaining - v_consume;
  END LOOP;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'lot ปกติไม่เพียงพอสำหรับย้ายเข้า safety stock (ขาด %)', v_remaining;
  END IF;

  UPDATE inv_stock_balances
  SET on_hand      = on_hand - p_qty,
      safety_stock = safety_stock + p_qty,
      updated_at   = NOW()
  WHERE product_id = p_product_id;
END;
$$;

-- ═══════════════════════════════════════════
-- 4. สร้าง fn_release_safety_stock (safety → on_hand)
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_release_safety_stock(
  p_product_id UUID,
  p_qty        NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_remaining    NUMERIC := p_qty;
  v_lot          RECORD;
  v_consume      NUMERIC;
  v_current_ss   NUMERIC;
BEGIN
  IF p_qty <= 0 THEN RETURN; END IF;

  SELECT COALESCE(safety_stock, 0) INTO v_current_ss
  FROM inv_stock_balances WHERE product_id = p_product_id;

  IF NOT FOUND OR v_current_ss < p_qty THEN
    RAISE EXCEPTION 'safety stock ไม่เพียงพอสำหรับย้ายออก (ต้องการ %, มี %)',
      p_qty, COALESCE(v_current_ss, 0);
  END IF;

  FOR v_lot IN
    SELECT id, qty_remaining, unit_cost
    FROM inv_stock_lots
    WHERE product_id = p_product_id
      AND qty_remaining > 0
      AND is_safety_stock = TRUE
    ORDER BY created_at ASC
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_consume := LEAST(v_lot.qty_remaining, v_remaining);

    UPDATE inv_stock_lots
    SET qty_remaining = qty_remaining - v_consume
    WHERE id = v_lot.id;

    INSERT INTO inv_stock_lots (
      product_id, qty_initial, qty_remaining, unit_cost,
      ref_type, ref_id, is_safety_stock
    )
    VALUES (
      p_product_id, v_consume, v_consume, v_lot.unit_cost,
      'safety_release', v_lot.id, FALSE
    );

    v_remaining := v_remaining - v_consume;
  END LOOP;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'safety lot ไม่เพียงพอสำหรับย้ายออก (ขาด %)', v_remaining;
  END IF;

  UPDATE inv_stock_balances
  SET on_hand      = on_hand + p_qty,
      safety_stock = safety_stock - p_qty,
      updated_at   = NOW()
  WHERE product_id = p_product_id;
END;
$$;

-- ═══════════════════════════════════════════
-- 5. เขียน bulk_update_safety_stock ใหม่ (delta-based)
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION bulk_update_safety_stock(items JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  item           JSONB;
  v_product_id   UUID;
  v_new_safety   NUMERIC;
  v_current      NUMERIC;
  v_delta        NUMERIC;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    v_product_id := (item->>'product_id')::UUID;
    v_new_safety := (item->>'safety_stock')::NUMERIC;

    SELECT COALESCE(safety_stock, 0)
    INTO v_current
    FROM inv_stock_balances
    WHERE product_id = v_product_id;

    IF NOT FOUND THEN
      v_current := 0;
    END IF;

    v_delta := v_new_safety - v_current;

    IF v_delta > 0 THEN
      PERFORM fn_transfer_to_safety_stock(v_product_id, v_delta);
    ELSIF v_delta < 0 THEN
      PERFORM fn_release_safety_stock(v_product_id, ABS(v_delta));
    END IF;

    PERFORM fn_recalc_product_landed_cost(v_product_id);
  END LOOP;
END;
$$;
