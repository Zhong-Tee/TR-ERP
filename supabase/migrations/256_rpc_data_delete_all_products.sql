-- 256: Delete all product master data (superadmin only)
-- Requires transactional data to be cleared first (reset_only).

CREATE OR REPLACE FUNCTION erp_data_product_dependent_master_tables()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'pp_recipe_removes',
    'pp_recipe_includes',
    'pp_recipes',
    'roll_material_config_rms',
    'roll_material_configs',
    'qc_checklist_topic_products',
    'wh_sub_warehouse_products',
    'wh_sub_wms_map_spares',
    'wh_sub_wms_map_sources',
    'ac_inventory_epoch_openings',
    'pr_product_field_overrides',
    'pr_product_channel_prices'
  ];
$$;

CREATE OR REPLACE FUNCTION rpc_data_delete_all_products(
  p_confirm_text TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_table TEXT;
  v_truncate_tables TEXT := '';
  v_product_count BIGINT;
  v_deleted BIGINT := 0;
  v_blockers JSONB;
BEGIN
  PERFORM erp_data_assert_superadmin();

  IF COALESCE(p_confirm_text, '') <> 'DELETE ALL PRODUCTS' THEN
    RAISE EXCEPTION 'ข้อความยืนยันไม่ถูกต้อง ต้องพิมพ์: DELETE ALL PRODUCTS';
  END IF;

  SELECT jsonb_build_object(
    'or_orders', COALESCE((SELECT COUNT(*) FROM or_orders), 0),
    'inv_stock_balances', COALESCE((SELECT COUNT(*) FROM inv_stock_balances), 0),
    'inv_stock_lots', COALESCE((SELECT COUNT(*) FROM inv_stock_lots), 0),
    'wms_orders', COALESCE((SELECT COUNT(*) FROM wms_orders), 0),
    'pp_production_orders', COALESCE((SELECT COUNT(*) FROM pp_production_orders), 0),
    'inv_po', COALESCE((SELECT COUNT(*) FROM inv_po), 0),
    'inv_pr', COALESCE((SELECT COUNT(*) FROM inv_pr), 0)
  )
  INTO v_blockers;

  IF (v_blockers->>'or_orders')::BIGINT > 0
    OR (v_blockers->>'inv_stock_balances')::BIGINT > 0
    OR (v_blockers->>'inv_stock_lots')::BIGINT > 0
    OR (v_blockers->>'wms_orders')::BIGINT > 0
    OR (v_blockers->>'pp_production_orders')::BIGINT > 0
    OR (v_blockers->>'inv_po')::BIGINT > 0
    OR (v_blockers->>'inv_pr')::BIGINT > 0
  THEN
    RAISE EXCEPTION 'ต้องล้างข้อมูลธุรกรรมก่อน (ใช้ ล้างข้อมูลอย่างเดียว) blockers: %', v_blockers::TEXT;
  END IF;

  SELECT COUNT(*) INTO v_product_count FROM pr_products;

  FOREACH v_table IN ARRAY erp_data_product_dependent_master_tables()
  LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      v_truncate_tables := v_truncate_tables || CASE WHEN v_truncate_tables = '' THEN '' ELSE ', ' END || format('%I', v_table);
    END IF;
  END LOOP;

  IF v_truncate_tables <> '' THEN
    EXECUTE 'TRUNCATE ' || v_truncate_tables;
  END IF;

  DELETE FROM pr_products WHERE id IS NOT NULL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_products', v_deleted,
    'previous_product_count', v_product_count,
    'hr_policy', 'preserved',
    'note', 'pr_sellers และ master อื่นๆ ยังอยู่ — นำเข้าสินค้าใหม่ได้ทันที'
  );
END;
$$;

REVOKE ALL ON FUNCTION erp_data_product_dependent_master_tables() FROM PUBLIC;
REVOKE ALL ON FUNCTION rpc_data_delete_all_products(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_data_delete_all_products(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_data_delete_all_products(TEXT) TO service_role;
