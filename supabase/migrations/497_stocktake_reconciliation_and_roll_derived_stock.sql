-- Separate ordinary FIFO adjustments from absolute stocktake reconciliation.
-- Stocktake documents set the counted quantity as the new source of truth,
-- repair FIFO lots to match balances, and derive mapped FG sheets from RM rolls.

BEGIN;

ALTER TABLE public.inv_adjustments
  DROP CONSTRAINT IF EXISTS inv_adjustments_adjustment_type_chk;

ALTER TABLE public.inv_adjustments
  ADD CONSTRAINT inv_adjustments_adjustment_type_chk
  CHECK (adjustment_type IN ('audit_adjustment', 'stocktake_reconcile', 'safety_reclass'));

ALTER TABLE public.inv_adjustment_items
  ADD COLUMN IF NOT EXISTS is_system_generated boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.fn_reconcile_stocktake_product(
  p_product_id uuid,
  p_target_on_hand numeric,
  p_target_safety numeric,
  p_adjustment_id uuid,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_current_on_hand numeric := 0;
  v_current_safety numeric := 0;
  v_total_delta numeric;
  v_normal_lot_qty numeric := 0;
  v_safety_lot_qty numeric := 0;
  v_lot_delta numeric;
  v_remaining numeric;
  v_consume numeric;
  v_unit_cost numeric := 0;
  v_movement_id uuid;
  v_lot record;
BEGIN
  IF p_target_on_hand IS NULL OR p_target_safety IS NULL
     OR p_target_on_hand < 0 OR p_target_safety < 0 THEN
    RAISE EXCEPTION 'Invalid stocktake target for product %', p_product_id;
  END IF;

  INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
  VALUES (p_product_id, 0, 0, 0)
  ON CONFLICT (product_id) DO NOTHING;

  SELECT COALESCE(on_hand, 0), COALESCE(safety_stock, 0)
  INTO v_current_on_hand, v_current_safety
  FROM public.inv_stock_balances
  WHERE product_id = p_product_id
  FOR UPDATE;

  SELECT COALESCE(
    NULLIF(public.fn_get_current_avg_cost(p_product_id), 0),
    NULLIF(p.landed_cost, 0),
    NULLIF(p.unit_cost, 0),
    0
  )
  INTO v_unit_cost
  FROM public.pr_products p
  WHERE p.id = p_product_id;

  v_total_delta := (p_target_on_hand + p_target_safety)
    - (v_current_on_hand + v_current_safety);

  INSERT INTO public.inv_stock_movements (
    product_id, movement_type, qty, ref_type, ref_id, note,
    created_by, unit_cost, total_cost
  )
  VALUES (
    p_product_id, 'stocktake_reconcile', v_total_delta,
    'inv_adjustments', p_adjustment_id, p_note,
    auth.uid(), v_unit_cost, v_total_delta * v_unit_cost
  )
  RETURNING id INTO v_movement_id;

  -- Reconcile normal FIFO lots independently from the possibly stale balance.
  SELECT COALESCE(SUM(qty_remaining), 0)
  INTO v_normal_lot_qty
  FROM public.inv_stock_lots
  WHERE product_id = p_product_id
    AND qty_remaining > 0
    AND COALESCE(is_safety_stock, false) IS false;

  v_lot_delta := p_target_on_hand - v_normal_lot_qty;
  IF v_lot_delta > 0 THEN
    INSERT INTO public.inv_stock_lots (
      product_id, qty_initial, qty_remaining, unit_cost,
      ref_type, ref_id, is_safety_stock
    )
    VALUES (
      p_product_id, v_lot_delta, v_lot_delta, v_unit_cost,
      'stocktake_reconcile', p_adjustment_id, false
    );
  ELSIF v_lot_delta < 0 THEN
    v_remaining := ABS(v_lot_delta);
    FOR v_lot IN
      SELECT id, qty_remaining, unit_cost
      FROM public.inv_stock_lots
      WHERE product_id = p_product_id
        AND qty_remaining > 0
        AND COALESCE(is_safety_stock, false) IS false
      ORDER BY created_at, id
      FOR UPDATE
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_consume := LEAST(v_lot.qty_remaining, v_remaining);
      UPDATE public.inv_stock_lots
      SET qty_remaining = qty_remaining - v_consume
      WHERE id = v_lot.id;
      INSERT INTO public.inv_lot_consumptions (lot_id, movement_id, qty, unit_cost)
      VALUES (v_lot.id, v_movement_id, v_consume, v_lot.unit_cost);
      v_remaining := v_remaining - v_consume;
    END LOOP;
  END IF;

  -- Reconcile the safety-stock FIFO pool in the same transaction.
  SELECT COALESCE(SUM(qty_remaining), 0)
  INTO v_safety_lot_qty
  FROM public.inv_stock_lots
  WHERE product_id = p_product_id
    AND qty_remaining > 0
    AND COALESCE(is_safety_stock, false) IS true;

  v_lot_delta := p_target_safety - v_safety_lot_qty;
  IF v_lot_delta > 0 THEN
    INSERT INTO public.inv_stock_lots (
      product_id, qty_initial, qty_remaining, unit_cost,
      ref_type, ref_id, is_safety_stock
    )
    VALUES (
      p_product_id, v_lot_delta, v_lot_delta, v_unit_cost,
      'stocktake_reconcile', p_adjustment_id, true
    );
  ELSIF v_lot_delta < 0 THEN
    v_remaining := ABS(v_lot_delta);
    FOR v_lot IN
      SELECT id, qty_remaining, unit_cost
      FROM public.inv_stock_lots
      WHERE product_id = p_product_id
        AND qty_remaining > 0
        AND COALESCE(is_safety_stock, false) IS true
      ORDER BY created_at, id
      FOR UPDATE
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_consume := LEAST(v_lot.qty_remaining, v_remaining);
      UPDATE public.inv_stock_lots
      SET qty_remaining = qty_remaining - v_consume
      WHERE id = v_lot.id;
      INSERT INTO public.inv_lot_consumptions (lot_id, movement_id, qty, unit_cost)
      VALUES (v_lot.id, v_movement_id, v_consume, v_lot.unit_cost);
      v_remaining := v_remaining - v_consume;
    END LOOP;
  END IF;

  UPDATE public.inv_stock_balances
  SET on_hand = p_target_on_hand,
      safety_stock = p_target_safety,
      updated_at = now()
  WHERE product_id = p_product_id;

  PERFORM public.fn_recalc_product_landed_cost(p_product_id);

  RETURN jsonb_build_object(
    'before_on_hand', v_current_on_hand,
    'before_safety', v_current_safety,
    'after_on_hand', p_target_on_hand,
    'after_safety', p_target_safety,
    'qty_delta', v_total_delta,
    'unit_cost', v_unit_cost
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_reconcile_stocktake_product(uuid, numeric, numeric, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_reconcile_stocktake_product(uuid, numeric, numeric, uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.rpc_create_inventory_adjustment(
  p_adjustment_type text,
  p_reason_code text,
  p_note text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
  v_adjustment_id uuid;
  v_adjust_no text;
  v_today text;
  v_seq integer;
  v_input record;
  v_product record;
  v_current_on_hand numeric;
  v_current_safety numeric;
  v_target_on_hand numeric;
  v_target_safety numeric;
  v_qty_delta numeric;
  v_item_count integer := 0;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT u.role INTO v_role
    FROM public.us_users u
    WHERE u.id = auth.uid() AND u.is_active IS TRUE;
    IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'manager', 'store') THEN
      RAISE EXCEPTION 'Not authorized to create an inventory adjustment';
    END IF;
  END IF;

  IF p_adjustment_type IS NULL OR p_adjustment_type NOT IN (
    'audit_adjustment', 'stocktake_reconcile', 'safety_reclass'
  ) THEN
    RAISE EXCEPTION 'Invalid inventory adjustment type';
  END IF;
  IF btrim(COALESCE(p_note, '')) = '' THEN
    RAISE EXCEPTION 'Inventory adjustment note is required';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Inventory adjustment must contain at least one item';
  END IF;
  IF jsonb_array_length(p_items) > 5000 THEN
    RAISE EXCEPTION 'Inventory adjustment contains too many items';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items) AS x(product_id uuid, target_on_hand numeric, target_safety numeric)
    GROUP BY x.product_id
    HAVING x.product_id IS NULL OR count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Inventory adjustment contains an invalid or duplicate product';
  END IF;

  -- A derived roll FG is never a stocktake input. Its target is generated from RM.
  IF p_adjustment_type = 'stocktake_reconcile' AND EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items) AS x(product_id uuid, target_on_hand numeric, target_safety numeric)
    JOIN public.roll_material_configs c ON c.fg_product_id = x.product_id
  ) THEN
    RAISE EXCEPTION 'Derived roll FG cannot be entered in a stocktake; enter its mapped RM instead';
  END IF;

  -- One RM mapped to several FG formulas is ambiguous and must be fixed first.
  IF p_adjustment_type = 'stocktake_reconcile' AND EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items) AS x(product_id uuid, target_on_hand numeric, target_safety numeric)
    JOIN public.roll_material_config_rms m ON m.rm_product_id = x.product_id
    GROUP BY x.product_id
    HAVING count(DISTINCT m.config_id) > 1
  ) THEN
    RAISE EXCEPTION 'A roll RM is mapped to more than one FG formula';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('inventory_adjustment_no_gen'));
  v_today := to_char(clock_timestamp() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD');
  SELECT COALESCE(MAX(split_part(a.adjust_no, '-', 3)::integer), 0) + 1
  INTO v_seq
  FROM public.inv_adjustments a
  WHERE a.adjust_no ~ ('^ADJ-' || v_today || '-[0-9]+$');
  v_adjust_no := 'ADJ-' || v_today || '-' || lpad(v_seq::text, 3, '0');

  INSERT INTO public.inv_adjustments (
    adjust_no, status, adjustment_type, reason_code, created_by, note
  ) VALUES (
    v_adjust_no, 'pending', p_adjustment_type,
    NULLIF(btrim(COALESCE(p_reason_code, '')), ''), auth.uid(), btrim(p_note)
  ) RETURNING id INTO v_adjustment_id;

  PERFORM 1
  FROM public.inv_stock_balances b
  JOIN (
    SELECT x.product_id
    FROM jsonb_to_recordset(p_items) AS x(product_id uuid, target_on_hand numeric, target_safety numeric)
  ) requested ON requested.product_id = b.product_id
  ORDER BY b.product_id
  FOR UPDATE OF b;

  FOR v_input IN
    SELECT x.product_id, x.target_on_hand, x.target_safety
    FROM jsonb_to_recordset(p_items) AS x(
      product_id uuid, target_on_hand numeric, target_safety numeric
    )
    ORDER BY x.product_id
  LOOP
    SELECT p.id, p.product_code, p.product_name INTO v_product
    FROM public.pr_products p
    WHERE p.id = v_input.product_id AND p.is_active IS TRUE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_input.product_id;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.wh_sub_wms_map_spares s
      WHERE s.product_id = v_input.product_id
    ) THEN
      RAISE EXCEPTION 'Product % must be adjusted through its linked production SKU', v_product.product_code;
    END IF;

    SELECT COALESCE(b.on_hand, 0), COALESCE(b.safety_stock, 0)
    INTO v_current_on_hand, v_current_safety
    FROM public.inv_stock_balances b
    WHERE b.product_id = v_input.product_id;
    IF NOT FOUND THEN
      v_current_on_hand := 0;
      v_current_safety := 0;
    END IF;

    v_target_safety := COALESCE(v_input.target_safety, v_current_safety);
    IF p_adjustment_type = 'safety_reclass' THEN
      v_target_on_hand := v_current_on_hand + v_current_safety - v_target_safety;
      v_qty_delta := 0;
    ELSE
      v_target_on_hand := v_input.target_on_hand;
      v_qty_delta := v_target_on_hand - v_current_on_hand;
    END IF;

    IF v_target_on_hand IS NULL OR v_target_safety IS NULL
       OR v_target_on_hand < 0 OR v_target_safety < 0 THEN
      RAISE EXCEPTION 'Invalid target quantity for product %', v_product.product_code;
    END IF;
    IF p_adjustment_type <> 'stocktake_reconcile'
       AND v_target_on_hand = v_current_on_hand AND v_target_safety = v_current_safety THEN
      CONTINUE;
    END IF;

    INSERT INTO public.inv_adjustment_items (
      adjustment_id, product_id, qty_delta, new_safety_stock, new_order_point,
      before_on_hand, after_on_hand, before_safety_stock, after_safety_stock,
      before_total_qty, after_total_qty, is_system_generated
    ) VALUES (
      v_adjustment_id, v_input.product_id, v_qty_delta, v_target_safety, NULL,
      v_current_on_hand, v_target_on_hand, v_current_safety, v_target_safety,
      v_current_on_hand + v_current_safety,
      v_target_on_hand + v_target_safety,
      false
    );
    v_item_count := v_item_count + 1;
  END LOOP;

  IF v_item_count = 0 THEN
    RAISE EXCEPTION 'Inventory adjustment has no changed items';
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'adjustment_id', v_adjustment_id,
    'adjust_no', v_adjust_no, 'status', 'pending', 'item_count', v_item_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_create_inventory_adjustment(text, text, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_create_inventory_adjustment(text, text, text, jsonb)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rpc_approve_inventory_adjustment(p_adjustment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
  v_adjustment public.inv_adjustments%ROWTYPE;
  v_item record;
  v_config record;
  v_item_count integer;
  v_target_on_hand numeric;
  v_target_safety numeric;
  v_target_total numeric;
  v_current_total numeric;
  v_total_delta numeric;
  v_derived_target numeric;
  v_result jsonb;
  v_generated_item_id uuid;
  v_stock_items jsonb := '[]'::jsonb;
  v_safety_releases jsonb := '[]'::jsonb;
  v_safety_increases jsonb := '[]'::jsonb;
  v_changed_count integer := 0;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT u.role INTO v_role FROM public.us_users u
    WHERE u.id = auth.uid() AND u.is_active IS TRUE;
    IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'manager', 'store') THEN
      RAISE EXCEPTION 'Not authorized to approve an inventory adjustment';
    END IF;
  END IF;

  SELECT * INTO v_adjustment FROM public.inv_adjustments
  WHERE id = p_adjustment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Inventory adjustment not found'; END IF;
  IF v_adjustment.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending inventory adjustment can be approved';
  END IF;
  SELECT count(*) INTO v_item_count FROM public.inv_adjustment_items
  WHERE adjustment_id = p_adjustment_id AND is_system_generated IS false;
  IF v_item_count = 0 THEN RAISE EXCEPTION 'Cannot approve an inventory adjustment with no items'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.inv_adjustment_items
    WHERE adjustment_id = p_adjustment_id
    GROUP BY product_id HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'Inventory adjustment contains duplicate products'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.inv_stock_movements
    WHERE ref_type = 'inv_adjustments' AND ref_id = p_adjustment_id
  ) THEN RAISE EXCEPTION 'This adjustment already has stock movements'; END IF;

  IF v_adjustment.adjustment_type = 'stocktake_reconcile' THEN
    IF EXISTS (
      SELECT 1
      FROM public.inv_adjustment_items i
      JOIN public.roll_material_configs c ON c.fg_product_id = i.product_id
      WHERE i.adjustment_id = p_adjustment_id AND i.is_system_generated IS false
    ) THEN
      RAISE EXCEPTION 'Derived roll FG cannot be entered in a stocktake; enter its mapped RM instead';
    END IF;

    FOR v_item IN
      SELECT i.* FROM public.inv_adjustment_items i
      WHERE i.adjustment_id = p_adjustment_id AND i.is_system_generated IS false
      ORDER BY i.product_id
    LOOP
      v_target_on_hand := COALESCE(v_item.after_on_hand, 0);
      v_target_safety := COALESCE(v_item.after_safety_stock, v_item.new_safety_stock, 0);
      SELECT COALESCE(b.on_hand, 0) + COALESCE(b.safety_stock, 0)
      INTO v_current_total FROM public.inv_stock_balances b
      WHERE b.product_id = v_item.product_id;
      v_current_total := COALESCE(v_current_total, 0);

      v_result := public.fn_reconcile_stocktake_product(
        v_item.product_id, v_target_on_hand, v_target_safety,
        p_adjustment_id, 'Stocktake reconciliation ' || v_adjustment.adjust_no
      );
      v_total_delta := (v_target_on_hand + v_target_safety) - v_current_total;
      UPDATE public.inv_adjustment_items
      SET approved_qty_delta = v_total_delta,
          approved_unit_cost = COALESCE((v_result->>'unit_cost')::numeric, 0),
          approved_total_cost_impact = v_total_delta * COALESCE((v_result->>'unit_cost')::numeric, 0)
      WHERE id = v_item.id;
      IF v_total_delta <> 0 THEN v_changed_count := v_changed_count + 1; END IF;
    END LOOP;

    -- RM is the source of truth. Recompute every affected FG from all mapped RM
    -- balances after the direct stocktake targets have been applied.
    FOR v_config IN
      SELECT DISTINCT c.id, c.fg_product_id, c.sheets_per_roll
      FROM public.roll_material_configs c
      JOIN public.roll_material_config_rms m ON m.config_id = c.id
      JOIN public.inv_adjustment_items i ON i.product_id = m.rm_product_id
      WHERE i.adjustment_id = p_adjustment_id
        AND i.is_system_generated IS false
      ORDER BY c.id
    LOOP
      IF COALESCE(v_config.sheets_per_roll, 0) <= 0 THEN
        RAISE EXCEPTION 'Roll formula has an invalid sheets-per-roll value for FG %', v_config.fg_product_id;
      END IF;

      SELECT ROUND(COALESCE(SUM(COALESCE(b.on_hand, 0)), 0) * v_config.sheets_per_roll, 2)
      INTO v_derived_target
      FROM public.roll_material_config_rms m
      LEFT JOIN public.inv_stock_balances b ON b.product_id = m.rm_product_id
      WHERE m.config_id = v_config.id;

      INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES (v_config.fg_product_id, 0, 0, 0)
      ON CONFLICT (product_id) DO NOTHING;
      SELECT COALESCE(on_hand, 0), COALESCE(safety_stock, 0)
      INTO v_current_total, v_target_safety
      FROM public.inv_stock_balances
      WHERE product_id = v_config.fg_product_id
      FOR UPDATE;

      INSERT INTO public.inv_adjustment_items (
        adjustment_id, product_id, qty_delta, new_safety_stock,
        before_on_hand, after_on_hand, before_safety_stock, after_safety_stock,
        before_total_qty, after_total_qty, is_system_generated
      ) VALUES (
        p_adjustment_id, v_config.fg_product_id, v_derived_target - v_current_total,
        v_target_safety, v_current_total, v_derived_target,
        v_target_safety, v_target_safety,
        v_current_total + v_target_safety, v_derived_target + v_target_safety, true
      )
      RETURNING id INTO v_generated_item_id;

      v_result := public.fn_reconcile_stocktake_product(
        v_config.fg_product_id, v_derived_target, v_target_safety,
        p_adjustment_id, 'Derived FG from counted RM ' || v_adjustment.adjust_no
      );
      v_total_delta := v_derived_target - v_current_total;
      UPDATE public.inv_adjustment_items
      SET approved_qty_delta = v_total_delta,
          approved_unit_cost = COALESCE((v_result->>'unit_cost')::numeric, 0),
          approved_total_cost_impact = v_total_delta * COALESCE((v_result->>'unit_cost')::numeric, 0)
      WHERE id = v_generated_item_id;
      IF v_total_delta <> 0 THEN v_changed_count := v_changed_count + 1; END IF;
    END LOOP;
  ELSE
    -- Preserve the existing ordinary-adjustment and safety-reclassification flow.
    INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    SELECT DISTINCT i.product_id, 0, 0, 0
    FROM public.inv_adjustment_items i WHERE i.adjustment_id = p_adjustment_id
    ON CONFLICT (product_id) DO NOTHING;

    FOR v_item IN
      SELECT i.*, COALESCE(b.on_hand, 0) AS current_on_hand,
             COALESCE(b.safety_stock, 0) AS current_safety
      FROM public.inv_adjustment_items i
      JOIN public.inv_stock_balances b ON b.product_id = i.product_id
      WHERE i.adjustment_id = p_adjustment_id
      ORDER BY i.created_at, i.id FOR UPDATE OF b
    LOOP
      v_target_on_hand := COALESCE(v_item.after_on_hand, v_item.current_on_hand + COALESCE(v_item.qty_delta, 0));
      v_target_safety := COALESCE(v_item.after_safety_stock, v_item.new_safety_stock, v_item.current_safety);
      v_target_total := COALESCE(v_item.after_total_qty, v_target_on_hand + v_target_safety);
      IF v_target_on_hand < 0 OR v_target_safety < 0 OR v_target_total < 0 THEN
        RAISE EXCEPTION 'Inventory adjustment has a negative target for product %', v_item.product_id;
      END IF;
      v_current_total := v_item.current_on_hand + v_item.current_safety;
      v_total_delta := v_target_total - v_current_total;
      UPDATE public.inv_adjustment_items SET approved_qty_delta = v_total_delta WHERE id = v_item.id;

      IF v_target_safety < v_item.current_safety THEN
        v_safety_releases := v_safety_releases || jsonb_build_array(jsonb_build_object(
          'product_id', v_item.product_id, 'safety_stock', v_target_safety));
      ELSIF v_target_safety > v_item.current_safety THEN
        v_safety_increases := v_safety_increases || jsonb_build_array(jsonb_build_object(
          'product_id', v_item.product_id, 'safety_stock', v_target_safety));
      END IF;
      IF v_total_delta <> 0 THEN
        v_stock_items := v_stock_items || jsonb_build_array(jsonb_build_object(
          'product_id', v_item.product_id, 'qty_delta', v_total_delta,
          'movement_type', 'adjust', 'ref_type', 'inv_adjustments',
          'ref_id', p_adjustment_id, 'note', 'Inventory adjustment ' || v_adjustment.adjust_no));
      END IF;
      IF v_total_delta <> 0 OR v_target_safety <> v_item.current_safety THEN
        v_changed_count := v_changed_count + 1;
      END IF;
    END LOOP;
    IF jsonb_array_length(v_safety_releases) > 0 THEN PERFORM public.bulk_update_safety_stock(v_safety_releases); END IF;
    IF jsonb_array_length(v_stock_items) > 0 THEN PERFORM public.bulk_adjust_stock(v_stock_items); END IF;
    IF jsonb_array_length(v_safety_increases) > 0 THEN PERFORM public.bulk_update_safety_stock(v_safety_increases); END IF;
  END IF;

  UPDATE public.inv_adjustments SET status = 'approved', approved_by = auth.uid(), approved_at = now()
  WHERE id = p_adjustment_id;
  SELECT count(*) INTO v_item_count FROM public.inv_adjustment_items WHERE adjustment_id = p_adjustment_id;
  RETURN jsonb_build_object(
    'success', true, 'adjustment_id', p_adjustment_id,
    'adjust_no', v_adjustment.adjust_no, 'status', 'approved',
    'item_count', v_item_count, 'changed_count', v_changed_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_approve_inventory_adjustment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_approve_inventory_adjustment(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.rpc_approve_inventory_adjustment(uuid) IS
  'Approves ordinary adjustments unchanged; stocktake documents reconcile absolute balances/FIFO and derive roll FG from RM.';

COMMIT;

NOTIFY pgrst, 'reload schema';
