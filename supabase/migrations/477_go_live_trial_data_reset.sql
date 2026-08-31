-- 477: Safe one-time go-live cleanup for trial transactional data.
-- Keeps product/user/seller/configuration/HR masters, requires a verified backup,
-- and uses DELETE (not TRUNCATE CASCADE) so unrelated FK-linked modules are preserved.

BEGIN;

ALTER TABLE public.erp_data_operations
  DROP CONSTRAINT IF EXISTS erp_data_operations_operation_type_check;

ALTER TABLE public.erp_data_operations
  ADD CONSTRAINT erp_data_operations_operation_type_check
  CHECK (operation_type IN ('annual_close', 'reset_only', 'backup_only', 'go_live_reset'));

-- Complete the legacy transactional list so the existing annual/reset workflows
-- understand tables added after migration 250.
CREATE OR REPLACE FUNCTION public.erp_data_transactional_tables()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'mp_order_items',
    'mp_orders',
    'mp_import_batches',
    'qc_escalation_decisions',
    'qc_record_attempts',
    'plan_worker_assignments',
    'pk_packing_reset_logs',
    'pk_packing_upload_queue_reports',
    'or_claim_requests',
    'pk_packing_unit_scans',
    'inv_gr_item_images',
    'ac_ecommerce_sale_lines',
    'ac_ecommerce_import_batches',
    'pr_machinery_status_events',
    'wh_sub_warehouse_stock_moves',
    'plan_jobs',
    'roll_usage_logs',
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
    'inv_stock_balance_history',
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
    'inv_stock_movements',
    'inv_stock_balances',
    'inv_stock_lots',
    'inv_audit_items',
    'inv_gr',
    'inv_returns',
    'inv_samples',
    'wms_requisitions',
    'wms_return_requisitions',
    'wms_borrow_requisitions',
    'pp_production_orders',
    'or_orders',
    'or_work_orders',
    'inv_audits',
    'inv_po',
    'inv_adjustments',
    'inv_pr'
  ];
$$;

-- Narrower go-live scope requested by the business. Deliberately excludes HR,
-- production orders, machinery, roll calculator and e-commerce accounting data.
CREATE OR REPLACE FUNCTION public.erp_data_go_live_tables()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    -- Marketplace work (keep mp_channel_configs and permissions)
    'mp_order_items',
    'mp_orders',
    'mp_import_batches',

    -- QC / packing / plan child records
    'qc_escalation_decisions',
    'qc_record_attempts',
    'plan_worker_assignments',
    'pk_packing_reset_logs',
    'pk_packing_upload_queue_reports',
    'pk_packing_unit_scans',
    'or_claim_requests',
    'inv_gr_item_images',

    -- Order/WMS leaf records
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

    -- Account transaction records (keep bank/bill settings)
    'ac_verified_slips',
    'ac_refunds',
    'ac_slip_verification_logs',
    'ac_bill_edit_logs',
    'ac_manual_slip_checks',
    'ac_credit_note_items',

    -- Inventory/purchase child records
    'inv_lot_consumptions',
    'inv_stock_balance_history',
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

    -- Parent records
    'or_order_items',
    'or_issues',
    'qc_sessions',
    'ac_credit_notes',
    'inv_stock_movements',
    'inv_stock_balances',
    'inv_stock_lots',
    'inv_audit_items',
    'inv_gr',
    'inv_returns',
    'inv_samples',
    'wms_requisitions',
    'wms_return_requisitions',
    'wms_borrow_requisitions',
    'plan_jobs',
    'or_orders',
    'or_work_orders',
    'inv_audits',
    'inv_po',
    'inv_adjustments',
    'inv_pr',

    -- Remove trial accounting baselines only in this dedicated mode.
    'ac_inventory_epoch_openings',
    'ac_inventory_epochs',

    -- Sub-warehouse movement history is stock transactional data; mappings remain.
    'wh_sub_warehouse_stock_moves'
  ];
$$;

