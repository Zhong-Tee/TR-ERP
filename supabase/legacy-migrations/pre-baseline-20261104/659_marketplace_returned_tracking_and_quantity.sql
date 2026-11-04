BEGIN;

-- Tracking may be corrected after rejection; the imported order number remains immutable.
CREATE OR REPLACE FUNCTION public.guard_marketplace_returned_references()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.source_marketplace_order_id IS NOT NULL AND OLD.status='ลงข้อมูลผิด' AND
     nullif(btrim(NEW.channel_order_no),'') IS DISTINCT FROM nullif(btrim(OLD.channel_order_no),'') THEN
    RAISE EXCEPTION 'บิล Marketplace ที่ลงข้อมูลผิด ไม่สามารถแก้ไขเลขคำสั่งซื้อได้';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_marketplace_returned_quantity()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.quantity IS DISTINCT FROM OLD.quantity AND EXISTS(
    SELECT 1 FROM public.or_orders WHERE id=OLD.order_id
      AND source_marketplace_order_id IS NOT NULL AND status='ลงข้อมูลผิด'
  ) THEN
    RAISE EXCEPTION 'บิล Marketplace ที่ลงข้อมูลผิด ไม่สามารถแก้ไขจำนวนสินค้าได้';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_guard_marketplace_returned_quantity BEFORE UPDATE ON public.or_order_items
FOR EACH ROW EXECUTE FUNCTION public.guard_marketplace_returned_quantity();

COMMIT;
