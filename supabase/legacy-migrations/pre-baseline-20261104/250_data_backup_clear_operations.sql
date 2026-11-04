-- 250: Data backup / clear operations
-- Adds a guarded operation workflow for Settings > สำลองข้อมูล/ล้างข้อมูล.
-- Default reset behavior intentionally preserves HR master/history data.

BEGIN;

CREATE TABLE IF NOT EXISTS erp_data_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type TEXT NOT NULL CHECK (operation_type IN ('annual_close', 'reset_only', 'backup_only')),
  target_year INT,
  stock_strategy TEXT NOT NULL DEFAULT 'opening' CHECK (stock_strategy IN ('opening', 'zero')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'previewed', 'backup_running', 'backup_verified', 'reset_running', 'completed', 'failed')
  ),
  requested_by UUID REFERENCES us_users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  backup_started_at TIMESTAMPTZ,
  backup_verified_at TIMESTAMPTZ,
  reset_started_at TIMESTAMPTZ,
  reset_completed_at TIMESTAMPTZ,
  summary JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS erp_data_operation_table_counts (
  id BIGSERIAL PRIMARY KEY,
  operation_id UUID NOT NULL REFERENCES erp_data_operations(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('preview', 'before_reset', 'after_reset', 'backup_manifest')),
  table_name TEXT NOT NULL,
  row_count BIGINT NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (operation_id, phase, table_name)
);

ALTER TABLE erp_data_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_data_operation_table_counts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ERP data operations read admin" ON erp_data_operations;
CREATE POLICY "ERP data operations read admin"
  ON erp_data_operations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin')
    )
  );

DROP POLICY IF EXISTS "ERP data operations manage superadmin" ON erp_data_operations;
CREATE POLICY "ERP data operations manage superadmin"
  ON erp_data_operations FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role = 'superadmin'
    )
  );

DROP POLICY IF EXISTS "ERP data operation counts read admin" ON erp_data_operation_table_counts;
CREATE POLICY "ERP data operation counts read admin"
  ON erp_data_operation_table_counts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM erp_data_operations op
      JOIN us_users u ON u.id = auth.uid()
      WHERE op.id = operation_id AND u.role IN ('superadmin', 'admin')
    )
  );

DROP POLICY IF EXISTS "ERP data operation counts manage superadmin" ON erp_data_operation_table_counts;
CREATE POLICY "ERP data operation counts manage superadmin"
  ON erp_data_operation_table_counts FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role = 'superadmin'
    )
  );

CREATE OR REPLACE FUNCTION erp_data_transactional_tables()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    -- Leaf / newer child tables first
    'or_claim_requests',
    'pk_packing_unit_scans',
    'inv_gr_item_images',
    'ac_ecommerce_sale_lines',
    'ac_ecommerce_import_batches',
    'pr_machinery_status_events',
    'wh_sub_warehouse_stock_moves',
    'plan_jobs',
    'roll_usage_logs',
    'or_work_orders',
    'or_order_chat_reads',
    'qc_skip_logs',
    'wms_orders',
    'wms_order_summaries',
    'wms_notifications',
    'or_order_reviews',
    'or_order_chat_logs',
    'or_order_amendments',
    'or_order_revisions',
    'or_issue_messages',
    'or_issue_reads',
    'pk_packing_logs',
    'pk_packing_videos',
    'qc_records',
    'ac_verified_slips',
    'ac_refunds',
    'ac_slip_verification_logs',
    'ac_bill_edit_logs',
    'ac_manual_slip_checks',
    'ac_credit_note_items',
    'inv_lot_consumptions',
    'inv_pr_items',
    'inv_po_items',
    'inv_gr_items',
    'inv_audit_count_logs',
    'inv_adjustment_items',
    'inv_return_items',
    'inv_sample_items',
    'wms_requisition_items',
    'wms_return_requisition_items',
    'wms_borrow_requisition_items',
    'pp_production_order_items',
    'or_order_items',
    'or_issues',
    'qc_sessions',
    'ac_credit_notes',
    'inv_stock_lots',
    'inv_stock_movements',
    'inv_stock_balances',
    'inv_audit_items',
    'inv_gr',
    'inv_returns',
    'inv_samples',
    'wms_requisitions',
    'wms_return_requisitions',
    'wms_borrow_requisitions',
    'pp_production_orders',
    'or_orders',
    'inv_audits',
    'inv_po',
    'inv_adjustments',
    'inv_pr'
  ];
