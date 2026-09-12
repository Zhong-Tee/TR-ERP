-- =====================================================================
-- Fix: ให้ทุก role ที่เกี่ยวข้องสามารถอนุมัติ/ปฏิเสธ รายการคืนได้
-- Roles ที่ต้อง approve ได้: superadmin, admin, store, manager, production
-- วิธี: สร้าง SECURITY DEFINER RPC function เพื่อ bypass RLS
-- =====================================================================

-- 1) RPC function สำหรับอนุมัติใบคืน (SECURITY DEFINER = bypass RLS)
CREATE OR REPLACE FUNCTION approve_return_requisition(
  p_return_id UUID,
  p_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_status TEXT;
  v_item RECORD;
BEGIN
  -- ตรวจสอบ role
  SELECT role INTO v_role FROM us_users WHERE id = p_user_id;
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','store','manager','production') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติรายการคืน (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  -- ตรวจสอบสถานะ
  SELECT status INTO v_status FROM wms_return_requisitions WHERE id = p_return_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'ไม่พบรายการคืน';
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'รายการนี้ไม่อยู่ในสถานะรออนุมัติ (status: %)', v_status;
  END IF;

  -- ปรับสต๊อค: เพิ่มกลับตามรายการ
  FOR v_item IN
    SELECT product_id, qty FROM wms_return_requisition_items
    WHERE return_requisition_id = p_return_id
  LOOP
    -- upsert stock balance
    INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_item.product_id, v_item.qty, 0, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET on_hand = inv_stock_balances.on_hand + v_item.qty;

    -- บันทึก movement
    INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note)
    VALUES (
      v_item.product_id,
      'return_requisition',
      v_item.qty,
      'wms_return_requisitions',
      p_return_id,
      'อนุมัติใบคืน (RPC)'
    );
  END LOOP;

  -- อัปเดตสถานะเป็น approved
  UPDATE wms_return_requisitions
  SET status = 'approved',
      approved_by = p_user_id,
      approved_at = NOW()
  WHERE id = p_return_id;
END;
$$;

-- 2) RPC function สำหรับปฏิเสธใบคืน
CREATE OR REPLACE FUNCTION reject_return_requisition(
  p_return_id UUID,
  p_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_status TEXT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = p_user_id;
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','store','manager','production') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ปฏิเสธรายการคืน (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT status INTO v_status FROM wms_return_requisitions WHERE id = p_return_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'ไม่พบรายการคืน';
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'รายการนี้ไม่อยู่ในสถานะรออนุมัติ (status: %)', v_status;
  END IF;

  UPDATE wms_return_requisitions
  SET status = 'rejected',
      approved_by = p_user_id,
      approved_at = NOW()
  WHERE id = p_return_id;
END;
$$;

-- 3) สำรอง: อัปเดต RLS ให้ครอบคลุมทุก role ที่ต้องการ
-- (กันกรณีที่ migration 090 ถูก apply ก่อนที่จะเพิ่ม inv_stock changes)

DROP POLICY IF EXISTS "Admins can manage stock balances" ON inv_stock_balances;
CREATE POLICY "Admins can manage stock balances"
  ON inv_stock_balances FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','admin-tr','store','manager','production'))
  );

DROP POLICY IF EXISTS "Admins can manage stock movements" ON inv_stock_movements;
CREATE POLICY "Admins can manage stock movements"
  ON inv_stock_movements FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','admin-tr','store','manager','production'))
  );

DROP POLICY IF EXISTS "Admins can manage return requisitions" ON wms_return_requisitions;
CREATE POLICY "Admins can manage return requisitions"
  ON wms_return_requisitions FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store','manager','production'))
  );

-- 4) เพิ่ม store ใน us_users SELECT policy เพื่อให้ดูชื่อผู้ใช้คนอื่นได้
DROP POLICY IF EXISTS "Admins can view all users" ON us_users;
CREATE POLICY "Admins can view all users"
  ON us_users FOR SELECT
  USING (
    auth.uid() = id OR
    check_user_role(auth.uid(), ARRAY['superadmin','admin','admin-tr','manager','store','production'])
  );
