BEGIN;

-- Imported SKU mappings are source data. Sales may customize an item, not substitute its product.
CREATE FUNCTION public.guard_marketplace_draft_product_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.raw_snapshot IS NOT NULL AND (
    NEW.product_id IS DISTINCT FROM OLD.product_id OR
    NEW.product_name_raw IS DISTINCT FROM OLD.product_name_raw OR
    NEW.sku_ref IS DISTINCT FROM OLD.sku_ref OR
    NEW.raw_snapshot IS DISTINCT FROM OLD.raw_snapshot OR
    NEW.mp_order_id IS DISTINCT FROM OLD.mp_order_id
  ) THEN
    RAISE EXCEPTION 'ไม่สามารถเปลี่ยนสินค้า Marketplace ได้ กรุณาแจ้งแก้ไข SKU ต้นทาง';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_guard_marketplace_draft_product_identity BEFORE UPDATE ON public.mp_order_items
FOR EACH ROW EXECUTE FUNCTION public.guard_marketplace_draft_product_identity();

CREATE FUNCTION public.guard_marketplace_bill_product_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_marketplace boolean; v_system_gift boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.or_orders
    WHERE id IN (OLD.order_id,NEW.order_id) AND source_marketplace_order_id IS NOT NULL)
    INTO v_marketplace;
  IF NOT v_marketplace THEN RETURN NEW; END IF;
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR
     NEW.source_mp_order_item_id IS DISTINCT FROM OLD.source_mp_order_item_id THEN
    RAISE EXCEPTION 'ไม่สามารถเปลี่ยนต้นทางรายการสินค้า Marketplace ได้';
  END IF;
  IF NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.product_name IS DISTINCT FROM OLD.product_name THEN
    -- Automatic free ink gifts may change when ink changes. Imported free items remain locked.
    SELECT EXISTS(SELECT 1 FROM public.mp_order_items d
      WHERE d.id=OLD.source_mp_order_item_id AND d.raw_snapshot IS NULL AND d.is_free
        AND OLD.is_free AND NEW.is_free) INTO v_system_gift;
    IF NOT v_system_gift THEN
      RAISE EXCEPTION 'ไม่สามารถเปลี่ยนสินค้า Marketplace ได้ กรุณาแจ้งแก้ไข SKU ต้นทาง';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_guard_marketplace_bill_product_identity BEFORE UPDATE ON public.or_order_items
FOR EACH ROW EXECUTE FUNCTION public.guard_marketplace_bill_product_identity();

COMMIT;
