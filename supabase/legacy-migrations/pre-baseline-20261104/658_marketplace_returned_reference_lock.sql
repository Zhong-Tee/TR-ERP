BEGIN;

CREATE FUNCTION public.guard_marketplace_returned_references()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.source_marketplace_order_id IS NOT NULL AND OLD.status='ลงข้อมูลผิด' AND (
    nullif(btrim(NEW.channel_order_no),'') IS DISTINCT FROM nullif(btrim(OLD.channel_order_no),'') OR
    nullif(btrim(NEW.tracking_number),'') IS DISTINCT FROM nullif(btrim(OLD.tracking_number),'')
  ) THEN
    RAISE EXCEPTION 'บิล Marketplace ที่ลงข้อมูลผิด ไม่สามารถแก้ไขเลขคำสั่งซื้อหรือเลขพัสดุได้';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_guard_marketplace_returned_references BEFORE UPDATE ON public.or_orders
FOR EACH ROW EXECUTE FUNCTION public.guard_marketplace_returned_references();

COMMIT;
