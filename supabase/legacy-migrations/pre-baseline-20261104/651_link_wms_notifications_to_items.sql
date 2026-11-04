BEGIN;

ALTER TABLE public.wms_notifications
  ADD COLUMN wms_order_id uuid REFERENCES public.wms_orders(id) ON DELETE SET NULL,
  ADD COLUMN product_code text,
  ADD COLUMN product_name text,
  ADD COLUMN location text;
CREATE INDEX idx_wms_notifications_wms_order_id ON public.wms_notifications(wms_order_id)
  WHERE wms_order_id IS NOT NULL;

-- Snapshots preserve what was reported even if a WMS job is later removed.
CREATE FUNCTION public.fn_snapshot_wms_notification_item()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_item public.wms_orders%ROWTYPE;
BEGIN
  IF NEW.wms_order_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_item FROM public.wms_orders WHERE id=NEW.wms_order_id;
  IF NOT FOUND OR v_item.order_id IS DISTINCT FROM NEW.order_id THEN
    RAISE EXCEPTION 'รายการสินค้าแจ้งเตือนไม่ตรงกับใบงาน';
  END IF;
  NEW.product_code:=v_item.product_code;
  NEW.product_name:=v_item.product_name;
  NEW.location:=v_item.location;
  RETURN NEW;
END $$;
CREATE TRIGGER snapshot_wms_notification_item
BEFORE INSERT OR UPDATE OF wms_order_id, order_id ON public.wms_notifications
FOR EACH ROW EXECUTE FUNCTION public.fn_snapshot_wms_notification_item();
REVOKE ALL ON FUNCTION public.fn_snapshot_wms_notification_item() FROM PUBLIC,anon,authenticated;

-- This incident was verified against the live seven-line requisition.
-- Repair only its known notification; do not guess links for other history.
UPDATE public.wms_notifications n
SET wms_order_id=w.id
FROM public.wms_orders w
WHERE n.id='bea8de6e-1b31-477f-9431-22e17607d556'::uuid
  AND n.order_id='REQ-20261014-001' AND n.type='สินค้าหมด (X)'
  AND n.wms_order_id IS NULL
  AND w.id='4da60744-a1b2-4a24-9b4b-87b4c8af4ea5'::uuid
  AND w.order_id=n.order_id AND w.product_code='990000055';

NOTIFY pgrst,'reload schema';
COMMIT;