$$;

CREATE OR REPLACE FUNCTION erp_data_assert_superadmin()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_claims JSONB := COALESCE(NULLIF(current_setting('request.jwt.claims', TRUE), '')::JSONB, '{}'::JSONB);
  v_jwt_role TEXT := COALESCE(v_claims->>'role', '');
BEGIN
  IF v_jwt_role = 'service_role' THEN
    RETURN NULL;
  END IF;

  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_uid IS NULL OR v_role IS DISTINCT FROM 'superadmin' THEN
    RAISE EXCEPTION 'ต้องใช้สิทธิ์ superadmin เท่านั้น';
  END IF;
  RETURN v_uid;
END;
$$;

CREATE OR REPLACE FUNCTION rpc_data_operation_create(
  p_operation_type TEXT,
  p_target_year INT DEFAULT NULL,
  p_stock_strategy TEXT DEFAULT 'opening'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
  v_id UUID;
  v_stock_strategy TEXT := COALESCE(NULLIF(p_stock_strategy, ''), 'opening');
BEGIN
  v_uid := erp_data_assert_superadmin();

  IF p_operation_type NOT IN ('annual_close', 'reset_only', 'backup_only') THEN
    RAISE EXCEPTION 'operation_type ไม่ถูกต้อง';
  END IF;

  IF v_stock_strategy NOT IN ('opening', 'zero') THEN
    RAISE EXCEPTION 'stock_strategy ไม่ถูกต้อง';
  END IF;

  IF p_operation_type = 'annual_close' AND p_target_year IS NULL THEN
    RAISE EXCEPTION 'ต้องระบุปีสำหรับปิดงวดรายปี';
  END IF;

  INSERT INTO erp_data_operations (
    operation_type, target_year, stock_strategy, status, requested_by
  )
  VALUES (
    p_operation_type,
    p_target_year,
    CASE WHEN p_operation_type = 'backup_only' THEN 'opening' ELSE v_stock_strategy END,
    'draft',
    v_uid
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'operation_id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION rpc_data_operation_preview(
  p_operation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
  v_op erp_data_operations%ROWTYPE;
  v_table TEXT;
  v_count BIGINT;
  v_table_counts JSONB := '[]'::JSONB;
  v_total BIGINT := 0;
  v_blockers JSONB;
BEGIN
  v_uid := erp_data_assert_superadmin();
  PERFORM pg_advisory_xact_lock(hashtext('erp_data_operation:' || p_operation_id::TEXT));

  SELECT * INTO v_op FROM erp_data_operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบ operation';
  END IF;

  DELETE FROM erp_data_operation_table_counts
  WHERE operation_id = p_operation_id AND phase = 'preview';

  FOREACH v_table IN ARRAY erp_data_transactional_tables()
  LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('SELECT COUNT(*) FROM %I', v_table) INTO v_count;
      INSERT INTO erp_data_operation_table_counts(operation_id, phase, table_name, row_count)
      VALUES (p_operation_id, 'preview', v_table, v_count)
      ON CONFLICT (operation_id, phase, table_name)
      DO UPDATE SET row_count = EXCLUDED.row_count, recorded_at = NOW();

      v_total := v_total + v_count;
      v_table_counts := v_table_counts || jsonb_build_array(
        jsonb_build_object('table_name', v_table, 'row_count', v_count)
      );
    END IF;
  END LOOP;

  SELECT jsonb_build_object(
    'open_orders', COALESCE((SELECT COUNT(*) FROM or_orders WHERE status IS DISTINCT FROM 'จัดส่งแล้ว' AND status IS DISTINCT FROM 'ยกเลิก'), 0),
    'pending_wms_orders', COALESCE((SELECT COUNT(*) FROM wms_orders WHERE status NOT IN ('correct', 'wrong', 'not_find', 'out_of_stock')), 0),
    'open_qc_sessions', COALESCE((SELECT COUNT(*) FROM qc_sessions WHERE end_time IS NULL), 0),
    'open_purchase_orders', COALESCE((SELECT COUNT(*) FROM inv_po WHERE status NOT IN ('closed', 'cancelled', 'received')), 0),
    'pending_requisitions', COALESCE((SELECT COUNT(*) FROM wms_requisitions WHERE status = 'pending'), 0),
    'hr_policy', 'preserve_all_hr_by_default'
  )
  INTO v_blockers;

  UPDATE erp_data_operations
  SET status = CASE WHEN status = 'draft' THEN 'previewed' ELSE status END,
      summary = summary || jsonb_build_object(
        'last_preview_at', NOW(),
        'preview_total_rows', v_total,
        'blockers', v_blockers
      ),
      error_message = NULL
  WHERE id = p_operation_id;

  RETURN jsonb_build_object(
    'success', true,
    'operation_id', p_operation_id,
    'operation_type', v_op.operation_type,
    'stock_strategy', v_op.stock_strategy,
    'target_year', v_op.target_year,
    'total_rows', v_total,
    'table_counts', v_table_counts,
    'blockers', v_blockers,
    'hr_policy', jsonb_build_object(
      'preserve_default', true,
      'message', 'ฟีเจอร์นี้ไม่ลบข้อมูล HR เป็นค่าเริ่มต้น'
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION rpc_data_operation_mark_backup_verified(
  p_operation_id UUID,
  p_manifest JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
BEGIN
  v_uid := erp_data_assert_superadmin();

  UPDATE erp_data_operations
  SET status = CASE
        WHEN operation_type = 'backup_only' THEN 'completed'
        ELSE 'backup_verified'
      END,
      backup_started_at = COALESCE(backup_started_at, NOW()),
      backup_verified_at = NOW(),
      summary = summary || jsonb_build_object('backup_manifest', p_manifest, 'backup_verified_by', v_uid),
      error_message = NULL
  WHERE id = p_operation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบ operation';
  END IF;

  RETURN jsonb_build_object('success', true, 'operation_id', p_operation_id);
END;
$$;

CREATE OR REPLACE FUNCTION rpc_data_reset_execute(
  p_operation_id UUID,
  p_confirm_text TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    ), 0);
  ELSE
    UPDATE pr_products SET landed_cost = 0;
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

INSERT INTO st_user_menus (role, menu_key, menu_name, has_access)
VALUES
  ('admin', 'settings-backup-clear', 'สำลองข้อมูล/ล้างข้อมูล', false),
  ('sales-tr', 'settings-backup-clear', 'สำลองข้อมูล/ล้างข้อมูล', false)
ON CONFLICT (role, menu_key) DO NOTHING;

REVOKE ALL ON FUNCTION erp_data_transactional_tables() FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_data_assert_superadmin() FROM PUBLIC;
REVOKE ALL ON FUNCTION rpc_data_operation_create(TEXT, INT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION rpc_data_operation_preview(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION rpc_data_operation_mark_backup_verified(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION rpc_data_reset_execute(UUID, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION rpc_data_operation_create(TEXT, INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_data_operation_preview(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_data_operation_mark_backup_verified(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_data_reset_execute(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_data_operation_create(TEXT, INT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION rpc_data_operation_preview(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION rpc_data_operation_mark_backup_verified(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION rpc_data_reset_execute(UUID, TEXT) TO service_role;

COMMIT;
