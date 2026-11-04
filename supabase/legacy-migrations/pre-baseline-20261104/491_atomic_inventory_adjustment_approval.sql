-- Approve an inventory adjustment atomically.
-- Stock lots, safety stock, movement rows and document status either all commit
-- together or all roll back together.

BEGIN;

ALTER TABLE public.inv_adjustment_items
  ADD COLUMN IF NOT EXISTS approved_qty_delta numeric(12,2);

CREATE OR REPLACE FUNCTION public.rpc_approve_inventory_adjustment(
  p_adjustment_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
  v_adjustment public.inv_adjustments%ROWTYPE;
  v_item record;
  v_item_count integer;
  v_target_on_hand numeric;
  v_target_safety numeric;
  v_target_total numeric;
  v_current_total numeric;
  v_total_delta numeric;
  v_stock_items jsonb := '[]'::jsonb;
  v_safety_releases jsonb := '[]'::jsonb;
  v_safety_increases jsonb := '[]'::jsonb;
  v_changed_count integer := 0;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT u.role INTO v_role
    FROM public.us_users u
    WHERE u.id = auth.uid() AND u.is_active IS TRUE;

    IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'manager', 'store') THEN
      RAISE EXCEPTION 'Not authorized to approve an inventory adjustment';
    END IF;
  END IF;

  SELECT * INTO v_adjustment
  FROM public.inv_adjustments
  WHERE id = p_adjustment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory adjustment not found';
  END IF;
  IF v_adjustment.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending inventory adjustment can be approved';
  END IF;

  SELECT count(*) INTO v_item_count
  FROM public.inv_adjustment_items
  WHERE adjustment_id = p_adjustment_id;

  IF v_item_count = 0 THEN
    RAISE EXCEPTION 'Cannot approve an inventory adjustment with no items';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.inv_adjustment_items
    WHERE adjustment_id = p_adjustment_id
    GROUP BY product_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Inventory adjustment contains duplicate products';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.inv_stock_movements
    WHERE ref_type = 'inv_adjustments' AND ref_id = p_adjustment_id
  ) THEN
    RAISE EXCEPTION 'This adjustment already has stock movements';
  END IF;

  -- Ensure every item has a balance row before taking row locks.
  INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
  SELECT DISTINCT i.product_id, 0, 0, 0
  FROM public.inv_adjustment_items i
  WHERE i.adjustment_id = p_adjustment_id
  ON CONFLICT (product_id) DO NOTHING;

  FOR v_item IN
    SELECT
      i.*,
      COALESCE(b.on_hand, 0) AS current_on_hand,
      COALESCE(b.safety_stock, 0) AS current_safety
    FROM public.inv_adjustment_items i
    JOIN public.inv_stock_balances b ON b.product_id = i.product_id
    WHERE i.adjustment_id = p_adjustment_id
    ORDER BY i.created_at, i.id
    FOR UPDATE OF b
  LOOP
    -- after_* fields are absolute targets captured when the document was made.
    -- For legacy rows, fall back to the original delta/new safety values.
    v_target_on_hand := COALESCE(
      v_item.after_on_hand,
      v_item.current_on_hand + COALESCE(v_item.qty_delta, 0)
    );
    v_target_safety := COALESCE(
      v_item.after_safety_stock,
      v_item.new_safety_stock,
      v_item.current_safety
    );
    v_target_total := COALESCE(
      v_item.after_total_qty,
      v_target_on_hand + v_target_safety
    );

    IF v_target_on_hand < 0 OR v_target_safety < 0 OR v_target_total < 0 THEN
      RAISE EXCEPTION 'Inventory adjustment has a negative target for product %', v_item.product_id;
    END IF;

    v_current_total := v_item.current_on_hand + v_item.current_safety;
    v_total_delta := v_target_total - v_current_total;

    UPDATE public.inv_adjustment_items
    SET approved_qty_delta = v_total_delta
    WHERE id = v_item.id;

    -- Release safety first when decreasing it, so released lots are available
    -- for a simultaneous reduction of total physical stock.
    IF v_target_safety < v_item.current_safety THEN
      v_safety_releases := v_safety_releases || jsonb_build_array(jsonb_build_object(
        'product_id', v_item.product_id,
        'safety_stock', v_target_safety
      ));
    ELSIF v_target_safety > v_item.current_safety THEN
      v_safety_increases := v_safety_increases || jsonb_build_array(jsonb_build_object(
        'product_id', v_item.product_id,
        'safety_stock', v_target_safety
      ));
    END IF;

    IF v_total_delta <> 0 THEN
      v_stock_items := v_stock_items || jsonb_build_array(jsonb_build_object(
        'product_id', v_item.product_id,
        'qty_delta', v_total_delta,
        'movement_type', 'adjust',
        'ref_type', 'inv_adjustments',
        'ref_id', p_adjustment_id,
        'note', 'ปรับสต๊อก ' || v_adjustment.adjust_no
      ));
    END IF;

    IF v_total_delta <> 0 OR v_target_safety <> v_item.current_safety THEN
      v_changed_count := v_changed_count + 1;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_safety_releases) > 0 THEN
    PERFORM public.bulk_update_safety_stock(v_safety_releases);
  END IF;
  IF jsonb_array_length(v_stock_items) > 0 THEN
    PERFORM public.bulk_adjust_stock(v_stock_items);
  END IF;
  IF jsonb_array_length(v_safety_increases) > 0 THEN
    PERFORM public.bulk_update_safety_stock(v_safety_increases);
  END IF;

  UPDATE public.inv_adjustments
  SET status = 'approved',
      approved_by = auth.uid(),
      approved_at = now()
  WHERE id = p_adjustment_id;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', p_adjustment_id,
    'adjust_no', v_adjustment.adjust_no,
    'status', 'approved',
    'item_count', v_item_count,
    'changed_count', v_changed_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_approve_inventory_adjustment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_approve_inventory_adjustment(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.rpc_approve_inventory_adjustment(uuid) IS
  'Atomically applies absolute inventory-adjustment targets and marks the document approved. Empty or already-processed documents are rejected.';

COMMIT;
