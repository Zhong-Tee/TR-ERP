BEGIN;
-- Return only one reference per requested product; cost access is checked on
-- the server even when this RPC is invoked outside the purchasing screen.
CREATE OR REPLACE FUNCTION public.latest_purchase_prices_for_po(
  p_product_ids uuid[], p_supplier_id uuid DEFAULT NULL
)
RETURNS TABLE(product_id uuid, unit_price numeric, po_no text,
  ordered_at timestamptz, supplier_id uuid, supplier_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.erp_can_view_cost() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดูราคาซื้อ';
  END IF;
  RETURN QUERY
  SELECT DISTINCT ON (i.product_id)
    i.product_id, i.unit_price::numeric, p.po_no::text,
    p.ordered_at::timestamptz, p.supplier_id, p.supplier_name::text
  FROM public.inv_po_items i JOIN public.inv_po p ON p.id = i.po_id
  WHERE i.product_id = ANY(p_product_ids)
    AND p.status IN ('ordered', 'partial', 'received', 'closed')
    AND p.ordered_at IS NOT NULL AND i.unit_price IS NOT NULL
  ORDER BY i.product_id,
    coalesce(p.supplier_id = p_supplier_id, false) DESC,
    p.ordered_at DESC, p.created_at DESC, p.id DESC, i.id DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.latest_purchase_prices_for_po(uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.latest_purchase_prices_for_po(uuid[], uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
