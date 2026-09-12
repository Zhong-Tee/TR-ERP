-- =============================================================================
-- 173: ซิงก์ชื่อผู้ขายจาก pr_products.seller_name เข้า pr_sellers อัตโนมัติ
-- - Backfill ครั้งเดียว
-- - Trigger หลัง INSERT/UPDATE seller_name บนสินค้า
-- - RPC สำหรับซิงก์ย้อนหลัง / เรียกจากหน้าตั้งค่า
-- =============================================================================

-- 1) Backfill: ชื่อที่มีในสินค้าแต่ยังไม่มีในมาสเตอร์
INSERT INTO pr_sellers (name)
SELECT DISTINCT TRIM(seller_name)
FROM pr_products
WHERE seller_name IS NOT NULL AND TRIM(seller_name) <> ''
ON CONFLICT (name) DO NOTHING;

-- 2) ฟังก์ชันทริกเกอร์ (SECURITY DEFINER เพื่อ insert ลง pr_sellers โดยไม่ถูก RLS บล็อก)
CREATE OR REPLACE FUNCTION fn_pr_products_ensure_seller_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v TEXT;
BEGIN
  v := TRIM(COALESCE(NEW.seller_name, ''));
  IF v <> '' THEN
    INSERT INTO pr_sellers (name)
    VALUES (v)
    ON CONFLICT (name) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pr_products_ensure_seller ON pr_products;
CREATE TRIGGER trg_pr_products_ensure_seller
  AFTER INSERT OR UPDATE OF seller_name ON pr_products
  FOR EACH ROW
  EXECUTE FUNCTION fn_pr_products_ensure_seller_row();

COMMENT ON FUNCTION fn_pr_products_ensure_seller_row() IS
  'เมื่อมี seller_name ในสินค้า ให้สร้างแถวใน pr_sellers (ถ้ายังไม่มี) เพื่อใช้ในดรอปดาวน์และตั้งค่าผู้ขาย';

-- 3) RPC ซิงก์ย้อนหลัง (เฉพาะ superadmin, admin)
CREATE OR REPLACE FUNCTION rpc_sync_pr_sellers_from_products()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_inserted INT := 0;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ซิงก์รายชื่อผู้ขาย';
  END IF;

  WITH ins AS (
    INSERT INTO pr_sellers (name)
    SELECT DISTINCT TRIM(seller_name)
    FROM pr_products
    WHERE seller_name IS NOT NULL AND TRIM(seller_name) <> ''
    ON CONFLICT (name) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*)::INT INTO v_inserted FROM ins;

  RETURN jsonb_build_object('inserted', v_inserted);
END;
$$;

COMMENT ON FUNCTION rpc_sync_pr_sellers_from_products() IS
  'ดึงชื่อผู้ขายที่ไม่ซ้ำจาก pr_products เข้า pr_sellers (เฉพาะแถวใหม่)';

GRANT EXECUTE ON FUNCTION rpc_sync_pr_sellers_from_products() TO authenticated;
