-- ============================================
-- RPC Functions สำหรับ Bulk Stock Operations
-- ลดจำนวน API calls จากหลักร้อย/หลักพันเหลือ 1-3 calls
-- ============================================

-- 1. bulk_adjust_stock: ปรับสต๊อค + บันทึก movement ทั้ง batch ในครั้งเดียว
CREATE OR REPLACE FUNCTION bulk_adjust_stock(items JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  item JSONB;
  v_product_id UUID;
  v_qty_delta NUMERIC(12,2);
  v_movement_type TEXT;
  v_ref_type TEXT;
  v_ref_id UUID;
  v_note TEXT;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    v_product_id   := (item->>'product_id')::UUID;
    v_qty_delta    := (item->>'qty_delta')::NUMERIC;
    v_movement_type := item->>'movement_type';
    v_ref_type     := item->>'ref_type';
    v_ref_id       := CASE WHEN item->>'ref_id' IS NOT NULL THEN (item->>'ref_id')::UUID ELSE NULL END;
    v_note         := item->>'note';

    -- Upsert stock balance
    INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_product_id, v_qty_delta, 0, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET on_hand = inv_stock_balances.on_hand + v_qty_delta;

    -- Insert stock movement
    INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note)
    VALUES (v_product_id, v_movement_type, v_qty_delta, v_ref_type, v_ref_id, v_note);
  END LOOP;
END;
$$;

-- 2. bulk_update_safety_stock: อัปเดต safety_stock ทั้ง batch ในครั้งเดียว
CREATE OR REPLACE FUNCTION bulk_update_safety_stock(items JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  item JSONB;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    UPDATE inv_stock_balances
    SET safety_stock = (item->>'safety_stock')::NUMERIC
    WHERE product_id = (item->>'product_id')::UUID;
  END LOOP;
END;
$$;

-- 3. bulk_update_order_point: อัปเดต order_point ใน pr_products ทั้ง batch ในครั้งเดียว
CREATE OR REPLACE FUNCTION bulk_update_order_point(items JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  item JSONB;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    UPDATE pr_products
    SET order_point = item->>'order_point'
    WHERE id = (item->>'product_id')::UUID;
  END LOOP;
END;
$$;
