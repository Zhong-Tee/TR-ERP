-- ERP standardization for stock adjustments (FIFO + security + reconciliation)

-- 1) Header metadata for adjustment documents
ALTER TABLE inv_adjustments
  ADD COLUMN IF NOT EXISTS adjustment_type TEXT NOT NULL DEFAULT 'audit_adjustment',
  ADD COLUMN IF NOT EXISTS reason_code TEXT;

-- Guard against invalid adjustment types
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inv_adjustments_adjustment_type_chk'
  ) THEN
    ALTER TABLE inv_adjustments
      ADD CONSTRAINT inv_adjustments_adjustment_type_chk
      CHECK (adjustment_type IN ('audit_adjustment', 'safety_reclass'));
  END IF;
END $$;

-- 2) Snapshot fields on adjustment items for audit trail
ALTER TABLE inv_adjustment_items
  ADD COLUMN IF NOT EXISTS before_on_hand NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS after_on_hand NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS before_safety_stock NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS after_safety_stock NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS before_total_qty NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS after_total_qty NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS estimated_unit_cost NUMERIC(14,4),
  ADD COLUMN IF NOT EXISTS estimated_total_cost_impact NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS approved_unit_cost NUMERIC(14,4),
  ADD COLUMN IF NOT EXISTS approved_total_cost_impact NUMERIC(14,2);

