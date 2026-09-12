-- 255: Fix data reset under pg_safeupdate (UPDATE requires a WHERE clause)
-- Supabase may enable pg_safeupdate; unqualified UPDATE on pr_products was failing reset.

CREATE OR REPLACE FUNCTION rpc_data_reset_execute(
  p_operation_id UUID,
  p_confirm_text TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid UUID;
  v_op erp_data_operations%ROWTYPE;
  v_table TEXT;
  v_count BIGINT;
  v_truncate_tables TEXT := '';
  v_before JSONB := '[]'::JSONB;
  v_after JSONB := '[]'::JSONB;
  v_expected_confirm TEXT;
  v_epoch_id BIGINT;
  v_opening_products INT := 0;
BEGIN
  v_uid := erp_data_assert_superadmin();
  PERFORM pg_advisory_xact_lock(hashtext('erp_data_reset_execute'));
  PERFORM pg_advisory_xact_lock(hashtext('erp_data_operation:' || p_operation_id::TEXT));

  SELECT * INTO v_op FROM erp_data_operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบ operation';
  END IF;

  IF v_op.operation_type = 'backup_only' THEN
    RAISE EXCEPTION 'operation นี้เป็นสำรองข้อมูลอย่างเดียว ไม่สามารถล้างข้อมูลได้';
  END IF;

  IF v_op.operation_type = 'annual_close' THEN
    v_expected_confirm := 'CLOSE YEAR ' || v_op.target_year::TEXT;
    IF v_op.backup_verified_at IS NULL THEN
      RAISE EXCEPTION 'ต้องสำรองและ verify backup ก่อนปิดงวดรายปี';
    END IF;
  ELSE
    v_expected_confirm := 'RESET DATA';
  END IF;

  IF COALESCE(p_confirm_text, '') <> v_expected_confirm THEN
    RAISE EXCEPTION 'ข้อความยืนยันไม่ถูกต้อง ต้องพิมพ์: %', v_expected_confirm;
  END IF;

  UPDATE erp_data_operations
  SET status = 'reset_running', reset_started_at = NOW(), error_message = NULL
  WHERE id = p_operation_id;

  CREATE TEMP TABLE _erp_opening_stock ON COMMIT DROP AS
  SELECT
    product_id,
    COALESCE(is_safety_stock, FALSE) AS is_safety_stock,
    ROUND(SUM(qty_remaining), 2) AS qty,
    CASE
      WHEN SUM(qty_remaining) = 0 THEN 0
      ELSE ROUND(SUM(qty_remaining * unit_cost) / SUM(qty_remaining), 4)
    END AS unit_cost
  FROM inv_stock_lots
  WHERE qty_remaining > 0
  GROUP BY product_id, COALESCE(is_safety_stock, FALSE);

  IF v_op.operation_type = 'annual_close' OR v_op.stock_strategy = 'opening' THEN
    UPDATE ac_inventory_epochs SET is_active = FALSE WHERE is_active = TRUE;

    INSERT INTO ac_inventory_epochs(epoch_name, started_at, is_active, note, created_by)
    VALUES (
      CASE
        WHEN v_op.operation_type = 'annual_close' THEN 'YEAR-' || v_op.target_year::TEXT
        ELSE 'RESET-' || to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD-HH24MI')
      END,
      NOW(),
      TRUE,
      'Created by data backup/clear operation ' || p_operation_id::TEXT,
      v_uid
    )
    RETURNING id INTO v_epoch_id;

    INSERT INTO ac_inventory_epoch_openings(
      epoch_id, product_id, opening_qty, opening_value, opening_safety_qty, opening_safety_value
    )
    SELECT
      v_epoch_id,
      product_id,
      SUM(CASE WHEN is_safety_stock = FALSE THEN qty ELSE 0 END),
      SUM(CASE WHEN is_safety_stock = FALSE THEN qty * unit_cost ELSE 0 END),
      SUM(CASE WHEN is_safety_stock = TRUE THEN qty ELSE 0 END),
      SUM(CASE WHEN is_safety_stock = TRUE THEN qty * unit_cost ELSE 0 END)
    FROM _erp_opening_stock
    GROUP BY product_id;
  END IF;

  DELETE FROM erp_data_operation_table_counts
  WHERE operation_id = p_operation_id AND phase IN ('before_reset', 'after_reset');

  FOREACH v_table IN ARRAY erp_data_transactional_tables()
  LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('SELECT COUNT(*) FROM %I', v_table) INTO v_count;
      INSERT INTO erp_data_operation_table_counts(operation_id, phase, table_name, row_count)
      VALUES (p_operation_id, 'before_reset', v_table, v_count)
      ON CONFLICT (operation_id, phase, table_name)
      DO UPDATE SET row_count = EXCLUDED.row_count, recorded_at = NOW();
      v_before := v_before || jsonb_build_array(jsonb_build_object('table_name', v_table, 'row_count', v_count));
      v_truncate_tables := v_truncate_tables || CASE WHEN v_truncate_tables = '' THEN '' ELSE ', ' END || format('%I', v_table);
    END IF;
  END LOOP;

  IF v_truncate_tables <> '' THEN
    EXECUTE 'TRUNCATE ' || v_truncate_tables;
  END IF;

  IF v_op.operation_type = 'annual_close' OR v_op.stock_strategy = 'opening' THEN
    INSERT INTO inv_stock_lots(product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id, is_safety_stock)
    SELECT product_id, qty, qty, unit_cost, 'erp_data_operation', p_operation_id, is_safety_stock
    FROM _erp_opening_stock
    WHERE qty > 0;

    INSERT INTO inv_stock_movements(product_id, movement_type, qty, ref_type, ref_id, note, created_by, unit_cost, total_cost)
    SELECT
      product_id,
      'opening',
      qty,
      'erp_data_operation',
      p_operation_id,
      'ยอดยกมาจากการล้างข้อมูล',
      v_uid,
      unit_cost,
      ROUND(qty * unit_cost, 2)
    FROM _erp_opening_stock
    WHERE qty > 0;

    INSERT INTO inv_stock_balances(product_id, on_hand, reserved, safety_stock)
    SELECT
      product_id,
      SUM(CASE WHEN is_safety_stock = FALSE THEN qty ELSE 0 END),
      0,
      SUM(CASE WHEN is_safety_stock = TRUE THEN qty ELSE 0 END)
    FROM _erp_opening_stock
    GROUP BY product_id;

    GET DIAGNOSTICS v_opening_products = ROW_COUNT;

    UPDATE pr_products p
    SET landed_cost = COALESCE((
      SELECT SUM(l.qty_remaining * l.unit_cost) / NULLIF(SUM(l.qty_remaining), 0)
      FROM inv_stock_lots l
      WHERE l.product_id = p.id AND l.qty_remaining > 0
    ), 0)
    WHERE p.id IS NOT NULL;
  ELSE
    UPDATE pr_products
    SET landed_cost = 0
    WHERE landed_cost IS DISTINCT FROM 0;
  END IF;

  FOREACH v_table IN ARRAY erp_data_transactional_tables()
  LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('SELECT COUNT(*) FROM %I', v_table) INTO v_count;
      INSERT INTO erp_data_operation_table_counts(operation_id, phase, table_name, row_count)
      VALUES (p_operation_id, 'after_reset', v_table, v_count)
      ON CONFLICT (operation_id, phase, table_name)
      DO UPDATE SET row_count = EXCLUDED.row_count, recorded_at = NOW();
      v_after := v_after || jsonb_build_array(jsonb_build_object('table_name', v_table, 'row_count', v_count));
    END IF;
  END LOOP;

  UPDATE erp_data_operations
  SET status = 'completed',
      reset_completed_at = NOW(),
      summary = summary || jsonb_build_object(
        'before_reset', v_before,
        'after_reset', v_after,
        'inventory_epoch_id', v_epoch_id,
        'opening_balance_products', v_opening_products,
        'hr_policy', 'preserved'
      ),
      error_message = NULL
  WHERE id = p_operation_id;

  RETURN jsonb_build_object(
    'success', true,
    'operation_id', p_operation_id,
    'inventory_epoch_id', v_epoch_id,
    'opening_balance_products', v_opening_products,
    'hr_policy', 'preserved',
    'after_reset', v_after
  );
EXCEPTION WHEN OTHERS THEN
  UPDATE erp_data_operations
  SET status = 'failed', error_message = SQLERRM
  WHERE id = p_operation_id;
  RAISE;
END;
$$;
