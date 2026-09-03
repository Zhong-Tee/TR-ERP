-- Expose FIFO availability to the warehouse list without exposing lot costs.

BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_get_warehouse_fifo_status()
RETURNS TABLE (
  product_id UUID,
  sellable_lot_count BIGINT,
  sellable_lot_qty NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role TEXT;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT u.role
    INTO v_role
    FROM public.us_users u
    WHERE u.id = auth.uid()
      AND u.is_active IS TRUE;

    IF v_role IS NULL THEN
      RAISE EXCEPTION 'Not authorized to view warehouse FIFO status';
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    p.id AS product_id,
    COUNT(l.id) FILTER (
      WHERE l.qty_remaining > 0
        AND COALESCE(l.is_safety_stock, FALSE) IS FALSE
    ) AS sellable_lot_count,
    COALESCE(
      SUM(l.qty_remaining) FILTER (
        WHERE l.qty_remaining > 0
          AND COALESCE(l.is_safety_stock, FALSE) IS FALSE
      ),
      0
    ) AS sellable_lot_qty
  FROM public.pr_products p
  LEFT JOIN public.inv_stock_lots l
    ON l.product_id = p.id
  WHERE p.is_active IS TRUE
  GROUP BY p.id;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_warehouse_fifo_status()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_warehouse_fifo_status()
  TO authenticated, service_role;

COMMENT ON FUNCTION public.rpc_get_warehouse_fifo_status() IS
  'Returns only active normal FIFO lot counts and quantities for warehouse indicators; never exposes lot costs.';

COMMIT;
