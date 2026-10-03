-- Read-only. Run in Supabase SQL Editor and copy the single JSON result.
SELECT jsonb_pretty(jsonb_build_object(
  'price_function_installed', to_regprocedure('public.latest_purchase_prices_for_po(uuid[],uuid)') IS NOT NULL,
  'pr', (SELECT to_jsonb(r) FROM (
    SELECT pr_no, supplier_id, supplier_name FROM public.inv_pr
    WHERE pr_no = 'PR-20260930-002'
  ) r),
  'products', (SELECT jsonb_agg(jsonb_build_object(
    'product_id', p.id, 'product_code', p.product_code, 'product_name', p.product_name,
    'po_history', coalesce((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.created_at DESC) FROM (
      SELECT po.po_no, po.status, po.supplier_id, po.supplier_name,
        po.created_at, po.ordered_at, i.qty, i.unit_price,
        CASE
          WHEN po.status IS NULL OR po.status NOT IN ('ordered','partial','received','closed') THEN 'excluded: PO status'
          WHEN po.ordered_at IS NULL THEN 'excluded: ordered_at is null'
          WHEN i.unit_price IS NULL THEN 'excluded: unit_price is null'
          ELSE 'eligible'
        END AS price_reference_result
      FROM public.inv_po_items i JOIN public.inv_po po ON po.id = i.po_id
      WHERE i.product_id = p.id
    ) h), '[]'::jsonb),
    'remaining_lots', coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC) FROM (
      SELECT created_at, qty_remaining, unit_cost, ref_type, ref_id,
        (SELECT gr.gr_no FROM public.inv_gr gr WHERE gr.id = sl.ref_id AND sl.ref_type = 'inv_gr') AS gr_no,
        (SELECT po.po_no FROM public.inv_gr gr JOIN public.inv_po po ON po.id = gr.po_id
          WHERE gr.id = sl.ref_id AND sl.ref_type = 'inv_gr') AS source_po_no
      FROM public.inv_stock_lots sl WHERE sl.product_id = p.id AND sl.qty_remaining > 0
    ) l), '[]'::jsonb)
  ) ORDER BY p.product_code) FROM public.pr_products p
    WHERE p.product_code IN ('110000052','110000092','110000095'))
)) AS diagnostic_result;
