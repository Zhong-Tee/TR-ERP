-- 156: Remove cost_per_sheet usage from roll auto FG conversion
-- - UI no longer edits cost_per_sheet in Roll Material Calculator
-- - Auto FG movement/lot cost now uses current FG average cost only

CREATE OR REPLACE FUNCTION fn_auto_convert_rm_to_fg_on_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg RECORD;
  v_fg_qty NUMERIC(12,2);
  v_unit_cost NUMERIC(14,4);
  v_movement_id UUID;
  v_note TEXT;
BEGIN
  IF NEW.movement_type NOT IN ('gr', 'adjust') THEN
    RETURN NEW;
  END IF;

  SELECT
    c.fg_product_id,
    c.sheets_per_roll
  INTO v_cfg
  FROM roll_material_config_rms m
  JOIN roll_material_configs c ON c.id = m.config_id
  JOIN pr_products rm ON rm.id = m.rm_product_id
  JOIN pr_products fg ON fg.id = c.fg_product_id
  WHERE m.rm_product_id = NEW.product_id
    AND rm.product_type = 'RM'
    AND fg.product_type = 'FG'
    AND COALESCE(c.sheets_per_roll, 0) > 0
  ORDER BY c.updated_at DESC, c.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_fg_qty := ROUND(COALESCE(NEW.qty, 0) * v_cfg.sheets_per_roll, 2);
  IF COALESCE(v_fg_qty, 0) = 0 THEN
    RETURN NEW;
  END IF;

  v_note := format(
    'Auto FG from RM (%s): RM qty %s x sheets_per_roll %s',
    COALESCE(NEW.product_id::TEXT, '-'),
    COALESCE(NEW.qty::TEXT, '0'),
    COALESCE(v_cfg.sheets_per_roll::TEXT, '0')
  );

  INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
  VALUES (v_cfg.fg_product_id, v_fg_qty, 0, 0)
  ON CONFLICT (product_id) DO UPDATE
    SET on_hand = inv_stock_balances.on_hand + v_fg_qty,
        updated_at = NOW();

  IF v_fg_qty > 0 THEN
    v_unit_cost := COALESCE(fn_get_current_avg_cost(v_cfg.fg_product_id), 0);

    INSERT INTO inv_stock_movements (
      product_id, movement_type, qty, ref_type, ref_id, note, created_by, unit_cost, total_cost
    )
    VALUES (
      v_cfg.fg_product_id,
      'roll_auto_fg',
      v_fg_qty,
      COALESCE(NEW.ref_type, 'roll_auto_fg'),
      NEW.ref_id,
      v_note,
      NEW.created_by,
      v_unit_cost,
      v_fg_qty * v_unit_cost
    );

    INSERT INTO inv_stock_lots (
      product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id
    )
    VALUES (
      v_cfg.fg_product_id,
      v_fg_qty,
      v_fg_qty,
      v_unit_cost,
      COALESCE(NEW.ref_type, 'roll_auto_fg'),
      NEW.ref_id
    );
  ELSE
    INSERT INTO inv_stock_movements (
      product_id, movement_type, qty, ref_type, ref_id, note, created_by
    )
    VALUES (
      v_cfg.fg_product_id,
      'roll_auto_fg',
      v_fg_qty,
      COALESCE(NEW.ref_type, 'roll_auto_fg'),
      NEW.ref_id,
      v_note,
      NEW.created_by
    )
    RETURNING id INTO v_movement_id;

    PERFORM fn_consume_stock_fifo(v_cfg.fg_product_id, ABS(v_fg_qty), v_movement_id);
  END IF;

  PERFORM fn_recalc_product_landed_cost(v_cfg.fg_product_id);

  RETURN NEW;
END;
$$;
