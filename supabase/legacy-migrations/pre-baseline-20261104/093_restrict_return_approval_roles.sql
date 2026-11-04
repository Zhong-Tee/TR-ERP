-- =====================================================================
-- Restrict return approval permissions:
-- role store, production must NOT approve/reject return requisitions
-- allowed approvers: superadmin, admin, manager
-- =====================================================================

-- 1) Tighten RPC role checks
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
  SELECT role INTO v_role FROM us_users WHERE id = p_user_id;
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','manager') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติรายการคืน (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT status INTO v_status FROM wms_return_requisitions WHERE id = p_return_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'ไม่พบรายการคืน';
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'รายการนี้ไม่อยู่ในสถานะรออนุมัติ (status: %)', v_status;
  END IF;

  FOR v_item IN
    SELECT product_id, qty
    FROM wms_return_requisition_items
    WHERE return_requisition_id = p_return_id
  LOOP
    INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_item.product_id, v_item.qty, 0, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET on_hand = inv_stock_balances.on_hand + v_item.qty;

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

  UPDATE wms_return_requisitions
  SET status = 'approved',
      approved_by = p_user_id,
      approved_at = NOW()
  WHERE id = p_return_id;
END;
$$;

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
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','manager') THEN
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

-- 2) Tighten direct table update policy as defense-in-depth
DROP POLICY IF EXISTS "Admins can manage return requisitions" ON wms_return_requisitions;
CREATE POLICY "Admins can manage return requisitions"
  ON wms_return_requisitions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','manager')
    )
  );
