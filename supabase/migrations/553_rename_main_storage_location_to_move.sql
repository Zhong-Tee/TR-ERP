-- Rename the primary warehouse location code from MAIN to MOVE.
-- The location UUID is preserved, so balances and transfer history remain linked.

BEGIN;

DO $$
DECLARE
  v_main_id UUID;
  v_move_id UUID;
BEGIN
  SELECT id INTO v_main_id
  FROM public.wh_storage_locations
  WHERE LOWER(BTRIM(code)) = 'main'
  LIMIT 1;

  SELECT id INTO v_move_id
  FROM public.wh_storage_locations
  WHERE LOWER(BTRIM(code)) = 'move'
  LIMIT 1;

  IF v_main_id IS NOT NULL AND v_move_id IS NOT NULL AND v_main_id <> v_move_id THEN
    RAISE EXCEPTION 'ไม่สามารถเปลี่ยน MAIN เป็น MOVE ได้ เนื่องจากมีรหัส MOVE อยู่แล้ว';
  END IF;

  IF v_main_id IS NOT NULL THEN
    UPDATE public.wh_storage_locations
    SET code = 'MOVE', updated_at = NOW()
    WHERE id = v_main_id;
  ELSIF v_move_id IS NULL THEN
    INSERT INTO public.wh_storage_locations(code, name, location_type, sort_order)
    VALUES ('MOVE', 'จุดหยิบหลัก', 'picking', 0);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_apply_location_stock_delta(
  p_product_id UUID,
  p_qty_delta NUMERIC
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_remaining NUMERIC := ABS(COALESCE(p_qty_delta, 0));
  v_location_id UUID;
  v_take NUMERIC;
  v_row RECORD;
BEGIN
  IF COALESCE(p_qty_delta, 0) = 0 THEN RETURN; END IF;

  SELECT id INTO v_location_id
  FROM public.wh_storage_locations
  WHERE is_active
  ORDER BY CASE location_type WHEN 'picking' THEN 0 WHEN 'unallocated' THEN 1 ELSE 2 END,
           sort_order, code
  LIMIT 1;

  IF v_location_id IS NULL THEN
    INSERT INTO public.wh_storage_locations(code, name, location_type, sort_order)
    VALUES ('MOVE', 'จุดจัดเก็บหลัก', 'picking', 0)
    ON CONFLICT ((LOWER(BTRIM(code)))) DO UPDATE SET is_active = true
    RETURNING id INTO v_location_id;
  END IF;

  IF p_qty_delta > 0 THEN
    INSERT INTO public.wh_location_stock(product_id, location_id, qty)
    VALUES (p_product_id, v_location_id, p_qty_delta)
    ON CONFLICT (product_id, location_id) DO UPDATE
      SET qty = public.wh_location_stock.qty + EXCLUDED.qty, updated_at = NOW();
    RETURN;
  END IF;

  FOR v_row IN
    SELECT stock.location_id, stock.qty
    FROM public.wh_location_stock stock
    JOIN public.wh_storage_locations location ON location.id = stock.location_id
    WHERE stock.product_id = p_product_id AND stock.qty > 0
    ORDER BY CASE location.location_type WHEN 'picking' THEN 0 WHEN 'unallocated' THEN 1 ELSE 2 END,
             location.sort_order, location.code
    FOR UPDATE OF stock
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_remaining, v_row.qty);
    UPDATE public.wh_location_stock
    SET qty = qty - v_take, updated_at = NOW()
    WHERE product_id = p_product_id AND location_id = v_row.location_id;
    v_remaining := v_remaining - v_take;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.fn_apply_location_stock_delta(UUID, NUMERIC) IS
  'Applies Movement deltas to physical locations; creates MOVE as the primary location when none exists.';

COMMIT;
