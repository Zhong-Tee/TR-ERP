-- Count adjustment items in PostgreSQL instead of downloading every item through
-- PostgREST, whose row limit can make newer adjustments incorrectly appear empty.
CREATE OR REPLACE FUNCTION public.rpc_inventory_adjustment_item_counts()
RETURNS TABLE (
  adjustment_id uuid,
  item_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT item.adjustment_id, count(*)::bigint AS item_count
  FROM public.inv_adjustment_items item
  GROUP BY item.adjustment_id;
$$;

REVOKE ALL ON FUNCTION public.rpc_inventory_adjustment_item_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_inventory_adjustment_item_counts() TO authenticated, service_role;

COMMENT ON FUNCTION public.rpc_inventory_adjustment_item_counts() IS
  'Returns an exact server-side item count for every inventory adjustment.';

NOTIFY pgrst, 'reload schema';
