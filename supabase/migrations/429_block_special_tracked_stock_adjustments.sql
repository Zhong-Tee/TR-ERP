-- ST products are display-only aggregates of linked production SKUs. An
-- adjustment against the representative spare product would create unrelated
-- balances/lots and would not change the aggregate displayed in Warehouse.
BEGIN;

CREATE OR REPLACE FUNCTION public.guard_special_tracked_adjustment_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.wh_sub_wms_map_spares AS spare
    WHERE spare.product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'สินค้า ST ไม่สามารถสร้างใบปรับสต๊อคได้ กรุณาปรับ SKU สินค้าผลิตที่ผูกไว้แทน';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_special_tracked_adjustment_item
  ON public.inv_adjustment_items;
CREATE TRIGGER trg_guard_special_tracked_adjustment_item
  BEFORE INSERT OR UPDATE OF product_id
  ON public.inv_adjustment_items
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_special_tracked_adjustment_item();

CREATE OR REPLACE FUNCTION public.guard_special_tracked_adjustment_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'approved'
     AND OLD.status IS DISTINCT FROM 'approved'
     AND EXISTS (
       SELECT 1
       FROM public.inv_adjustment_items AS item
       JOIN public.wh_sub_wms_map_spares AS spare ON spare.product_id = item.product_id
       WHERE item.adjustment_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'ใบปรับนี้มีสินค้า ST จึงไม่สามารถอนุมัติได้ กรุณาสร้างใบใหม่โดยปรับ SKU สินค้าผลิตที่ผูกไว้แทน';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_special_tracked_adjustment_approval
  ON public.inv_adjustments;
CREATE TRIGGER trg_guard_special_tracked_adjustment_approval
  BEFORE UPDATE OF status
  ON public.inv_adjustments
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_special_tracked_adjustment_approval();

REVOKE ALL ON FUNCTION public.guard_special_tracked_adjustment_item() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_special_tracked_adjustment_approval() FROM PUBLIC;

COMMIT;
