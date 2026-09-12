-- New sample receipts must contain exactly one item.
BEGIN;

CREATE OR REPLACE FUNCTION public.tr_inv_sample_items_single_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.inv_sample_items
    WHERE sample_id = NEW.sample_id AND id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'สินค้าตัวอย่างหนึ่งใบรับสามารถมีได้เพียง 1 รายการ';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inv_sample_items_single_item ON public.inv_sample_items;
CREATE TRIGGER inv_sample_items_single_item
  BEFORE INSERT OR UPDATE OF sample_id ON public.inv_sample_items
  FOR EACH ROW EXECUTE FUNCTION public.tr_inv_sample_items_single_item();

COMMIT;
