-- ============================================
-- 150: Guard opening bill when sellable stock is zero/insufficient
-- - Block or_order_items insert/update when available_to_sell is not enough
-- - available_to_sell = on_hand - reserved
-- - Compare in base units (quantity * unit_multiplier)
-- ============================================

CREATE OR REPLACE FUNCTION fn_guard_or_order_items_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_on_hand        NUMERIC := 0;
  v_reserved       NUMERIC := 0;
  v_available      NUMERIC := 0;
  v_unit_mult      NUMERIC := 1;
  v_new_qty_base   NUMERIC := 0;
  v_other_qty_base NUMERIC := 0;
  v_product_code   TEXT := '';
BEGIN
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.product_id = OLD.product_id
     AND COALESCE(NEW.quantity, 0) = COALESCE(OLD.quantity, 0) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(unit_multiplier, 1), COALESCE(product_code, '')
  INTO v_unit_mult, v_product_code
  FROM pr_products
  WHERE id = NEW.product_id;

  v_new_qty_base := COALESCE(NEW.quantity, 0) * GREATEST(v_unit_mult, 0.01);
  IF v_new_qty_base <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(on_hand, 0), COALESCE(reserved, 0)
  INTO v_on_hand, v_reserved
  FROM inv_stock_balances
  WHERE product_id = NEW.product_id;

  v_available := v_on_hand - v_reserved;

  SELECT COALESCE(SUM(oi.quantity * GREATEST(COALESCE(pp.unit_multiplier, 1), 0.01)), 0)
  INTO v_other_qty_base
  FROM or_order_items oi
  JOIN pr_products pp ON pp.id = oi.product_id
  WHERE oi.order_id = NEW.order_id
    AND oi.product_id = NEW.product_id
    AND (TG_OP <> 'UPDATE' OR oi.id <> OLD.id);

  IF v_available <= 0 OR (v_other_qty_base + v_new_qty_base) > v_available THEN
    RAISE EXCEPTION
      'ไม่สามารถเปิดบิลได้: สินค้า % คงเหลือขายได้ % แต่ต้องการ %',
      COALESCE(NULLIF(v_product_code, ''), NEW.product_id::TEXT),
      v_available,
      (v_other_qty_base + v_new_qty_base);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_or_order_items_stock ON or_order_items;
CREATE TRIGGER trg_guard_or_order_items_stock
BEFORE INSERT OR UPDATE OF product_id, quantity ON or_order_items
FOR EACH ROW
EXECUTE FUNCTION fn_guard_or_order_items_stock();

