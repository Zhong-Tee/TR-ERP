-- ============================================
-- 135: เพิ่ม unit_name + unit_multiplier ใน RPC bulk import
-- ให้ import สินค้าใหม่พร้อมกำหนดหน่วยได้
-- ============================================

CREATE OR REPLACE FUNCTION rpc_bulk_import_products_with_stock(items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role          TEXT;
  item           JSONB;
  v_product_id   UUID;
  v_product_code TEXT;
  v_initial_stock NUMERIC;
  v_safety_stock  NUMERIC;
  v_unit_cost     NUMERIC;
  v_on_hand       NUMERIC;
  v_imported      INT := 0;
  v_skipped       INT := 0;
  v_errors        JSONB := '[]'::JSONB;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ import สินค้า (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    v_product_code := item->>'product_code';

    IF EXISTS (SELECT 1 FROM pr_products WHERE product_code = v_product_code) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_initial_stock := COALESCE((item->>'initial_stock')::NUMERIC, 0);
    v_safety_stock  := COALESCE((item->>'safety_stock')::NUMERIC, 0);
    v_unit_cost     := COALESCE((item->>'unit_cost')::NUMERIC, 0);

    IF v_safety_stock > v_initial_stock THEN
      v_safety_stock := v_initial_stock;
    END IF;

    v_on_hand := v_initial_stock - v_safety_stock;

    BEGIN
      INSERT INTO pr_products (
        product_code, product_name, product_category, product_type,
        seller_name, product_name_cn, order_point,
        rubber_code, storage_location,
        unit_cost, landed_cost, safety_stock,
        unit_name, unit_multiplier,
        is_active
      )
      VALUES (
        v_product_code,
        item->>'product_name',
        NULLIF(item->>'product_category', ''),
        COALESCE(NULLIF(item->>'product_type', ''), 'FG'),
        NULLIF(item->>'seller_name', ''),
        NULLIF(item->>'product_name_cn', ''),
        NULLIF(item->>'order_point', ''),
        NULLIF(item->>'rubber_code', ''),
        NULLIF(item->>'storage_location', ''),
        v_unit_cost,
        CASE WHEN v_unit_cost > 0 THEN v_unit_cost ELSE 0 END,
        v_safety_stock,
        COALESCE(NULLIF(item->>'unit_name', ''), 'ชิ้น'),
        GREATEST(COALESCE((item->>'unit_multiplier')::NUMERIC, 1), 0.01),
        TRUE
      )
      RETURNING id INTO v_product_id;

      IF v_initial_stock > 0 THEN
        INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
        VALUES (v_product_id, v_on_hand, 0, v_safety_stock);

        IF v_on_hand > 0 THEN
          INSERT INTO inv_stock_lots (
            product_id, qty_initial, qty_remaining, unit_cost,
            ref_type, ref_id, is_safety_stock
          )
          VALUES (
            v_product_id, v_on_hand, v_on_hand, v_unit_cost,
            'initial_import', NULL, FALSE
          );

          INSERT INTO inv_stock_movements (
            product_id, movement_type, qty, ref_type, note,
            unit_cost, total_cost
          )
          VALUES (
            v_product_id, 'adjust', v_on_hand, 'initial_import',
            'นำเข้าสต๊อคเริ่มต้น',
            v_unit_cost, v_on_hand * v_unit_cost
          );
        END IF;

        IF v_safety_stock > 0 THEN
          INSERT INTO inv_stock_lots (
            product_id, qty_initial, qty_remaining, unit_cost,
            ref_type, ref_id, is_safety_stock
          )
          VALUES (
            v_product_id, v_safety_stock, v_safety_stock, v_unit_cost,
            'initial_import', NULL, TRUE
          );

          INSERT INTO inv_stock_movements (
            product_id, movement_type, qty, ref_type, note,
            unit_cost, total_cost
          )
          VALUES (
            v_product_id, 'adjust', v_safety_stock, 'initial_import',
            'นำเข้า safety stock เริ่มต้น',
            v_unit_cost, v_safety_stock * v_unit_cost
          );
        END IF;

        PERFORM fn_recalc_product_landed_cost(v_product_id);
      END IF;

      v_imported := v_imported + 1;

    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_object(
        'product_code', v_product_code,
        'error', SQLERRM
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'imported', v_imported,
    'skipped', v_skipped,
    'errors', v_errors
  );
END;
$$;
