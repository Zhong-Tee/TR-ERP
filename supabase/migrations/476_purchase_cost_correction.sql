-- Superadmin-only retrospective correction of PO unit costs.
-- The correction updates PO totals and the cost of stock that is still on hand.
-- Cost already consumed is preserved historically and recorded as an audit impact.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS public.inv_po_cost_correction_no_seq;

CREATE TABLE IF NOT EXISTS public.inv_po_cost_corrections (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  correction_no text NOT NULL UNIQUE
    DEFAULT ('PCC-' || lpad(nextval('public.inv_po_cost_correction_no_seq')::text, 8, '0')),
  po_id uuid NOT NULL REFERENCES public.inv_po(id) ON DELETE RESTRICT,
  po_no_snapshot text NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 5),
  old_total_amount numeric(14,2) NOT NULL DEFAULT 0,
  new_total_amount numeric(14,2) NOT NULL DEFAULT 0,
  old_grand_total numeric(14,2) NOT NULL DEFAULT 0,
  new_grand_total numeric(14,2) NOT NULL DEFAULT 0,
  inventory_value_delta numeric(14,2) NOT NULL DEFAULT 0,
  consumed_cost_delta numeric(14,2) NOT NULL DEFAULT 0,
  corrected_by uuid REFERENCES public.us_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inv_po_cost_correction_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  correction_id uuid NOT NULL REFERENCES public.inv_po_cost_corrections(id) ON DELETE CASCADE,
  po_item_id uuid NOT NULL REFERENCES public.inv_po_items(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.pr_products(id) ON DELETE RESTRICT,
  product_code_snapshot text,
  product_name_snapshot text,
  old_unit_price numeric(14,4) NOT NULL,
  new_unit_price numeric(14,4) NOT NULL,
  qty_ordered numeric(14,2) NOT NULL DEFAULT 0,
  qty_received numeric(14,2) NOT NULL DEFAULT 0,
  qty_remaining numeric(14,2) NOT NULL DEFAULT 0,
  qty_consumed numeric(14,2) NOT NULL DEFAULT 0,
  inventory_value_delta numeric(14,2) NOT NULL DEFAULT 0,
  consumed_cost_delta numeric(14,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_cost_corrections_po
  ON public.inv_po_cost_corrections(po_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_po_cost_correction_items_correction
  ON public.inv_po_cost_correction_items(correction_id);

ALTER TABLE public.inv_po_cost_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_po_cost_correction_items ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.guard_historical_po_unit_price()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW.unit_price IS DISTINCT FROM OLD.unit_price THEN
    SELECT status INTO v_status FROM public.inv_po WHERE id = NEW.po_id;
    IF v_status <> 'open'
       AND COALESCE(current_setting('app.allow_historical_po_cost_correction', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Historical PO unit prices must be corrected through the audited correction workflow';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_historical_po_unit_price ON public.inv_po_items;
CREATE TRIGGER trg_guard_historical_po_unit_price
  BEFORE UPDATE OF unit_price ON public.inv_po_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_historical_po_unit_price();

CREATE POLICY "Superadmin can view PO cost corrections"
  ON public.inv_po_cost_corrections FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.us_users u
      WHERE u.id = auth.uid() AND u.is_active IS TRUE AND u.role = 'superadmin'
    )
  );

CREATE POLICY "Superadmin can view PO cost correction items"
  ON public.inv_po_cost_correction_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.us_users u
      WHERE u.id = auth.uid() AND u.is_active IS TRUE AND u.role = 'superadmin'
    )
  );

REVOKE ALL ON TABLE public.inv_po_cost_corrections FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.inv_po_cost_correction_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.inv_po_cost_corrections TO authenticated;
GRANT SELECT ON TABLE public.inv_po_cost_correction_items TO authenticated;
GRANT ALL ON TABLE public.inv_po_cost_corrections TO service_role;
GRANT ALL ON TABLE public.inv_po_cost_correction_items TO service_role;
REVOKE ALL ON SEQUENCE public.inv_po_cost_correction_no_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.inv_po_cost_correction_no_seq TO service_role;

CREATE OR REPLACE FUNCTION public.rpc_correct_po_unit_costs(
  p_po_id uuid,
  p_reason text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_po public.inv_po%ROWTYPE;
  v_item jsonb;
  v_po_item public.inv_po_items%ROWTYPE;
  v_product record;
  v_correction_id uuid;
  v_correction_no text;
  v_new_price numeric;
  v_old_price numeric;
  v_price_delta numeric;
  v_qty_received numeric;
  v_qty_remaining numeric;
  v_qty_consumed numeric;
  v_inventory_delta numeric;
  v_consumed_delta numeric;
  v_total_inventory_delta numeric := 0;
  v_total_consumed_delta numeric := 0;
  v_new_total numeric;
  v_new_grand_total numeric;
  v_changed_count integer := 0;
  v_seen_item_ids uuid[] := ARRAY[]::uuid[];
  v_impacts jsonb := '[]'::jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT u.role INTO v_role
    FROM public.us_users u
    WHERE u.id = v_uid AND u.is_active IS TRUE;

    IF v_role IS DISTINCT FROM 'superadmin' THEN
      RAISE EXCEPTION 'Only an active superadmin can correct a historical PO cost';
    END IF;
  END IF;

  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'A correction reason of at least 5 characters is required';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one PO item is required';
  END IF;

  SELECT * INTO v_po FROM public.inv_po WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PO not found'; END IF;
  IF v_po.status NOT IN ('open', 'ordered', 'partial', 'received', 'closed') THEN
    RAISE EXCEPTION 'PO status % cannot be cost-corrected', v_po.status;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.inv_po_items
    WHERE po_id = p_po_id
    GROUP BY product_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'This PO contains duplicate product rows and requires data review before cost correction';
  END IF;

  INSERT INTO public.inv_po_cost_corrections (
    po_id, po_no_snapshot, reason, old_total_amount, new_total_amount,
    old_grand_total, new_grand_total, corrected_by
  ) VALUES (
    v_po.id, v_po.po_no, btrim(p_reason), COALESCE(v_po.total_amount, 0), COALESCE(v_po.total_amount, 0),
    COALESCE(v_po.grand_total, 0), COALESCE(v_po.grand_total, 0), v_uid
  ) RETURNING id, correction_no INTO v_correction_id, v_correction_no;

  PERFORM set_config('app.allow_historical_po_cost_correction', 'on', true);

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    IF NULLIF(v_item->>'item_id', '') IS NULL OR NULLIF(v_item->>'new_unit_price', '') IS NULL THEN
      RAISE EXCEPTION 'Every correction item requires item_id and new_unit_price';
    END IF;
    IF (v_item->>'item_id')::uuid = ANY(v_seen_item_ids) THEN
      RAISE EXCEPTION 'Duplicate PO item in correction request';
    END IF;
    v_seen_item_ids := array_append(v_seen_item_ids, (v_item->>'item_id')::uuid);

    v_new_price := (v_item->>'new_unit_price')::numeric;
    IF v_new_price < 0 THEN RAISE EXCEPTION 'Unit price cannot be negative'; END IF;

    SELECT * INTO v_po_item
    FROM public.inv_po_items
    WHERE id = (v_item->>'item_id')::uuid AND po_id = p_po_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PO item does not belong to this PO'; END IF;
    v_old_price := COALESCE(v_po_item.unit_price, 0);
    IF v_new_price = v_old_price THEN CONTINUE; END IF;
    v_price_delta := v_new_price - v_old_price;

    SELECT p.product_code, p.product_name
      INTO v_product
    FROM public.pr_products p WHERE p.id = v_po_item.product_id;

    SELECT COALESCE(SUM(gi.qty_received), 0)
      INTO v_qty_received
    FROM public.inv_gr g
    JOIN public.inv_gr_items gi ON gi.gr_id = g.id
    WHERE g.po_id = p_po_id AND gi.product_id = v_po_item.product_id;

    SELECT COALESCE(SUM(sl.qty_remaining), 0)
      INTO v_qty_remaining
    FROM public.inv_stock_lots sl
    JOIN public.inv_gr g ON g.id = sl.ref_id AND sl.ref_type = 'inv_gr'
    WHERE g.po_id = p_po_id AND sl.product_id = v_po_item.product_id;

    v_qty_consumed := GREATEST(v_qty_received - v_qty_remaining, 0);
    v_inventory_delta := round(v_price_delta * v_qty_remaining, 2);
    v_consumed_delta := round(v_price_delta * v_qty_consumed, 2);

    UPDATE public.inv_po_items
    SET unit_price = v_new_price,
        subtotal = round(COALESCE(qty, 0) * v_new_price, 2)
    WHERE id = v_po_item.id;

    IF v_po.pr_id IS NOT NULL THEN
      UPDATE public.inv_pr_items
      SET estimated_price = v_new_price
      WHERE pr_id = v_po.pr_id AND product_id = v_po_item.product_id;
    END IF;

    -- Shipping is unchanged, so applying only the purchase-price delta preserves
    -- the existing domestic/international shipping portion of each GR lot.
    UPDATE public.inv_stock_lots sl
    SET unit_cost = GREATEST(0, COALESCE(sl.unit_cost, 0) + v_price_delta)
    FROM public.inv_gr g
    WHERE sl.ref_type = 'inv_gr' AND sl.ref_id = g.id
      AND g.po_id = p_po_id AND sl.product_id = v_po_item.product_id;

    UPDATE public.inv_stock_movements sm
    SET unit_cost = GREATEST(0, COALESCE(sm.unit_cost, 0) + v_price_delta),
        total_cost = round(ABS(sm.qty) * GREATEST(0, COALESCE(sm.unit_cost, 0) + v_price_delta), 2)
    FROM public.inv_gr g
    WHERE sm.ref_type = 'inv_gr' AND sm.ref_id = g.id
      AND sm.movement_type = 'gr' AND sm.product_id = v_po_item.product_id
      AND g.po_id = p_po_id;

    PERFORM public.fn_recalc_product_landed_cost(v_po_item.product_id);

    INSERT INTO public.inv_po_cost_correction_items (
      correction_id, po_item_id, product_id, product_code_snapshot, product_name_snapshot,
      old_unit_price, new_unit_price, qty_ordered, qty_received, qty_remaining, qty_consumed,
      inventory_value_delta, consumed_cost_delta
    ) VALUES (
      v_correction_id, v_po_item.id, v_po_item.product_id, v_product.product_code, v_product.product_name,
      v_old_price, v_new_price, COALESCE(v_po_item.qty, 0), v_qty_received, v_qty_remaining, v_qty_consumed,
      v_inventory_delta, v_consumed_delta
    );

    v_changed_count := v_changed_count + 1;
    v_total_inventory_delta := v_total_inventory_delta + v_inventory_delta;
    v_total_consumed_delta := v_total_consumed_delta + v_consumed_delta;
    v_impacts := v_impacts || jsonb_build_array(jsonb_build_object(
      'item_id', v_po_item.id,
      'product_code', v_product.product_code,
      'old_unit_price', v_old_price,
      'new_unit_price', v_new_price,
      'qty_received', v_qty_received,
      'qty_remaining', v_qty_remaining,
      'qty_consumed', v_qty_consumed,
      'inventory_value_delta', v_inventory_delta,
      'consumed_cost_delta', v_consumed_delta
    ));
  END LOOP;

  IF v_changed_count = 0 THEN
    RAISE EXCEPTION 'No unit price was changed';
  END IF;

  SELECT COALESCE(SUM(COALESCE(subtotal, qty * COALESCE(unit_price, 0))), 0)
    INTO v_new_total
  FROM public.inv_po_items WHERE po_id = p_po_id;
  v_new_grand_total := v_new_total + COALESCE(v_po.intl_shipping_cost_thb, 0);

  UPDATE public.inv_po
  SET total_amount = v_new_total, grand_total = v_new_grand_total, updated_at = now()
  WHERE id = p_po_id;

  UPDATE public.inv_po_cost_corrections
  SET new_total_amount = v_new_total,
      new_grand_total = v_new_grand_total,
      inventory_value_delta = v_total_inventory_delta,
      consumed_cost_delta = v_total_consumed_delta
  WHERE id = v_correction_id;

  RETURN jsonb_build_object(
    'success', true,
    'correction_id', v_correction_id,
    'correction_no', v_correction_no,
    'changed_count', v_changed_count,
    'new_total_amount', v_new_total,
    'new_grand_total', v_new_grand_total,
    'inventory_value_delta', v_total_inventory_delta,
    'consumed_cost_delta', v_total_consumed_delta,
    'items', v_impacts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_correct_po_unit_costs(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_correct_po_unit_costs(uuid, text, jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_historical_po_unit_price() FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.inv_po_cost_corrections IS
  'Immutable audit header for retrospective PO cost corrections performed by superadmin.';
COMMENT ON COLUMN public.inv_po_cost_corrections.consumed_cost_delta IS
  'Cost difference for quantities already consumed; recorded for accounting review and not applied to historical FIFO consumption.';

COMMIT;
