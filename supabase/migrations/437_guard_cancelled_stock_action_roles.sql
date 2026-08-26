-- ป้องกันการปรับผลสต๊อคของบิลยกเลิกที่ฐานข้อมูล
-- UI อย่างเดียวไม่เพียงพอ เพราะสามารถเรียก SECURITY DEFINER RPC โดยตรงได้

CREATE OR REPLACE FUNCTION trg_guard_cancelled_stock_action_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_jwt_role text;
BEGIN
  IF NEW.stock_action IS NOT DISTINCT FROM OLD.stock_action THEN
    RETURN NEW;
  END IF;

  -- ตรวจเฉพาะการตัดสินผลรายการยกเลิก ไม่รบกวนการสร้าง/ยกเลิก WMS ปกติ
  IF NEW.stock_action IN ('recalled', 'waste') THEN
    v_jwt_role := COALESCE(current_setting('request.jwt.claim.role', true), '');
    IF v_jwt_role = 'service_role' THEN
      RETURN NEW;
    END IF;

    SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
    IF COALESCE(v_role, '') NOT IN ('superadmin', 'admin', 'store') THEN
      RAISE EXCEPTION 'ไม่มีสิทธิ์ปรับสต๊อคบิลยกเลิก (role: %)', COALESCE(v_role, 'unknown')
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wms_cancelled_stock_action_roles ON wms_orders;
CREATE TRIGGER trg_wms_cancelled_stock_action_roles
BEFORE UPDATE OF stock_action ON wms_orders
FOR EACH ROW
EXECUTE FUNCTION trg_guard_cancelled_stock_action_roles();

COMMENT ON FUNCTION trg_guard_cancelled_stock_action_roles() IS
'อนุญาตการตั้ง stock_action recalled/waste เฉพาะ superadmin, admin, store หรือ service_role';
