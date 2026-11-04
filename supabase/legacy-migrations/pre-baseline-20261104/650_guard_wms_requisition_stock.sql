BEGIN;

-- Validate in product units; safety stock is already separate from on_hand.
CREATE FUNCTION public.fn_check_requisition_stock(p_code text, p_qty numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_product public.pr_products%ROWTYPE; v_available numeric := 0;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 OR p_qty::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'จำนวนเบิกสินค้า % ต้องมากกว่า 0', p_code;
  END IF;
  SELECT * INTO v_product FROM public.pr_products WHERE product_code = p_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบสินค้า %', p_code; END IF;
  SELECT COALESCE(on_hand, 0) - COALESCE(reserved, 0) INTO v_available
  FROM public.inv_stock_balances WHERE product_id = v_product.id FOR UPDATE;
  v_available := GREATEST(COALESCE(v_available, 0), 0);
  IF p_qty > v_available THEN
    RAISE EXCEPTION 'สินค้า % - % เบิกได้ไม่เกิน % % (ยอดพร้อมเบิกหลังหักจอง)',
      p_code, v_product.product_name, v_available, COALESCE(NULLIF(BTRIM(v_product.unit_name), ''), 'ชิ้น');
  END IF;
END $$;

CREATE FUNCTION public.fn_guard_requisition_item_stock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_status text; v_total numeric;
BEGIN
  -- Serialize changes to a document, including duplicate product lines.
  SELECT status INTO v_status FROM public.wms_requisitions
  WHERE requisition_id = NEW.requisition_id FOR UPDATE;
  IF NOT FOUND OR v_status <> 'pending' THEN
    RAISE EXCEPTION 'เพิ่มหรือแก้ไขสินค้าได้เฉพาะใบเบิกรออนุมัติ';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.requisition_id IS DISTINCT FROM OLD.requisition_id THEN
    RAISE EXCEPTION 'ไม่สามารถย้ายรายการไปใบเบิกอื่น';
  END IF;
  -- Validate the line separately so a negative line cannot offset another line.
  PERFORM public.fn_check_requisition_stock(NEW.product_code, NEW.qty);
  SELECT COALESCE(SUM(qty), 0) + NEW.qty INTO v_total
  FROM public.wms_requisition_items
  WHERE requisition_id = NEW.requisition_id AND product_code = NEW.product_code
    AND id IS DISTINCT FROM NEW.id;
  PERFORM public.fn_check_requisition_stock(NEW.product_code, v_total);
  RETURN NEW;
END $$;
CREATE TRIGGER guard_requisition_item_stock
BEFORE INSERT OR UPDATE OF product_code, qty, requisition_id ON public.wms_requisition_items
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_requisition_item_stock();

CREATE FUNCTION public.fn_guard_requisition_approval_stock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  IF NEW.status = 'approved' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
    IF NOT EXISTS (SELECT 1 FROM public.wms_requisition_items WHERE requisition_id = NEW.requisition_id) THEN
      RAISE EXCEPTION 'ใบเบิกนี้ไม่มีรายการสินค้า';
    END IF;
    IF EXISTS (SELECT 1 FROM public.wms_requisition_items WHERE requisition_id = NEW.requisition_id
      AND (qty IS NULL OR qty <= 0 OR qty::text IN ('NaN', 'Infinity', '-Infinity'))) THEN
      RAISE EXCEPTION 'จำนวนเบิกสินค้าต้องมากกว่า 0';
    END IF;
    FOR r IN SELECT product_code, SUM(qty) AS qty FROM public.wms_requisition_items
      WHERE requisition_id = NEW.requisition_id GROUP BY product_code ORDER BY product_code
    LOOP PERFORM public.fn_check_requisition_stock(r.product_code, r.qty); END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_requisition_approval_stock
BEFORE INSERT OR UPDATE OF status ON public.wms_requisitions
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_requisition_approval_stock();

-- Pending requests do not reserve stock. Recheck under the balance lock when
-- picking, before the existing AFTER trigger reserves it, to prevent two
-- concurrent requests from reserving the same remaining units.
CREATE FUNCTION public.fn_guard_requisition_pick_stock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'picked' AND OLD.status IS DISTINCT FROM 'picked'
     AND OLD.status IS DISTINCT FROM 'correct'
     AND EXISTS (SELECT 1 FROM public.wms_requisitions WHERE requisition_id = NEW.order_id) THEN
    PERFORM public.fn_check_requisition_stock(NEW.product_code, NEW.qty);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_requisition_pick_stock BEFORE UPDATE OF status ON public.wms_orders
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_requisition_pick_stock();

REVOKE ALL ON FUNCTION public.fn_check_requisition_stock(text,numeric),
  public.fn_guard_requisition_item_stock(), public.fn_guard_requisition_approval_stock(),
  public.fn_guard_requisition_pick_stock() FROM PUBLIC, anon, authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
