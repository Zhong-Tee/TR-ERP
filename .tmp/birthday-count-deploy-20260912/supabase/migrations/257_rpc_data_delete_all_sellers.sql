-- 257: Delete all seller master data (superadmin only)
-- Requires transactional data to be cleared first (same blockers as delete products).

CREATE OR REPLACE FUNCTION rpc_data_delete_all_sellers(
  p_confirm_text TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_seller_count BIGINT;
  v_deleted BIGINT := 0;
  v_blockers JSONB;
BEGIN
  PERFORM erp_data_assert_superadmin();

  IF COALESCE(p_confirm_text, '') <> 'DELETE ALL SELLERS' THEN
    RAISE EXCEPTION 'ข้อความยืนยันไม่ถูกต้อง ต้องพิมพ์: DELETE ALL SELLERS';
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

  SELECT COUNT(*) INTO v_seller_count FROM pr_sellers;

  DELETE FROM pr_sellers WHERE id IS NOT NULL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_sellers', v_deleted,
    'previous_seller_count', v_seller_count,
    'hr_policy', 'preserved',
    'note', 'ชื่อผู้ขายในสินค้า (seller_name) ยังอยู่ — ซิงก์จากสินค้าหรือเพิ่มมือใหม่ได้'
  );
END;
$$;

REVOKE ALL ON FUNCTION rpc_data_delete_all_sellers(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_data_delete_all_sellers(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_data_delete_all_sellers(TEXT) TO service_role;
