-- ============================================
-- ปรับ Trigger ตัดสต๊อค: เพิ่มการคืนสต๊อคอัตโนมัติ
-- เมื่อ Admin ตรวจสินค้าแล้วเปลี่ยนสถานะเป็น wrong / not_find
-- ป้องกันสินค้าหายจากระบบโดยไม่มีเหตุผล
-- ============================================

CREATE OR REPLACE FUNCTION inv_deduct_stock_on_wms_picked()
RETURNS TRIGGER AS $$
DECLARE
  v_product_id UUID;
BEGIN
  -- ── ตัดสต๊อค: เมื่อ status เปลี่ยนเป็น picked/correct (จาก status อื่น) ──
  IF NEW.status IN ('picked', 'correct')
     AND (OLD.status IS NULL OR OLD.status NOT IN ('picked', 'correct'))
  THEN
    SELECT id INTO v_product_id FROM pr_products WHERE product_code = NEW.product_code LIMIT 1;
    IF v_product_id IS NULL THEN
      RETURN NEW;
    END IF;

    UPDATE inv_stock_balances
      SET on_hand = COALESCE(on_hand, 0) - NEW.qty
      WHERE product_id = v_product_id;
    IF NOT FOUND THEN
      INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES (v_product_id, -NEW.qty, 0, 0);
    END IF;

    INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note)
    VALUES (v_product_id, 'pick', -NEW.qty, 'wms_orders', NEW.id, 'ตัดสต๊อคเมื่อจัดสินค้าแล้ว');
  END IF;

  -- ── คืนสต๊อค: เมื่อ status เปลี่ยนจาก picked/correct → wrong/not_find ──
  IF NEW.status IN ('wrong', 'not_find')
     AND OLD.status IN ('picked', 'correct')
  THEN
    SELECT id INTO v_product_id FROM pr_products WHERE product_code = NEW.product_code LIMIT 1;
    IF v_product_id IS NOT NULL THEN
      UPDATE inv_stock_balances
        SET on_hand = COALESCE(on_hand, 0) + NEW.qty
        WHERE product_id = v_product_id;

      INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note)
      VALUES (v_product_id, 'return_pick', NEW.qty, 'wms_orders', NEW.id,
              'คืนสต๊อคอัตโนมัติ — ตรวจแล้วสถานะ: ' || NEW.status);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
