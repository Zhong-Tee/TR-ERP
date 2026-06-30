-- 258: เก็บ metadata ผู้ขายที่ pr_products + sync/upsert ครบไป pr_sellers

ALTER TABLE pr_products
  ADD COLUMN IF NOT EXISTS seller_name_cn TEXT,
  ADD COLUMN IF NOT EXISTS seller_purchase_channel TEXT,
  ADD COLUMN IF NOT EXISTS seller_type TEXT;

ALTER TABLE pr_products
  DROP CONSTRAINT IF EXISTS pr_products_seller_type_chk;

ALTER TABLE pr_products
  ADD CONSTRAINT pr_products_seller_type_chk
  CHECK (seller_type IS NULL OR seller_type IN ('thailand', 'foreign'));

COMMENT ON COLUMN pr_products.seller_name_cn IS 'ชื่อผู้ขายภาษาจีน (denormalized สำหรับ sync ไป pr_sellers)';
COMMENT ON COLUMN pr_products.seller_purchase_channel IS 'ช่องทางซื้อของผู้ขาย (denormalized)';
COMMENT ON COLUMN pr_products.seller_type IS 'thailand=ประเทศไทย, foreign=ต่างประเทศ (denormalized)';

-- Normalize seller_type จาก Excel / UI
CREATE OR REPLACE FUNCTION fn_normalize_seller_type(p_raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v TEXT := lower(trim(COALESCE(p_raw, '')));
BEGIN
  IF v = '' THEN
    RETURN NULL;
  END IF;

  IF v IN ('thailand', 'th', 'ไทย', 'ประเทศไทย') THEN
    RETURN 'thailand';
  END IF;

  IF v IN ('foreign', 'intl', 'international', 'cn', 'ต่างประเทศ', 'ตปท') THEN
    RETURN 'foreign';
  END IF;

  RETURN NULL;
END;
$$;

-- Upsert มาสเตอร์ผู้ขายจากฟิลด์สินค้า (ไม่ทับด้วยค่าว่าง)
CREATE OR REPLACE FUNCTION fn_upsert_pr_seller_from_product(
  p_name TEXT,
  p_name_cn TEXT DEFAULT NULL,
  p_purchase_channel TEXT DEFAULT NULL,
  p_seller_type TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := trim(COALESCE(p_name, ''));
  v_name_cn TEXT := NULLIF(trim(COALESCE(p_name_cn, '')), '');
  v_channel TEXT := NULLIF(trim(COALESCE(p_purchase_channel, '')), '');
  v_type TEXT := fn_normalize_seller_type(p_seller_type);
BEGIN
  IF v_name = '' THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pr_sellers WHERE name = v_name) THEN
    INSERT INTO pr_sellers (name, name_cn, purchase_channel, seller_type, is_active)
    VALUES (
      v_name,
      COALESCE(v_name_cn, ''),
      COALESCE(v_channel, ''),
      COALESCE(v_type, 'foreign'),
      TRUE
    );
    RETURN;
  END IF;

  UPDATE pr_sellers SET
    name_cn = CASE
      WHEN v_name_cn IS NOT NULL AND v_name_cn <> '' THEN v_name_cn
      ELSE name_cn
    END,
    purchase_channel = CASE
      WHEN v_channel IS NOT NULL AND v_channel <> '' THEN v_channel
      ELSE purchase_channel
    END,
    seller_type = CASE
      WHEN v_type IS NOT NULL THEN v_type
      ELSE seller_type
    END,
    is_active = TRUE,
    updated_at = NOW()
  WHERE name = v_name;
END;
$$;

COMMENT ON FUNCTION fn_upsert_pr_seller_from_product(TEXT, TEXT, TEXT, TEXT) IS
  'สร้าง/อัปเดต pr_sellers จากฟิลด์ผู้ขายบนสินค้า — อัปเดตเฉพาะฟิลด์ที่ส่งมาและไม่ว่าง';

-- Trigger: เมื่อสินค้ามี seller_name ให้ sync metadata ไป pr_sellers
CREATE OR REPLACE FUNCTION fn_pr_products_ensure_seller_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM fn_upsert_pr_seller_from_product(
    NEW.seller_name,
    NEW.seller_name_cn,
    NEW.seller_purchase_channel,
    NEW.seller_type
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pr_products_ensure_seller ON pr_products;
CREATE TRIGGER trg_pr_products_ensure_seller
  AFTER INSERT OR UPDATE OF
    seller_name,
    seller_name_cn,
    seller_purchase_channel,
    seller_type
  ON pr_products
  FOR EACH ROW
  EXECUTE FUNCTION fn_pr_products_ensure_seller_row();

COMMENT ON FUNCTION fn_pr_products_ensure_seller_row() IS
  'เมื่อมี seller_name ในสินค้า ให้ upsert pr_sellers พร้อม metadata จากสินค้า';

-- RPC ซิงก์ย้อนหลัง: aggregate ตามชื่อผู้ขาย แล้ว upsert ครบ
CREATE OR REPLACE FUNCTION rpc_sync_pr_sellers_from_products()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_inserted INT := 0;
  v_updated INT := 0;
  rec RECORD;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ซิงก์รายชื่อผู้ขาย';
  END IF;

  FOR rec IN
    SELECT
      TRIM(seller_name) AS name,
      MAX(NULLIF(TRIM(seller_name_cn), '')) AS name_cn,
      MAX(NULLIF(TRIM(seller_purchase_channel), '')) AS purchase_channel,
      CASE
        WHEN COUNT(*) FILTER (WHERE fn_normalize_seller_type(seller_type) = 'thailand') >
             COUNT(*) FILTER (WHERE fn_normalize_seller_type(seller_type) = 'foreign')
          THEN 'thailand'
        WHEN COUNT(*) FILTER (WHERE fn_normalize_seller_type(seller_type) = 'foreign') > 0
          THEN 'foreign'
        ELSE NULL
      END AS seller_type
    FROM pr_products
    WHERE seller_name IS NOT NULL AND TRIM(seller_name) <> ''
    GROUP BY TRIM(seller_name)
  LOOP
    IF EXISTS (SELECT 1 FROM pr_sellers WHERE name = rec.name) THEN
      v_updated := v_updated + 1;
    ELSE
      v_inserted := v_inserted + 1;
    END IF;

    PERFORM fn_upsert_pr_seller_from_product(
      rec.name,
      rec.name_cn,
      rec.purchase_channel,
      rec.seller_type
    );
  END LOOP;

  RETURN jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'synced_from_products', v_inserted + v_updated
  );
END;
$$;

COMMENT ON FUNCTION rpc_sync_pr_sellers_from_products() IS
  'ดึงชื่อและ metadata ผู้ขายจาก pr_products เข้า pr_sellers (upsert); เรียกได้เฉพาะ superadmin, admin';

-- ปรับ RPC import ให้รับ metadata ผู้ขาย (trigger จะ upsert pr_sellers ให้)
CREATE OR REPLACE FUNCTION rpc_bulk_import_products_with_stock(items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role           TEXT;
  item             JSONB;
  v_product_id     UUID;
  v_product_code   TEXT;
  v_initial_stock  NUMERIC;
  v_safety_stock   NUMERIC;
  v_unit_cost      NUMERIC;
  v_on_hand        NUMERIC;
  v_imported       INT := 0;
  v_skipped        INT := 0;
  v_errors         JSONB := '[]'::JSONB;
  v_order_days_raw TEXT;
  v_order_days     INTEGER;
  v_seller_type    TEXT;
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

    v_order_days_raw := NULLIF(TRIM(COALESCE(item->>'order_point_days', '')), '');
    v_order_days := CASE
      WHEN v_order_days_raw IS NULL THEN NULL
      WHEN v_order_days_raw !~ '^[0-9]+(\.[0-9]+)?$' THEN NULL
      ELSE FLOOR(v_order_days_raw::NUMERIC)::INTEGER
    END;

    v_seller_type := fn_normalize_seller_type(item->>'seller_type');
    IF item ? 'seller_type'
       AND NULLIF(TRIM(COALESCE(item->>'seller_type', '')), '') IS NOT NULL
       AND v_seller_type IS NULL THEN
      v_errors := v_errors || jsonb_build_object(
        'product_code', v_product_code,
        'error', 'seller_type ไม่ถูกต้อง (ใช้ thailand หรือ foreign)'
      );
      CONTINUE;
    END IF;

    IF v_safety_stock > v_initial_stock THEN
      v_safety_stock := v_initial_stock;
    END IF;

    v_on_hand := v_initial_stock - v_safety_stock;

    BEGIN
      INSERT INTO pr_products (
        product_code, product_name, product_category, product_type,
        seller_name, seller_name_cn, seller_purchase_channel, seller_type,
        product_name_cn, order_point, order_point_days,
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
        NULLIF(item->>'seller_name_cn', ''),
        NULLIF(item->>'seller_purchase_channel', ''),
        v_seller_type,
        NULLIF(item->>'product_name_cn', ''),
        NULLIF(item->>'order_point', ''),
        v_order_days,
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

GRANT EXECUTE ON FUNCTION fn_normalize_seller_type(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_upsert_pr_seller_from_product(TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_sync_pr_sellers_from_products() TO authenticated;
