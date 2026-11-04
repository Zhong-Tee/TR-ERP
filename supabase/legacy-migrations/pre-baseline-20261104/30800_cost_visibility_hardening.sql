-- =============================================================================
-- Migration 308: cost visibility hardening
-- Cost readers: superadmin, account only.
-- Operational roles can continue receiving stock and entering shipping costs.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.erp_can_view_cost()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.us_users
    WHERE id = auth.uid()
      AND role IN ('superadmin', 'account')
  );
$$;

REVOKE ALL ON FUNCTION public.erp_can_view_cost() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.erp_can_view_cost() TO authenticated;

-- The last-purchase-price relation is embedded by PostgREST. Unauthorized users
-- receive no matching row (and therefore null), while purchasing workflows keep
-- the same relation name and response shape.
CREATE OR REPLACE VIEW public.v_product_last_price
WITH (security_barrier = true)
AS
SELECT DISTINCT ON (poi.product_id)
  poi.product_id,
  poi.unit_price AS last_price,
  po.ordered_at AS last_ordered_at
FROM public.inv_po_items poi
JOIN public.inv_po po ON po.id = poi.po_id
WHERE po.status IN ('ordered', 'partial', 'received')
  AND poi.unit_price IS NOT NULL
  AND public.erp_can_view_cost()
ORDER BY poi.product_id, po.ordered_at DESC;

-- Lot-level FIFO costs are never required by receiving/warehouse operators in
-- the client. Restrict direct reads, while SECURITY DEFINER stock functions keep
-- operating normally.
ALTER TABLE public.inv_stock_lots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Cost roles can view stock lots" ON public.inv_stock_lots;
CREATE POLICY "Cost roles can view stock lots"
  ON public.inv_stock_lots FOR SELECT
  TO authenticated
  USING (public.erp_can_view_cost());

-- Populate adjustment estimates inside the database. The browser no longer
-- needs to read product cost in order to create an adjustment document.
CREATE OR REPLACE FUNCTION public.set_adjustment_item_estimated_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cost numeric := 0;
BEGIN
  SELECT COALESCE(NULLIF(landed_cost, 0), unit_cost, 0)
    INTO v_cost
  FROM public.pr_products
  WHERE id = NEW.product_id;

  NEW.estimated_unit_cost := COALESCE(v_cost, 0);
  NEW.estimated_total_cost_impact := COALESCE(NEW.qty_delta, 0) * COALESCE(v_cost, 0);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_adjustment_item_estimated_cost
  ON public.inv_adjustment_items;
CREATE TRIGGER trg_set_adjustment_item_estimated_cost
  BEFORE INSERT OR UPDATE OF product_id, qty_delta
  ON public.inv_adjustment_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_adjustment_item_estimated_cost();

-- Persist actual FIFO cost after an adjustment movement is created/updated.
CREATE OR REPLACE FUNCTION public.sync_adjustment_item_actual_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.ref_type = 'inv_adjustments' AND NEW.ref_id IS NOT NULL THEN
    UPDATE public.inv_adjustment_items ai
    SET approved_unit_cost = CASE
          WHEN COALESCE(ai.qty_delta, 0) <> 0
            THEN ABS(COALESCE(NEW.total_cost, 0) / ai.qty_delta)
          ELSE 0
        END,
        approved_total_cost_impact = COALESCE(NEW.total_cost, 0)
    WHERE ai.adjustment_id = NEW.ref_id
      AND ai.product_id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_adjustment_item_actual_cost
  ON public.inv_stock_movements;
CREATE TRIGGER trg_sync_adjustment_item_actual_cost
  AFTER INSERT OR UPDATE OF unit_cost, total_cost
  ON public.inv_stock_movements
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_adjustment_item_actual_cost();

-- Admin may maintain quantity/note/ETA without receiving or submitting prices.
-- Existing PO prices remain server-side and totals are recalculated internally.
CREATE OR REPLACE FUNCTION public.rpc_update_po_nonfinancial(
  p_po_id uuid,
  p_note text DEFAULT NULL,
  p_expected_arrival_date date DEFAULT NULL,
  p_items jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_item jsonb;
  v_total numeric := 0;
  v_shipping numeric := 0;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admin can use the non-financial PO update';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.inv_po WHERE id = p_po_id AND status = 'open'
  ) THEN
    RAISE EXCEPTION 'PO is not open';
  END IF;

  UPDATE public.inv_po
  SET note = p_note,
      expected_arrival_date = p_expected_arrival_date,
      updated_at = now()
  WHERE id = p_po_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    UPDATE public.inv_po_items
    SET qty = COALESCE((v_item->>'qty')::numeric, qty),
        note = v_item->>'note'
    WHERE id = (v_item->>'item_id')::uuid
      AND po_id = p_po_id;
  END LOOP;

  SELECT COALESCE(sum(qty * COALESCE(unit_price, 0)), 0)
    INTO v_total
  FROM public.inv_po_items
  WHERE po_id = p_po_id;

  SELECT COALESCE(intl_shipping_cost_thb, 0)
    INTO v_shipping
  FROM public.inv_po
  WHERE id = p_po_id;

  UPDATE public.inv_po
  SET total_amount = v_total,
      grand_total = v_total + v_shipping,
      updated_at = now()
  WHERE id = p_po_id;

  RETURN jsonb_build_object('total_amount', v_total);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_update_po_nonfinancial(uuid,text,date,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_update_po_nonfinancial(uuid,text,date,jsonb) TO authenticated;

COMMIT;
