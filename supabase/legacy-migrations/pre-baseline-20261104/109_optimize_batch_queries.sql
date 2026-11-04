-- ═══════════════════════════════════════════
-- 109: Batch RPC to reduce connection usage
-- ═══════════════════════════════════════════

-- Batch version of fn_calc_pp_producible_qty
-- Accepts array of product_ids, returns table of (product_id, producible_qty)
-- Reduces N concurrent RPC calls to 1 single call

CREATE OR REPLACE FUNCTION fn_calc_pp_producible_qty_batch(p_product_ids UUID[])
RETURNS TABLE(product_id UUID, producible_qty NUMERIC)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_pid       UUID;
  v_recipe_id UUID;
  v_min_qty   NUMERIC;
  v_inc       RECORD;
  v_on_hand   NUMERIC;
  v_possible  NUMERIC;
BEGIN
  FOREACH v_pid IN ARRAY p_product_ids
  LOOP
    v_min_qty := NULL;
    SELECT r.id INTO v_recipe_id FROM pp_recipes r WHERE r.product_id = v_pid;

    IF v_recipe_id IS NOT NULL THEN
      FOR v_inc IN
        SELECT ri.product_id AS inc_product_id, ri.qty
        FROM pp_recipe_includes ri
        WHERE ri.recipe_id = v_recipe_id AND ri.qty > 0
      LOOP
        SELECT COALESCE(sb.on_hand, 0) INTO v_on_hand
        FROM inv_stock_balances sb
        WHERE sb.product_id = v_inc.inc_product_id;

        v_on_hand := COALESCE(v_on_hand, 0);
        v_possible := FLOOR(v_on_hand / v_inc.qty);

        IF v_min_qty IS NULL OR v_possible < v_min_qty THEN
          v_min_qty := v_possible;
        END IF;
      END LOOP;
    END IF;

    product_id := v_pid;
    producible_qty := COALESCE(v_min_qty, 0);
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Batch validation: check RM stock for multiple production items at once
-- Returns table of (product_id, include_product_code, needed, on_hand)
-- Only returns rows where stock is insufficient

CREATE OR REPLACE FUNCTION fn_validate_production_items_batch(
  p_items JSONB  -- array of { "product_id": uuid, "qty": numeric }
)
RETURNS TABLE(
  pp_product_id UUID,
  include_product_code TEXT,
  needed NUMERIC,
  on_hand NUMERIC
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_item      JSONB;
  v_recipe_id UUID;
  v_inc       RECORD;
  v_oh        NUMERIC;
  v_need      NUMERIC;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT r.id INTO v_recipe_id
    FROM pp_recipes r
    WHERE r.product_id = (v_item->>'product_id')::UUID;

    IF v_recipe_id IS NULL THEN CONTINUE; END IF;

    FOR v_inc IN
      SELECT ri.product_id AS inc_pid, ri.qty,
             p.product_code AS inc_code
      FROM pp_recipe_includes ri
      JOIN pr_products p ON p.id = ri.product_id
      WHERE ri.recipe_id = v_recipe_id AND ri.qty > 0
    LOOP
      v_need := v_inc.qty * (v_item->>'qty')::NUMERIC;

      SELECT COALESCE(sb.on_hand, 0) INTO v_oh
      FROM inv_stock_balances sb
      WHERE sb.product_id = v_inc.inc_pid;

      v_oh := COALESCE(v_oh, 0);

      IF v_oh < v_need THEN
        pp_product_id := (v_item->>'product_id')::UUID;
        include_product_code := v_inc.inc_code;
        needed := v_need;
        on_hand := v_oh;
        RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
