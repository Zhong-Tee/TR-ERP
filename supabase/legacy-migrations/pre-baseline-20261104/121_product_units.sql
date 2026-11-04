-- ═══════════════════════════════════════════════════════════════════
-- Migration 121: Product Units (หน่วยสินค้า)
-- เพิ่มระบบหน่วยขายสินค้า + ปรับ trigger ตัดสต๊อกตามตัวคูณ
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1. เพิ่มคอลัมน์หน่วยสินค้าใน pr_products ───────────────────

ALTER TABLE pr_products ADD COLUMN IF NOT EXISTS unit_name TEXT DEFAULT 'ชิ้น';
ALTER TABLE pr_products ADD COLUMN IF NOT EXISTS unit_multiplier NUMERIC(10,2) DEFAULT 1;

-- ป้องกัน multiplier <= 0
DO $$ BEGIN
  ALTER TABLE pr_products ADD CONSTRAINT chk_unit_multiplier_positive
    CHECK (unit_multiplier > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── 2. ปรับ trigger ตัดสต๊อก — คูณ qty × unit_multiplier ──────

CREATE OR REPLACE FUNCTION inv_deduct_stock_on_wms_picked()
RETURNS TRIGGER AS $$
DECLARE
  v_product_id    UUID;
  v_movement_id   UUID;
  v_unit_mult     NUMERIC := 1;
  v_actual_qty    NUMERIC;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;

  SELECT id, COALESCE(unit_multiplier, 1)
  INTO v_product_id, v_unit_mult
  FROM pr_products
  WHERE product_code = NEW.product_code
  LIMIT 1;

  IF v_product_id IS NULL THEN RETURN NEW; END IF;

  -- จำนวนจริงที่ส่งผลต่อสต๊อก = qty ในใบงาน × ตัวคูณหน่วย
  v_actual_qty := NEW.qty * v_unit_mult;

  -- Reserve: status → picked
  IF NEW.status = 'picked'
     AND (OLD.status IS NULL OR OLD.status NOT IN ('picked', 'correct'))
  THEN
    UPDATE inv_stock_balances
      SET reserved = COALESCE(reserved, 0) + v_actual_qty
      WHERE product_id = v_product_id;
    IF NOT FOUND THEN
      INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES (v_product_id, 0, v_actual_qty, 0);
    END IF;
  END IF;

  -- Deduct: status → correct
  IF NEW.status = 'correct'
     AND (OLD.status IS NULL OR OLD.status <> 'correct')
  THEN
    UPDATE inv_stock_balances
      SET on_hand  = COALESCE(on_hand, 0) - v_actual_qty,
          reserved = GREATEST(COALESCE(reserved, 0) - v_actual_qty, 0)
      WHERE product_id = v_product_id;
    IF NOT FOUND THEN
      INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES (v_product_id, -v_actual_qty, 0, 0);
    END IF;

    INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note)
    VALUES (v_product_id, 'pick', -v_actual_qty, 'wms_orders', NEW.id, 'ตัดสต๊อคเมื่อตรวจสอบถูกต้อง')
    RETURNING id INTO v_movement_id;

    PERFORM fn_consume_stock_fifo(v_product_id, v_actual_qty, v_movement_id);
    PERFORM fn_recalc_product_landed_cost(v_product_id);
  END IF;

  -- Out of stock: ปลด reserve
  IF NEW.status = 'out_of_stock'
     AND OLD.status = 'picked'
  THEN
    UPDATE inv_stock_balances
      SET reserved = GREATEST(COALESCE(reserved, 0) - v_actual_qty, 0)
      WHERE product_id = v_product_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
