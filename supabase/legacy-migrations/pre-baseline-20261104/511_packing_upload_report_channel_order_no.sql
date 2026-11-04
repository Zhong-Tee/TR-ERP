-- Show the marketplace/channel order number in the Packing upload report.

ALTER TABLE public.pk_packing_upload_queue_reports
  ADD COLUMN IF NOT EXISTS channel_order_no TEXT;

CREATE OR REPLACE FUNCTION public.pk_fill_packing_upload_report_channel_order_no()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Keep an already-known value when an older browser syncs a legacy queue item.
  IF TG_OP = 'UPDATE' AND NEW.channel_order_no IS NULL THEN
    NEW.channel_order_no := OLD.channel_order_no;
  END IF;

  IF NEW.channel_order_no IS NULL THEN
    SELECT orders.channel_order_no
      INTO NEW.channel_order_no
    FROM public.or_orders orders
    WHERE orders.work_order_name = NEW.work_order_name
      AND LOWER(REGEXP_REPLACE(COALESCE(orders.tracking_number, ''), '[[:space:]]+', '', 'g'))
          = LOWER(REGEXP_REPLACE(COALESCE(NEW.tracking_number, ''), '[[:space:]]+', '', 'g'))
      AND orders.channel_order_no IS NOT NULL
    ORDER BY orders.updated_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pk_fill_packing_upload_report_channel_order_no
  ON public.pk_packing_upload_queue_reports;
CREATE TRIGGER trg_pk_fill_packing_upload_report_channel_order_no
  BEFORE INSERT OR UPDATE ON public.pk_packing_upload_queue_reports
  FOR EACH ROW EXECUTE FUNCTION public.pk_fill_packing_upload_report_channel_order_no();

-- Backfill existing report rows by work order + whitespace-insensitive tracking.
WITH matched_orders AS (
  SELECT DISTINCT ON (report.id)
    report.id AS report_id,
    orders.channel_order_no
  FROM public.pk_packing_upload_queue_reports report
  JOIN public.or_orders orders
    ON orders.work_order_name = report.work_order_name
   AND LOWER(REGEXP_REPLACE(COALESCE(orders.tracking_number, ''), '[[:space:]]+', '', 'g'))
       = LOWER(REGEXP_REPLACE(COALESCE(report.tracking_number, ''), '[[:space:]]+', '', 'g'))
  WHERE report.channel_order_no IS NULL
    AND orders.channel_order_no IS NOT NULL
  ORDER BY report.id, orders.updated_at DESC NULLS LAST
)
UPDATE public.pk_packing_upload_queue_reports report
SET channel_order_no = matched_orders.channel_order_no
FROM matched_orders
WHERE report.id = matched_orders.report_id;