CREATE OR REPLACE FUNCTION public.erp_data_tables_for_operation(p_operation_type TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_operation_type = 'go_live_reset' THEN public.erp_data_go_live_tables()
    ELSE public.erp_data_transactional_tables()
  END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_data_operation_create(
  p_operation_type TEXT,
  p_target_year INT DEFAULT NULL,
  p_stock_strategy TEXT DEFAULT 'opening'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid UUID;
  v_id UUID;
  v_stock_strategy TEXT := COALESCE(NULLIF(p_stock_strategy, ''), 'opening');
BEGIN
  v_uid := public.erp_data_assert_superadmin();

  IF p_operation_type NOT IN ('annual_close', 'reset_only', 'backup_only', 'go_live_reset') THEN
    RAISE EXCEPTION 'operation_type ไม่ถูกต้อง';
  END IF;
  IF v_stock_strategy NOT IN ('opening', 'zero') THEN
    RAISE EXCEPTION 'stock_strategy ไม่ถูกต้อง';
  END IF;
  IF p_operation_type = 'annual_close' AND p_target_year IS NULL THEN
    RAISE EXCEPTION 'ต้องระบุปีสำหรับปิดงวดรายปี';
  END IF;

  INSERT INTO public.erp_data_operations (
    operation_type, target_year, stock_strategy, status, requested_by
  ) VALUES (
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

CREATE OR REPLACE FUNCTION public.rpc_data_operation_preview(p_operation_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid UUID;
  v_op public.erp_data_operations%ROWTYPE;
  v_table TEXT;
  v_count BIGINT;
  v_table_counts JSONB := '[]'::JSONB;
  v_total BIGINT := 0;
  v_blockers JSONB;
  v_database_size BIGINT := pg_database_size(current_database());
BEGIN
  v_uid := public.erp_data_assert_superadmin();
  PERFORM pg_advisory_xact_lock(hashtext('erp_data_operation:' || p_operation_id::TEXT));

  SELECT * INTO v_op
  FROM public.erp_data_operations
  WHERE id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบ operation'; END IF;

  DELETE FROM public.erp_data_operation_table_counts
  WHERE operation_id = p_operation_id AND phase = 'preview';

  FOREACH v_table IN ARRAY public.erp_data_tables_for_operation(v_op.operation_type)
  LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('SELECT COUNT(*) FROM %I', v_table) INTO v_count;
      INSERT INTO public.erp_data_operation_table_counts(operation_id, phase, table_name, row_count)
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
    'open_orders', COALESCE((SELECT COUNT(*) FROM public.or_orders WHERE status IS DISTINCT FROM 'จัดส่งแล้ว' AND status IS DISTINCT FROM 'ยกเลิก'), 0),
    'pending_wms_orders', COALESCE((SELECT COUNT(*) FROM public.wms_orders WHERE status NOT IN ('correct', 'wrong', 'not_find', 'out_of_stock', 'cancelled', 'system_complete')), 0),
    'open_qc_sessions', COALESCE((SELECT COUNT(*) FROM public.qc_sessions WHERE end_time IS NULL), 0),
    'open_purchase_orders', COALESCE((SELECT COUNT(*) FROM public.inv_po WHERE status NOT IN ('closed', 'cancelled', 'received')), 0),
    'pending_requisitions', COALESCE((SELECT COUNT(*) FROM public.wms_requisitions WHERE status = 'pending'), 0),
    'warning_only_for_go_live', v_op.operation_type = 'go_live_reset',
    'hr_policy', 'preserve_all_hr'
  ) INTO v_blockers;

  UPDATE public.erp_data_operations
  SET status = CASE WHEN status = 'draft' THEN 'previewed' ELSE status END,
      summary = summary || jsonb_build_object(
        'last_preview_at', NOW(),
        'preview_total_rows', v_total,
        'database_size_bytes', v_database_size,
        'blockers', v_blockers,
        'table_scope', CASE WHEN operation_type = 'go_live_reset' THEN 'go_live_trial_data' ELSE 'standard_transactional' END
      ),
      error_message = NULL
  WHERE id = p_operation_id;

  RETURN jsonb_build_object(
    'success', true,
    'operation_id', p_operation_id,
    'operation_type', v_op.operation_type,
    'stock_strategy', v_op.stock_strategy,
    'target_year', v_op.target_year,
    'database_size_bytes', v_database_size,
    'total_rows', v_total,
    'table_counts', v_table_counts,
    'blockers', v_blockers,
    'hr_policy', jsonb_build_object(
      'preserve_default', true,
      'message', 'เก็บข้อมูล HR, Master สินค้า, ผู้ขาย, ผู้ใช้ และการตั้งค่าทั้งหมด'
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_data_reset_execute(
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
  v_op public.erp_data_operations%ROWTYPE;
  v_tables TEXT[];
  v_remaining_tables TEXT[];
  v_deferred_tables TEXT[];
  v_table TEXT;
  v_deleted_any BOOLEAN;
  v_count BIGINT;
  v_before JSONB := '[]'::JSONB;
  v_after JSONB := '[]'::JSONB;
  v_expected_confirm TEXT;
  v_epoch_id BIGINT;
  v_opening_products INT := 0;
BEGIN
  v_uid := public.erp_data_assert_superadmin();
  PERFORM pg_advisory_xact_lock(hashtext('erp_data_reset_execute'));
  PERFORM pg_advisory_xact_lock(hashtext('erp_data_operation:' || p_operation_id::TEXT));

  SELECT * INTO v_op
  FROM public.erp_data_operations
  WHERE id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบ operation'; END IF;
  IF v_op.operation_type = 'backup_only' THEN
    RAISE EXCEPTION 'operation นี้เป็นสำรองข้อมูลอย่างเดียว ไม่สามารถล้างข้อมูลได้';
  END IF;

  v_expected_confirm := CASE
    WHEN v_op.operation_type = 'annual_close' THEN 'CLOSE YEAR ' || v_op.target_year::TEXT
    WHEN v_op.operation_type = 'go_live_reset' THEN 'GO LIVE RESET'
    ELSE 'RESET DATA'
  END;
  IF COALESCE(p_confirm_text, '') <> v_expected_confirm THEN
    RAISE EXCEPTION 'ข้อความยืนยันไม่ถูกต้อง ต้องพิมพ์: %', v_expected_confirm;
  END IF;
  IF v_op.operation_type IN ('annual_close', 'go_live_reset')
     AND v_op.backup_verified_at IS NULL THEN
    RAISE EXCEPTION 'ต้องสำรองข้อมูลและตรวจสอบ manifest สำเร็จก่อนล้างข้อมูล';
  END IF;

  v_tables := public.erp_data_tables_for_operation(v_op.operation_type);

  UPDATE public.erp_data_operations
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
  FROM public.inv_stock_lots
  WHERE qty_remaining > 0
  GROUP BY product_id, COALESCE(is_safety_stock, FALSE);

  DELETE FROM public.erp_data_operation_table_counts
  WHERE operation_id = p_operation_id AND phase IN ('before_reset', 'after_reset');

  -- Record the complete before-state before any cascade can remove child rows.
  FOREACH v_table IN ARRAY v_tables
  LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('SELECT COUNT(*) FROM %I', v_table) INTO v_count;
      INSERT INTO public.erp_data_operation_table_counts(operation_id, phase, table_name, row_count)
      VALUES (p_operation_id, 'before_reset', v_table, v_count)
      ON CONFLICT (operation_id, phase, table_name)
      DO UPDATE SET row_count = EXCLUDED.row_count, recorded_at = NOW();
      v_before := v_before || jsonb_build_array(jsonb_build_object('table_name', v_table, 'row_count', v_count));
    END IF;
  END LOOP;

  -- Delete in dependency-aware passes. FK-restricted parents are deferred until
  -- their scoped children are gone. An out-of-scope RESTRICT dependency aborts
  -- the whole transaction rather than deleting unrelated data via CASCADE.
  v_remaining_tables := v_tables;
  WHILE COALESCE(array_length(v_remaining_tables, 1), 0) > 0
  LOOP
    v_deferred_tables := ARRAY[]::TEXT[];
    v_deleted_any := FALSE;

    FOREACH v_table IN ARRAY v_remaining_tables
    LOOP
      IF to_regclass('public.' || v_table) IS NULL THEN
        v_deleted_any := TRUE;
      ELSE
        BEGIN
          -- WHERE clause is intentional for environments with pg_safeupdate.
          EXECUTE format('DELETE FROM %I WHERE TRUE', v_table);
          v_deleted_any := TRUE;
        EXCEPTION WHEN foreign_key_violation THEN
          v_deferred_tables := array_append(v_deferred_tables, v_table);
        END;
      END IF;
    END LOOP;

    IF COALESCE(array_length(v_deferred_tables, 1), 0) = 0 THEN
      EXIT;
    END IF;
    IF NOT v_deleted_any THEN
      RAISE EXCEPTION 'ไม่สามารถล้างข้อมูลได้ เนื่องจากมี Foreign Key นอกขอบเขตอ้างอิงตาราง: %',
        array_to_string(v_deferred_tables, ', ');
    END IF;
    v_remaining_tables := v_deferred_tables;
  END LOOP;

  IF v_op.operation_type = 'annual_close' OR v_op.stock_strategy = 'opening' THEN
    UPDATE public.ac_inventory_epochs SET is_active = FALSE WHERE is_active = TRUE;
    INSERT INTO public.ac_inventory_epochs(epoch_name, started_at, is_active, note, created_by)
    VALUES (
      CASE
        WHEN v_op.operation_type = 'annual_close' THEN 'YEAR-' || v_op.target_year::TEXT
        WHEN v_op.operation_type = 'go_live_reset' THEN 'GO-LIVE-' || to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD-HH24MI')
        ELSE 'RESET-' || to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD-HH24MI')
      END,
      NOW(), TRUE,
      'Created by data operation ' || p_operation_id::TEXT,
      v_uid
    ) RETURNING id INTO v_epoch_id;

    INSERT INTO public.ac_inventory_epoch_openings(
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

    INSERT INTO public.inv_stock_lots(product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id, is_safety_stock)
    SELECT product_id, qty, qty, unit_cost, 'erp_data_operation', p_operation_id, is_safety_stock
    FROM _erp_opening_stock
    WHERE qty > 0;

    INSERT INTO public.inv_stock_movements(product_id, movement_type, qty, ref_type, ref_id, note, created_by, unit_cost, total_cost)
    SELECT product_id, 'opening', qty, 'erp_data_operation', p_operation_id,
           'ยอดยกมาจากการล้างข้อมูลทดลองก่อนเริ่มใช้งานจริง',
           v_uid, unit_cost, ROUND(qty * unit_cost, 2)
    FROM _erp_opening_stock
    WHERE qty > 0;

    INSERT INTO public.inv_stock_balances(product_id, on_hand, reserved, safety_stock)
    SELECT
      product_id,
      SUM(CASE WHEN is_safety_stock = FALSE THEN qty ELSE 0 END),
      0,
      SUM(CASE WHEN is_safety_stock = TRUE THEN qty ELSE 0 END)
    FROM _erp_opening_stock
    GROUP BY product_id;

    GET DIAGNOSTICS v_opening_products = ROW_COUNT;

    UPDATE public.pr_products p
    SET landed_cost = COALESCE((
      SELECT SUM(l.qty_remaining * l.unit_cost) / NULLIF(SUM(l.qty_remaining), 0)
      FROM public.inv_stock_lots l
      WHERE l.product_id = p.id AND l.qty_remaining > 0
    ), 0)
    WHERE p.id IS NOT NULL;
  ELSE
    UPDATE public.pr_products
    SET landed_cost = 0
    WHERE landed_cost IS DISTINCT FROM 0;
  END IF;

  FOREACH v_table IN ARRAY v_tables
  LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('SELECT COUNT(*) FROM %I', v_table) INTO v_count;
      INSERT INTO public.erp_data_operation_table_counts(operation_id, phase, table_name, row_count)
      VALUES (p_operation_id, 'after_reset', v_table, v_count)
      ON CONFLICT (operation_id, phase, table_name)
      DO UPDATE SET row_count = EXCLUDED.row_count, recorded_at = NOW();
      v_after := v_after || jsonb_build_array(jsonb_build_object('table_name', v_table, 'row_count', v_count));
    END IF;
  END LOOP;

  UPDATE public.erp_data_operations
  SET status = 'completed',
      reset_completed_at = NOW(),
      summary = summary || jsonb_build_object(
        'before_reset', v_before,
        'after_reset', v_after,
        'inventory_epoch_id', v_epoch_id,
        'opening_balance_products', v_opening_products,
        'master_policy', 'products_users_sellers_settings_hr_preserved',
        'storage_policy', 'objects_not_deleted'
      ),
      error_message = NULL
  WHERE id = p_operation_id;

  RETURN jsonb_build_object(
    'success', true,
    'operation_id', p_operation_id,
    'operation_type', v_op.operation_type,
    'inventory_epoch_id', v_epoch_id,
    'opening_balance_products', v_opening_products,
    'stock_strategy', v_op.stock_strategy,
    'master_data_preserved', true,
    'storage_objects_deleted', false,
    'after_reset', v_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.erp_data_tables_for_operation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.erp_data_tables_for_operation(TEXT) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
