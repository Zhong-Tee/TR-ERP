-- =============================================================================
-- Migration 314: close public FIFO-cost access and harden related privileges
--
-- Security goals:
--   1. inv_lot_consumptions must never be accessed directly by browser roles.
--   2. FIFO helper functions are internal implementation details, not RPCs.
--   3. rpc_recalc_po_landed_cost remains available to the existing PO workflow,
--      but authorization is derived from auth.uid(), never from browser input.
--   4. User profiles are provisioned only by the trusted create-user Edge
--      Function; browser roles cannot create their own profile or role.
--
-- This migration is transactional and intentionally aborts if an unexpected
-- production-only policy exists on inv_lot_consumptions. That prevents an
-- undocumented policy from being silently removed or preserved.
-- =============================================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.inv_lot_consumptions') IS NULL THEN
    RAISE EXCEPTION
      'Security migration aborted: public.inv_lot_consumptions does not exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'inv_lot_consumptions'
  ) THEN
    RAISE EXCEPTION
      'Security migration aborted: unexpected policy exists on public.inv_lot_consumptions; audit it before applying migration 314';
  END IF;
END;
$$;

-- No browser workflow reads or writes this table directly. FIFO trigger/RPC
-- functions run with their owner's privileges, and server-side backup uses the
-- service role.
ALTER TABLE public.inv_lot_consumptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.inv_lot_consumptions FROM PUBLIC;
REVOKE ALL ON TABLE public.inv_lot_consumptions FROM anon;
REVOKE ALL ON TABLE public.inv_lot_consumptions FROM authenticated;
GRANT ALL ON TABLE public.inv_lot_consumptions TO service_role;

-- The original self-insert policy only checked auth.uid() = id, allowing a new
-- authenticated user to submit role = 'superadmin'. Profile provisioning is
-- already handled by the create-user Edge Function after a superadmin check.
DROP POLICY IF EXISTS "Users can insert their own data" ON public.us_users;
DROP POLICY IF EXISTS "Users can insert own store profile" ON public.us_users;
REVOKE INSERT ON TABLE public.us_users FROM anon;
REVOKE INSERT ON TABLE public.us_users FROM authenticated;
GRANT INSERT ON TABLE public.us_users TO service_role;

-- Lock the search path for internal FIFO routines. pg_catalog is first so that
-- built-ins cannot be shadowed; application relations resolve only in public.
ALTER FUNCTION public.fn_get_current_avg_cost(uuid)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.fn_consume_stock_fifo(uuid, numeric, uuid)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.fn_recalc_product_landed_cost(uuid)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.fn_update_product_landed_costs(uuid)
  SET search_path = pg_catalog, public;

-- Internal helpers must not be callable as public PostgREST RPC endpoints.
REVOKE ALL ON FUNCTION public.fn_get_current_avg_cost(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_get_current_avg_cost(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_get_current_avg_cost(uuid) FROM authenticated;

REVOKE ALL ON FUNCTION public.fn_consume_stock_fifo(uuid, numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_consume_stock_fifo(uuid, numeric, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_consume_stock_fifo(uuid, numeric, uuid) FROM authenticated;

REVOKE ALL ON FUNCTION public.fn_recalc_product_landed_cost(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_recalc_product_landed_cost(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_recalc_product_landed_cost(uuid) FROM authenticated;

REVOKE ALL ON FUNCTION public.fn_update_product_landed_costs(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_update_product_landed_costs(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_update_product_landed_costs(uuid) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.fn_get_current_avg_cost(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_consume_stock_fifo(uuid, numeric, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_recalc_product_landed_cost(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_update_product_landed_costs(uuid) TO service_role;

-- Preserve the existing browser-facing PO recalculation workflow while adding
-- server-side authorization. These are the current roles that can mutate PO
-- financial/shipping data after the purchase-role cleanup migrations.
CREATE OR REPLACE FUNCTION public.rpc_recalc_po_landed_cost(p_po_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    SELECT u.role
      INTO v_role
    FROM public.us_users AS u
    WHERE u.id = auth.uid()
      AND u.is_active IS TRUE;

    IF v_role IS NULL
       OR v_role NOT IN ('superadmin', 'admin', 'account', 'manager') THEN
      RAISE EXCEPTION 'Not authorized to recalculate PO landed cost';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.inv_po WHERE id = p_po_id) THEN
    RAISE EXCEPTION 'PO not found';
  END IF;

  PERFORM public.fn_update_product_landed_costs(p_po_id);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_recalc_po_landed_cost(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_recalc_po_landed_cost(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_recalc_po_landed_cost(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_recalc_po_landed_cost(uuid) TO service_role;

COMMIT;
