-- Create an inventory-adjustment header and all of its items atomically.
-- Any failure rolls back the complete document, preventing empty headers.

BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_create_inventory_adjustment(
  p_adjustment_type text,
  p_reason_code text,
  p_note text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
  v_adjustment_id uuid;
  v_adjust_no text;
  v_today text;
  v_seq integer;
  v_input record;
  v_product record;
  v_current_on_hand numeric;
  v_current_safety numeric;
  v_target_on_hand numeric;
  v_target_safety numeric;
  v_qty_delta numeric;
  v_item_count integer := 0;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT u.role INTO v_role
    FROM public.us_users u
    WHERE u.id = auth.uid() AND u.is_active IS TRUE;

    IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'manager', 'store') THEN
      RAISE EXCEPTION 'Not authorized to create an inventory adjustment';
    END IF;
  END IF;

  IF p_adjustment_type IS NULL
     OR p_adjustment_type NOT IN ('audit_adjustment', 'safety_reclass') THEN
    RAISE EXCEPTION 'Invalid inventory adjustment type';
  END IF;
  IF btrim(COALESCE(p_note, '')) = '' THEN
    RAISE EXCEPTION 'Inventory adjustment note is required';
  END IF;
  IF p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Inventory adjustment must contain at least one item';
  END IF;
  IF jsonb_array_length(p_items) > 5000 THEN
    RAISE EXCEPTION 'Inventory adjustment contains too many items';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items) AS x(product_id uuid, target_on_hand numeric, target_safety numeric)
    GROUP BY x.product_id
    HAVING x.product_id IS NULL OR count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Inventory adjustment contains an invalid or duplicate product';
  END IF;

  -- Generate daily numbers safely when several users submit simultaneously.
  PERFORM pg_advisory_xact_lock(hashtext('inventory_adjustment_no_gen'));
  v_today := to_char(clock_timestamp() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD');

  SELECT COALESCE(MAX(split_part(a.adjust_no, '-', 3)::integer), 0) + 1
  INTO v_seq
  FROM public.inv_adjustments a
  WHERE a.adjust_no ~ ('^ADJ-' || v_today || '-[0-9]+$');

  v_adjust_no := 'ADJ-' || v_today || '-' || lpad(v_seq::text, 3, '0');

  INSERT INTO public.inv_adjustments (
    adjust_no, status, adjustment_type, reason_code, created_by, note
  )
  VALUES (
    v_adjust_no,
    'pending',
    p_adjustment_type,
    NULLIF(btrim(COALESCE(p_reason_code, '')), ''),
    auth.uid(),
    btrim(p_note)
  )
  RETURNING id INTO v_adjustment_id;

  -- Lock current balances in a stable order before capturing snapshots.
  PERFORM 1
  FROM public.inv_stock_balances b
  JOIN (
    SELECT x.product_id
    FROM jsonb_to_recordset(p_items) AS x(product_id uuid, target_on_hand numeric, target_safety numeric)
  ) requested ON requested.product_id = b.product_id
  ORDER BY b.product_id
  FOR UPDATE OF b;

  FOR v_input IN
    SELECT x.product_id, x.target_on_hand, x.target_safety
    FROM jsonb_to_recordset(p_items) AS x(
      product_id uuid,
      target_on_hand numeric,
      target_safety numeric
    )
    ORDER BY x.product_id
  LOOP
    SELECT p.id, p.product_code, p.product_name
    INTO v_product
    FROM public.pr_products p
    WHERE p.id = v_input.product_id
      AND p.is_active IS TRUE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_input.product_id;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.wh_sub_wms_map_spares s
      WHERE s.product_id = v_input.product_id
    ) THEN
      RAISE EXCEPTION 'Product % must be adjusted through its linked production SKU', v_product.product_code;
    END IF;

    SELECT COALESCE(b.on_hand, 0), COALESCE(b.safety_stock, 0)
    INTO v_current_on_hand, v_current_safety
    FROM public.inv_stock_balances b
    WHERE b.product_id = v_input.product_id;

    IF NOT FOUND THEN
      v_current_on_hand := 0;
      v_current_safety := 0;
    END IF;

    v_target_safety := COALESCE(v_input.target_safety, v_current_safety);
    IF p_adjustment_type = 'safety_reclass' THEN
      v_target_on_hand := v_current_on_hand + v_current_safety - v_target_safety;
      v_qty_delta := 0;
    ELSE
      v_target_on_hand := v_input.target_on_hand;
      v_qty_delta := v_target_on_hand - v_current_on_hand;
    END IF;

    IF v_target_on_hand IS NULL OR v_target_safety IS NULL
       OR v_target_on_hand < 0 OR v_target_safety < 0 THEN
      RAISE EXCEPTION 'Invalid target quantity for product %', v_product.product_code;
    END IF;

    IF v_target_on_hand = v_current_on_hand
       AND v_target_safety = v_current_safety THEN
      CONTINUE;
    END IF;

    INSERT INTO public.inv_adjustment_items (
      adjustment_id, product_id, qty_delta,
      new_safety_stock, new_order_point,
      before_on_hand, after_on_hand,
      before_safety_stock, after_safety_stock,
      before_total_qty, after_total_qty
    )
    VALUES (
      v_adjustment_id,
      v_input.product_id,
      v_qty_delta,
      v_target_safety,
      NULL,
      v_current_on_hand,
      v_target_on_hand,
      v_current_safety,
      v_target_safety,
      v_current_on_hand + v_current_safety,
      v_target_on_hand + v_target_safety
    );

    v_item_count := v_item_count + 1;
  END LOOP;

  IF v_item_count = 0 THEN
    RAISE EXCEPTION 'Inventory adjustment has no changed items';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', v_adjustment_id,
    'adjust_no', v_adjust_no,
    'status', 'pending',
    'item_count', v_item_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_create_inventory_adjustment(text, text, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_create_inventory_adjustment(text, text, text, jsonb)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.rpc_create_inventory_adjustment(text, text, text, jsonb) IS
  'Atomically creates an inventory-adjustment header and changed item rows from live stock snapshots.';

COMMIT;

NOTIFY pgrst, 'reload schema';
