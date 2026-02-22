-- ============================================
-- 129: Fix FIFO Issues
-- 1. rpc_record_waste_cost now calls fn_consume_stock_fifo
-- 2. fn_consume_stock_fifo raises warning when lots insufficient
-- 3. fn_update_product_landed_costs uses total received qty instead of total ordered qty
-- ============================================

-- 1. Fix fn_consume_stock_fifo to raise a warning when lots are insufficient
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

  IF v_remaining > 0 THEN
    RAISE WARNING 'fn_consume_stock_fifo: insufficient lots for product %, short by % units', p_product_id, v_remaining;
  END IF;

  v_unit_cost := CASE WHEN (p_qty - v_remaining) > 0 THEN v_total_cost / (p_qty - v_remaining) ELSE 0 END;

  UPDATE inv_stock_movements
  SET unit_cost  = v_unit_cost,
      total_cost = qty * v_unit_cost
  WHERE id = p_movement_id;

  RETURN v_total_cost;
END;
$$;

-- 2. Fix rpc_record_waste_cost to consume FIFO lots and update stock balance
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
  v_movement_id UUID;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_qty        := (v_item->>'qty')::NUMERIC;

    IF v_qty IS NULL OR v_qty <= 0 THEN CONTINUE; END IF;

    INSERT INTO inv_stock_movements (
      product_id, movement_type, qty, ref_type, ref_id, note, created_by
    )
    VALUES (
      v_product_id, 'waste', -v_qty, 'inv_returns', p_ref_id,
      'ตีเป็นของเสีย', p_user_id
    )
    RETURNING id INTO v_movement_id;

    PERFORM fn_consume_stock_fifo(v_product_id, v_qty, v_movement_id);

    UPDATE inv_stock_balances
    SET on_hand = on_hand - v_qty
    WHERE product_id = v_product_id;

    PERFORM fn_recalc_product_landed_cost(v_product_id);
  END LOOP;
END;
$$;

-- 3. Fix fn_update_product_landed_costs to use total received qty for intl shipping allocation
CREATE OR REPLACE FUNCTION fn_update_product_landed_costs(p_po_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total_received_qty NUMERIC;
  v_intl_thb      NUMERIC;
  v_intl_cpp      NUMERIC;
  v_gr_rec        RECORD;
  v_dom_cpp       NUMERIC;
  v_gr_total_recv NUMERIC;
  v_lot_rec       RECORD;
  v_unit_price    NUMERIC;
BEGIN
  SELECT COALESCE(SUM(gi.qty_received), 0)
  INTO v_total_received_qty
  FROM inv_gr_items gi
  JOIN inv_gr g ON g.id = gi.gr_id
  WHERE g.po_id = p_po_id;

  IF v_total_received_qty = 0 THEN RETURN; END IF;

  SELECT COALESCE(intl_shipping_cost_thb, 0) INTO v_intl_thb FROM inv_po WHERE id = p_po_id;
  v_intl_cpp := v_intl_thb / v_total_received_qty;

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

  FOR v_lot_rec IN
    SELECT DISTINCT product_id FROM inv_po_items WHERE po_id = p_po_id
  LOOP
    PERFORM fn_recalc_product_landed_cost(v_lot_rec.product_id);
  END LOOP;
END;
$$;
