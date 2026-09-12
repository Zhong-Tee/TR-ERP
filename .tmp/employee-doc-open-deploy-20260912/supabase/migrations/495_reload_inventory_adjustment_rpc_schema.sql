-- Force PostgREST to discover the inventory-adjustment creation RPC after deploy.
DO $$
BEGIN
  IF to_regprocedure('public.rpc_create_inventory_adjustment(text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'rpc_create_inventory_adjustment was not installed by migration 492';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
