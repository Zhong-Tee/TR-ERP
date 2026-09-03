-- Repair legacy discrepancies where the main balance has sellable stock but
-- normal FIFO lots are lower. WMS may consume only stock confirmed by on_hand;
-- genuine main-stock shortages remain blocked.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_consume_stock_fifo(
  p_product_id UUID,
  p_qty NUMERIC,
  p_movement_id UUID
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_remaining NUMERIC := p_qty;
  v_total_cost NUMERIC := 0;
  v_lot RECORD;
  v_consume NUMERIC;
  v_unit_cost NUMERIC;
BEGIN
  IF p_qty <= 0 THEN RETURN 0; END IF;

  FOR v_lot IN
    SELECT l.id, l.qty_remaining, l.unit_cost
    FROM public.inv_stock_lots l
    WHERE l.product_id = p_product_id
      AND l.qty_remaining > 0
      AND COALESCE(l.is_safety_stock, FALSE) IS FALSE
    ORDER BY l.created_at, l.id
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_consume := LEAST(v_lot.qty_remaining, v_remaining);
    UPDATE public.inv_stock_lots
    SET qty_remaining = qty_remaining - v_consume
    WHERE id = v_lot.id;
    INSERT INTO public.inv_lot_consumptions (lot_id, movement_id, qty, unit_cost)
    VALUES (v_lot.id, p_movement_id, v_consume, v_lot.unit_cost);
    v_total_cost := v_total_cost + (v_consume * v_lot.unit_cost);
    v_remaining := v_remaining - v_consume;
  END LOOP;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'insufficient sellable lots for product %, short by %', p_product_id, v_remaining;
  END IF;

  v_unit_cost := CASE WHEN p_qty > 0 THEN v_total_cost / p_qty ELSE 0 END;
  UPDATE public.inv_stock_movements
  SET unit_cost = v_unit_cost,
      total_cost = qty * v_unit_cost
  WHERE id = p_movement_id;
  RETURN v_total_cost;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_consume_stock_fifo(UUID, NUMERIC, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_consume_stock_fifo(UUID, NUMERIC, UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_reconcile_sellable_lots_to_on_hand(p_product_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_on_hand NUMERIC := 0;
  v_lot_qty NUMERIC := 0;
  v_missing NUMERIC := 0;
  v_unit_cost NUMERIC := 0;
BEGIN
  SELECT COALESCE(b.on_hand, 0)
  INTO v_on_hand
  FROM public.inv_stock_balances b
  WHERE b.product_id = p_product_id
  FOR UPDATE;

  -- Serialize repairs and FIFO consumption for this product.
  PERFORM 1
  FROM public.inv_stock_lots l
  WHERE l.product_id = p_product_id
    AND l.qty_remaining > 0
    AND COALESCE(l.is_safety_stock, FALSE) IS FALSE
  ORDER BY l.created_at, l.id
  FOR UPDATE;

  SELECT COALESCE(SUM(l.qty_remaining), 0)
  INTO v_lot_qty
  FROM public.inv_stock_lots l
  WHERE l.product_id = p_product_id
    AND l.qty_remaining > 0
    AND COALESCE(l.is_safety_stock, FALSE) IS FALSE;

  v_missing := GREATEST(v_on_hand - v_lot_qty, 0);
  IF v_missing <= 0 THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(
    NULLIF((
      SELECT SUM(l.qty_remaining * l.unit_cost) / NULLIF(SUM(l.qty_remaining), 0)
      FROM public.inv_stock_lots l
      WHERE l.product_id = p_product_id
        AND l.qty_remaining > 0
        AND COALESCE(l.is_safety_stock, FALSE) IS FALSE
    ), 0),
    NULLIF(p.landed_cost, 0), NULLIF(p.unit_cost, 0), 0
  )
  INTO v_unit_cost
  FROM public.pr_products p
  WHERE p.id = p_product_id;

  INSERT INTO public.inv_stock_lots (
    product_id, qty_initial, qty_remaining, unit_cost,
    ref_type, ref_id, is_safety_stock
  )
  VALUES (
    p_product_id, v_missing, v_missing, COALESCE(v_unit_cost, 0),
    'balance_lot_repair', p_product_id, FALSE
  );

  RETURN v_missing;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_reconcile_sellable_lots_to_on_hand(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_reconcile_sellable_lots_to_on_hand(UUID)
  TO service_role;

COMMENT ON FUNCTION public.fn_reconcile_sellable_lots_to_on_hand(UUID) IS
  'Creates only the missing normal FIFO layer up to the locked main on_hand balance; never increases stock balance.';

CREATE OR REPLACE FUNCTION public.inv_deduct_stock_on_wms_picked()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product_id UUID;
  v_product_code TEXT;
  v_product_name TEXT;
  v_movement_id UUID;
  v_stock_qty NUMERIC;
  v_on_hand NUMERIC := 0;
  v_reserved NUMERIC := 0;
  v_available_for_row NUMERIC := 0;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;

  SELECT p.id, p.product_code, p.product_name
  INTO v_product_id, v_product_code, v_product_name
  FROM public.pr_products p
  WHERE p.product_code = NEW.product_code
  LIMIT 1;

  IF v_product_id IS NULL THEN RETURN NEW; END IF;
  v_stock_qty := COALESCE(NEW.qty, 0);

  IF NEW.status = 'picked'
     AND (OLD.status IS NULL OR OLD.status NOT IN ('picked', 'correct'))
  THEN
    INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_product_id, 0, v_stock_qty, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET reserved = COALESCE(public.inv_stock_balances.reserved, 0) + v_stock_qty,
          updated_at = NOW();
  END IF;

  IF NEW.status = 'correct'
     AND (OLD.status IS NULL OR OLD.status <> 'correct')
  THEN
    INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_product_id, 0, 0, 0)
    ON CONFLICT (product_id) DO NOTHING;

    SELECT COALESCE(b.on_hand, 0), COALESCE(b.reserved, 0)
    INTO v_on_hand, v_reserved
    FROM public.inv_stock_balances b
    WHERE b.product_id = v_product_id
    FOR UPDATE;

    v_available_for_row := v_on_hand - v_reserved
      + CASE WHEN OLD.status = 'picked' THEN v_stock_qty ELSE 0 END;
    IF v_available_for_row < v_stock_qty THEN
      RAISE EXCEPTION 'สต๊อกพร้อมตัดของสินค้า % - % ไม่เพียงพอ ขาด % %',
        COALESCE(NULLIF(v_product_code, ''), v_product_id::TEXT),
        COALESCE(NULLIF(v_product_name, ''), NEW.product_name, '-'),
        v_stock_qty - v_available_for_row,
        COALESCE(NULLIF(BTRIM(NEW.unit_name), ''), 'หน่วย');
    END IF;

    -- Older imports/adjustments could update balances without creating a FIFO
    -- layer. Restore only that accounting layer; on_hand is unchanged here.
    PERFORM public.fn_reconcile_sellable_lots_to_on_hand(v_product_id);

    INSERT INTO public.inv_stock_movements (
      product_id, movement_type, qty, ref_type, ref_id, note
    )
    VALUES (
      v_product_id, 'pick', -v_stock_qty, 'wms_orders', NEW.id,
      'ตัดสต๊อกตามหน่วยสินค้า ' || COALESCE(NULLIF(BTRIM(NEW.unit_name), ''), 'ชิ้น')
    )
    RETURNING id INTO v_movement_id;

    PERFORM public.fn_consume_stock_fifo(v_product_id, v_stock_qty, v_movement_id);

    UPDATE public.inv_stock_balances
    SET on_hand = COALESCE(on_hand, 0) - v_stock_qty,
        reserved = GREATEST(COALESCE(reserved, 0) - v_stock_qty, 0),
        updated_at = NOW()
    WHERE product_id = v_product_id;

    PERFORM public.fn_recalc_product_landed_cost(v_product_id);
  END IF;

  IF NEW.status = 'out_of_stock' AND OLD.status = 'picked' THEN
    UPDATE public.inv_stock_balances
    SET reserved = GREATEST(COALESCE(reserved, 0) - v_stock_qty, 0),
        updated_at = NOW()
    WHERE product_id = v_product_id;
  END IF;

  IF NEW.status = 'returned' AND OLD.status IS DISTINCT FROM 'returned' THEN
    IF OLD.status = 'picked' THEN
      UPDATE public.inv_stock_balances
      SET reserved = GREATEST(COALESCE(reserved, 0) - v_stock_qty, 0),
          updated_at = NOW()
      WHERE product_id = v_product_id;
    ELSIF OLD.status = 'correct' THEN
      PERFORM public.fn_reverse_wms_stock(NEW.id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
