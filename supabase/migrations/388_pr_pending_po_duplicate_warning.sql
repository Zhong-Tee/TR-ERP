-- Show purchasing staff which products already exist on a PO that is not
-- fully received. Includes open POs so a newly converted PR is also visible
-- before the PO is marked ordered.

CREATE OR REPLACE FUNCTION public.rpc_get_pending_po_details_by_product()
RETURNS TABLE (
  product_id uuid,
  pending_qty numeric,
  po_details jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT u.role
    INTO v_role
  FROM public.us_users AS u
  WHERE u.id = auth.uid()
    AND u.is_active IS TRUE;

  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account', 'store') THEN
    RAISE EXCEPTION 'Not authorized to view pending purchase orders';
  END IF;

  RETURN QUERY
  WITH outstanding AS (
    SELECT
      poi.product_id,
      po.id AS po_id,
      po.po_no,
      po.status,
      po.expected_arrival_date,
      GREATEST(
        COALESCE(poi.qty, 0)
        - COALESCE(poi.qty_received_total, 0)
        - COALESCE(poi.resolution_qty, 0),
        0
      ) AS item_pending_qty
    FROM public.inv_po_items AS poi
    JOIN public.inv_po AS po ON po.id = poi.po_id
    WHERE po.status IN ('open', 'ordered', 'partial')
  )
  SELECT
    outstanding.product_id,
    SUM(outstanding.item_pending_qty)::numeric AS pending_qty,
    jsonb_agg(
      jsonb_build_object(
        'po_id', outstanding.po_id,
        'po_no', outstanding.po_no,
        'status', outstanding.status,
        'pending_qty', outstanding.item_pending_qty,
        'expected_arrival_date', outstanding.expected_arrival_date
      )
      ORDER BY outstanding.po_no
    ) AS po_details
  FROM outstanding
  WHERE outstanding.item_pending_qty > 0
  GROUP BY outstanding.product_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_pending_po_details_by_product() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_get_pending_po_details_by_product() FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_pending_po_details_by_product() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_pending_po_details_by_product() TO service_role;
