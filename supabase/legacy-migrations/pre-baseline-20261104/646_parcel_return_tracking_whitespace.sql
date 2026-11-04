BEGIN;

-- Match scanned barcodes against existing tracking numbers regardless of
-- whitespace/case, without rewriting the original shipping data.
CREATE INDEX IF NOT EXISTS idx_or_orders_shipped_normalized_tracking
ON public.or_orders (
  upper(regexp_replace(coalesce(tracking_number, ''), '[[:space:]]+', '', 'g'))
)
WHERE status = 'จัดส่งแล้ว';

CREATE OR REPLACE FUNCTION public.find_shipped_order_for_parcel_return(p_tracking text)
RETURNS SETOF public.or_orders
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  SELECT o.*
  FROM public.or_orders o
  WHERE o.status = 'จัดส่งแล้ว'
    AND upper(regexp_replace(coalesce(p_tracking, ''), '[[:space:]]+', '', 'g')) <> ''
    AND upper(regexp_replace(coalesce(o.tracking_number, ''), '[[:space:]]+', '', 'g'))
      = upper(regexp_replace(coalesce(p_tracking, ''), '[[:space:]]+', '', 'g'))
  ORDER BY o.id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.find_shipped_order_for_parcel_return(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_shipped_order_for_parcel_return(text) TO authenticated;
NOTIFY pgrst, 'reload schema';

COMMIT;
