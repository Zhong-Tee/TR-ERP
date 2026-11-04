-- จำกัด rpc_sync_pr_sellers_from_products ให้เรียกได้เฉพาะ superadmin, admin (แทนชุด role เดิม)
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
  'ดึงชื่อผู้ขายที่ไม่ซ้ำจาก pr_products เข้า pr_sellers (เฉพาะแถวใหม่); เรียกได้เฉพาะ superadmin, admin';