-- 3) Consolidated bulk_adjust_stock:
--    keep security checks from hardening + FIFO/cost behavior from FIFO migration.
CREATE OR REPLACE FUNCTION bulk_adjust_stock(items JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role          TEXT;
  item            JSONB;
  v_product_id    UUID;
  v_qty_delta     NUMERIC(12,2);
  v_movement_type TEXT;
  v_ref_type      TEXT;
  v_ref_id        UUID;
  v_note          TEXT;
  v_movement_id   UUID;
  v_avg_cost      NUMERIC;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ปรับสต๊อค (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    v_product_id    := (item->>'product_id')::UUID;
    v_qty_delta     := (item->>'qty_delta')::NUMERIC;
    v_movement_type := item->>'movement_type';
    v_ref_type      := item->>'ref_type';
    v_ref_id        := CASE WHEN item->>'ref_id' IS NOT NULL THEN (item->>'ref_id')::UUID ELSE NULL END;
    v_note          := item->>'note';

    INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_product_id, v_qty_delta, 0, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET on_hand = inv_stock_balances.on_hand + v_qty_delta;

    v_avg_cost := fn_get_current_avg_cost(v_product_id);

    IF v_qty_delta > 0 THEN
      INSERT INTO inv_stock_movements (
        product_id, movement_type, qty, ref_type, ref_id, note, unit_cost, total_cost
      )
      VALUES (
        v_product_id, v_movement_type, v_qty_delta, v_ref_type, v_ref_id, v_note,
        v_avg_cost, v_qty_delta * v_avg_cost
      );

      INSERT INTO inv_stock_lots (
        product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id
      )
      VALUES (
        v_product_id, v_qty_delta, v_qty_delta, v_avg_cost, COALESCE(v_ref_type, 'inv_adjustments'), v_ref_id
      );
    ELSIF v_qty_delta < 0 THEN
      INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note)
      VALUES (v_product_id, v_movement_type, v_qty_delta, v_ref_type, v_ref_id, v_note)
      RETURNING id INTO v_movement_id;

      PERFORM fn_consume_stock_fifo(v_product_id, ABS(v_qty_delta), v_movement_id);
    ELSE
      INSERT INTO inv_stock_movements (
        product_id, movement_type, qty, ref_type, ref_id, note, unit_cost, total_cost
      )
      VALUES (v_product_id, v_movement_type, 0, v_ref_type, v_ref_id, v_note, 0, 0);
    END IF;

    PERFORM fn_recalc_product_landed_cost(v_product_id);
  END LOOP;
END;
$$;

-- 4) Consolidated bulk_update_safety_stock:
--    keep security checks + delta transfer between on_hand and safety pools.
CREATE OR REPLACE FUNCTION bulk_update_safety_stock(items JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role        TEXT;
  item          JSONB;
  v_product_id  UUID;
  v_new_safety  NUMERIC;
  v_current     NUMERIC;
  v_delta       NUMERIC;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ safety stock (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    v_product_id := (item->>'product_id')::UUID;
    v_new_safety := (item->>'safety_stock')::NUMERIC;

    SELECT COALESCE(safety_stock, 0)
    INTO v_current
    FROM inv_stock_balances
    WHERE product_id = v_product_id;

    IF NOT FOUND THEN
      v_current := 0;
    END IF;

    v_delta := v_new_safety - v_current;

    IF v_delta > 0 THEN
      PERFORM fn_transfer_to_safety_stock(v_product_id, v_delta);
    ELSIF v_delta < 0 THEN
      PERFORM fn_release_safety_stock(v_product_id, ABS(v_delta));
    END IF;

    PERFORM fn_recalc_product_landed_cost(v_product_id);
  END LOOP;
END;
$$;

-- 5) Reconciliation view/function for post-approval validation
CREATE OR REPLACE VIEW vw_inventory_adjustment_reconcile AS
SELECT
  ia.id AS adjustment_id,
  ia.adjust_no,
  ia.status,
  ia.adjustment_type,
  ia.created_at,
  ia.approved_at,
  iai.id AS adjustment_item_id,
  iai.product_id,
  p.product_code,
  p.product_name,
  iai.qty_delta,
  iai.new_safety_stock,
  iai.before_on_hand,
  iai.after_on_hand,
  iai.before_safety_stock,
  iai.after_safety_stock,
  iai.before_total_qty,
  iai.after_total_qty,
  sb.on_hand AS balance_on_hand,
  sb.safety_stock AS balance_safety_stock,
  (COALESCE(sb.on_hand, 0) + COALESCE(sb.safety_stock, 0)) AS balance_total_qty,
  COALESCE(ms.total_cost_impact, 0) AS movement_total_cost_impact,
  COALESCE(ls.lot_qty_remaining, 0) AS lot_qty_remaining,
  COALESCE(ls.lot_total_value, 0) AS lot_total_value,
  (
    CASE
      WHEN ia.status = 'approved' THEN
        ABS((COALESCE(sb.on_hand, 0) + COALESCE(sb.safety_stock, 0)) - COALESCE(iai.after_total_qty, (COALESCE(iai.after_on_hand, 0) + COALESCE(iai.after_safety_stock, 0)))) < 0.0001
      ELSE
        ABS((COALESCE(iai.before_total_qty, 0) + COALESCE(iai.qty_delta, 0)) - COALESCE(iai.after_total_qty, (COALESCE(iai.after_on_hand, 0) + COALESCE(iai.after_safety_stock, 0)))) < 0.0001
    END
  ) AS qty_consistent
FROM inv_adjustment_items iai
JOIN inv_adjustments ia ON ia.id = iai.adjustment_id
JOIN pr_products p ON p.id = iai.product_id
LEFT JOIN inv_stock_balances sb ON sb.product_id = iai.product_id
LEFT JOIN (
  SELECT ref_id, product_id, SUM(COALESCE(total_cost, 0)) AS total_cost_impact
  FROM inv_stock_movements
  WHERE ref_type = 'inv_adjustments'
  GROUP BY ref_id, product_id
) ms ON ms.ref_id = ia.id AND ms.product_id = iai.product_id
LEFT JOIN (
  SELECT product_id,
         SUM(COALESCE(qty_remaining, 0)) AS lot_qty_remaining,
         SUM(COALESCE(qty_remaining, 0) * COALESCE(unit_cost, 0)) AS lot_total_value
  FROM inv_stock_lots
  GROUP BY product_id
) ls ON ls.product_id = iai.product_id;

CREATE OR REPLACE FUNCTION fn_inventory_adjustment_reconcile(p_adjustment_id UUID DEFAULT NULL)
RETURNS TABLE (
  adjustment_id UUID,
  adjust_no TEXT,
  status TEXT,
  adjustment_type TEXT,
  adjustment_item_id UUID,
  product_id UUID,
  product_code TEXT,
  qty_delta NUMERIC,
  new_safety_stock NUMERIC,
  before_total_qty NUMERIC,
  after_total_qty NUMERIC,
  balance_total_qty NUMERIC,
  movement_total_cost_impact NUMERIC,
  lot_qty_remaining NUMERIC,
  lot_total_value NUMERIC,
  qty_consistent BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    v.adjustment_id,
    v.adjust_no,
    v.status,
    v.adjustment_type,
    v.adjustment_item_id,
    v.product_id,
    v.product_code,
    v.qty_delta,
    v.new_safety_stock,
    v.before_total_qty,
    v.after_total_qty,
    v.balance_total_qty,
    v.movement_total_cost_impact,
    v.lot_qty_remaining,
    v.lot_total_value,
    v.qty_consistent
  FROM vw_inventory_adjustment_reconcile v
  WHERE p_adjustment_id IS NULL OR v.adjustment_id = p_adjustment_id
  ORDER BY v.created_at DESC, v.adjust_no DESC;
$$;
