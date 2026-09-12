-- ============================================
-- 101: Safety Stock Lot Tracking
-- รวม Safety Stock เข้าระบบ FIFO lots
-- ============================================

-- 1. Add flag to distinguish safety stock lots
ALTER TABLE inv_stock_lots ADD COLUMN IF NOT EXISTS is_safety_stock BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_stock_lots_safety ON inv_stock_lots(is_safety_stock) WHERE is_safety_stock = TRUE;

-- 2. Backfill: create lots for existing safety_stock quantities
DO $$
DECLARE
  v_rec RECORD;
  v_cost NUMERIC;
BEGIN
  FOR v_rec IN
    SELECT sb.product_id, sb.safety_stock
    FROM inv_stock_balances sb
    WHERE sb.safety_stock > 0
  LOOP
    SELECT COALESCE(
      (SELECT SUM(qty_remaining * unit_cost) / NULLIF(SUM(qty_remaining), 0)
       FROM inv_stock_lots
       WHERE product_id = v_rec.product_id AND qty_remaining > 0 AND is_safety_stock = FALSE),
      (SELECT COALESCE(landed_cost, unit_cost, 0) FROM pr_products WHERE id = v_rec.product_id),
      0
    ) INTO v_cost;

    INSERT INTO inv_stock_lots (product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id, is_safety_stock)
    VALUES (v_rec.product_id, v_rec.safety_stock, v_rec.safety_stock, v_cost, 'backfill_safety', NULL, TRUE);
  END LOOP;
END;
$$;

-- 3. Update rpc_trial_balance_summary to include safety_stock_value breakdown
CREATE OR REPLACE FUNCTION rpc_trial_balance_summary(p_year INT, p_month INT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_month_start TIMESTAMPTZ;
  v_month_end   TIMESTAMPTZ;
  v_purchases        NUMERIC := 0;
  v_cogs             NUMERIC := 0;
  v_return_pick      NUMERIC := 0;
  v_returns          NUMERIC := 0;
  v_waste            NUMERIC := 0;
  v_adjustments      NUMERIC := 0;
  v_current_lot_val  NUMERIC := 0;
  v_current_ss_val   NUMERIC := 0;
  v_after_month_net  NUMERIC := 0;
  v_month_net        NUMERIC := 0;
  v_ending           NUMERIC := 0;
  v_beginning        NUMERIC := 0;
  v_movement_count   INT := 0;
  v_product_count    INT := 0;
  v_rec              RECORD;
BEGIN
  v_month_start := make_timestamptz(p_year, p_month, 1, 0, 0, 0, 'Asia/Bangkok');
  v_month_end   := v_month_start + INTERVAL '1 month';

  FOR v_rec IN
    SELECT movement_type,
           SUM(total_cost) AS total,
           COUNT(*)        AS cnt
    FROM inv_stock_movements
    WHERE created_at >= v_month_start AND created_at < v_month_end
      AND total_cost IS NOT NULL
    GROUP BY movement_type
  LOOP
    v_movement_count := v_movement_count + v_rec.cnt;
    CASE v_rec.movement_type
      WHEN 'gr'                   THEN v_purchases   := v_rec.total;
      WHEN 'pick'                 THEN v_cogs        := ABS(v_rec.total);
      WHEN 'return_pick'          THEN v_return_pick  := v_rec.total;
      WHEN 'return_requisition'   THEN v_returns      := v_returns + v_rec.total;
      WHEN 'return'               THEN v_returns      := v_returns + v_rec.total;
      WHEN 'waste'                THEN v_waste        := ABS(v_rec.total);
      WHEN 'adjust'               THEN v_adjustments  := v_rec.total;
      ELSE NULL;
    END CASE;
  END LOOP;

  SELECT COUNT(DISTINCT product_id) INTO v_product_count
  FROM inv_stock_movements
  WHERE created_at >= v_month_start AND created_at < v_month_end;

  -- Regular lots (not safety stock)
  SELECT COALESCE(SUM(qty_remaining * unit_cost), 0)
  INTO v_current_lot_val
  FROM inv_stock_lots
  WHERE qty_remaining > 0 AND is_safety_stock = FALSE;

  -- Safety stock lots (separate)
  SELECT COALESCE(SUM(qty_remaining * unit_cost), 0)
  INTO v_current_ss_val
  FROM inv_stock_lots
  WHERE qty_remaining > 0 AND is_safety_stock = TRUE;

  SELECT COALESCE(SUM(total_cost), 0)
  INTO v_after_month_net
  FROM inv_stock_movements
  WHERE created_at >= v_month_end
    AND movement_type <> 'waste'
    AND total_cost IS NOT NULL;

  v_ending := v_current_lot_val - v_after_month_net;

  SELECT COALESCE(SUM(total_cost), 0)
  INTO v_month_net
  FROM inv_stock_movements
  WHERE created_at >= v_month_start AND created_at < v_month_end
    AND movement_type <> 'waste'
    AND total_cost IS NOT NULL;

  v_beginning := v_ending - v_month_net;

  RETURN jsonb_build_object(
    'beginning_inventory', ROUND(v_beginning, 2),
    'ending_inventory',    ROUND(v_ending, 2),
    'safety_stock_value',  ROUND(v_current_ss_val, 2),
    'purchases',           ROUND(v_purchases, 2),
    'cogs',                ROUND(v_cogs, 2),
    'return_pick',         ROUND(v_return_pick, 2),
    'returns',             ROUND(v_returns, 2),
    'waste',               ROUND(v_waste, 2),
    'adjustments',         ROUND(v_adjustments, 2),
    'movement_count',      v_movement_count,
    'product_count',       v_product_count
  );
END;
$$;

-- 4. Update rpc_trial_balance_products to include safety_stock fields
CREATE OR REPLACE FUNCTION rpc_trial_balance_products(p_year INT, p_month INT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_month_start TIMESTAMPTZ;
  v_month_end   TIMESTAMPTZ;
  v_result      JSONB;
BEGIN
  v_month_start := make_timestamptz(p_year, p_month, 1, 0, 0, 0, 'Asia/Bangkok');
  v_month_end   := v_month_start + INTERVAL '1 month';

  WITH current_lots AS (
    SELECT product_id,
           SUM(CASE WHEN is_safety_stock = FALSE THEN qty_remaining ELSE 0 END) AS current_qty,
           SUM(CASE WHEN is_safety_stock = FALSE THEN qty_remaining * unit_cost ELSE 0 END) AS current_val,
           SUM(CASE WHEN is_safety_stock = TRUE  THEN qty_remaining ELSE 0 END) AS ss_qty,
           SUM(CASE WHEN is_safety_stock = TRUE  THEN qty_remaining * unit_cost ELSE 0 END) AS ss_val
    FROM inv_stock_lots
    WHERE qty_remaining > 0
    GROUP BY product_id
  ),
  after_month AS (
    SELECT product_id,
           SUM(qty)        AS net_qty,
           SUM(total_cost) AS net_val
    FROM inv_stock_movements
    WHERE created_at >= v_month_end
      AND movement_type <> 'waste'
      AND total_cost IS NOT NULL
    GROUP BY product_id
  ),
  month_movements AS (
    SELECT product_id,
           SUM(qty)        AS net_qty,
           SUM(total_cost) AS net_val
    FROM inv_stock_movements
    WHERE created_at >= v_month_start AND created_at < v_month_end
      AND movement_type <> 'waste'
      AND total_cost IS NOT NULL
    GROUP BY product_id
  ),
  month_by_type AS (
    SELECT product_id,
           SUM(CASE WHEN movement_type = 'gr'                                   THEN qty ELSE 0 END) AS purchases_qty,
           SUM(CASE WHEN movement_type = 'gr'                                   THEN total_cost ELSE 0 END) AS purchases_val,
           SUM(CASE WHEN movement_type = 'pick'                                 THEN ABS(qty) ELSE 0 END) AS cogs_qty,
           SUM(CASE WHEN movement_type = 'pick'                                 THEN ABS(total_cost) ELSE 0 END) AS cogs_val,
           SUM(CASE WHEN movement_type IN ('return_requisition','return')        THEN qty ELSE 0 END) AS returns_qty,
           SUM(CASE WHEN movement_type IN ('return_requisition','return')        THEN total_cost ELSE 0 END) AS returns_val,
           SUM(CASE WHEN movement_type = 'return_pick'                          THEN qty ELSE 0 END) AS return_pick_qty,
           SUM(CASE WHEN movement_type = 'return_pick'                          THEN total_cost ELSE 0 END) AS return_pick_val,
           SUM(CASE WHEN movement_type = 'waste'                                THEN ABS(qty) ELSE 0 END) AS waste_qty,
           SUM(CASE WHEN movement_type = 'waste'                                THEN ABS(total_cost) ELSE 0 END) AS waste_val,
           SUM(CASE WHEN movement_type = 'adjust'                               THEN qty ELSE 0 END) AS adjust_qty,
           SUM(CASE WHEN movement_type = 'adjust'                               THEN total_cost ELSE 0 END) AS adjust_val
    FROM inv_stock_movements
    WHERE created_at >= v_month_start AND created_at < v_month_end
      AND total_cost IS NOT NULL
    GROUP BY product_id
  ),
  all_products AS (
    SELECT DISTINCT product_id FROM (
      SELECT product_id FROM current_lots
      UNION
      SELECT product_id FROM month_by_type
    ) u
  ),
  result AS (
    SELECT
      ap.product_id,
      pp.product_code,
      pp.product_name,
      ROUND(COALESCE(cl.current_val, 0) - COALESCE(am.net_val, 0) - COALESCE(mm.net_val, 0), 2) AS beginning_value,
      ROUND(COALESCE(cl.current_qty, 0) - COALESCE(am.net_qty, 0) - COALESCE(mm.net_qty, 0), 2) AS beginning_qty,
      ROUND(COALESCE(cl.current_val, 0) - COALESCE(am.net_val, 0), 2) AS ending_value,
      ROUND(COALESCE(cl.current_qty, 0) - COALESCE(am.net_qty, 0), 2) AS ending_qty,
      ROUND(COALESCE(cl.ss_qty, 0), 2)              AS safety_stock_qty,
      ROUND(COALESCE(cl.ss_val, 0), 2)              AS safety_stock_value,
      ROUND(COALESCE(mt.purchases_qty, 0), 2)   AS purchases_qty,
      ROUND(COALESCE(mt.purchases_val, 0), 2)   AS purchases_value,
      ROUND(COALESCE(mt.cogs_qty, 0), 2)        AS cogs_qty,
      ROUND(COALESCE(mt.cogs_val, 0), 2)        AS cogs_value,
      ROUND(COALESCE(mt.returns_qty, 0), 2)      AS returns_qty,
      ROUND(COALESCE(mt.returns_val, 0), 2)      AS returns_value,
      ROUND(COALESCE(mt.return_pick_qty, 0), 2)  AS return_pick_qty,
      ROUND(COALESCE(mt.return_pick_val, 0), 2)  AS return_pick_value,
      ROUND(COALESCE(mt.waste_qty, 0), 2)        AS waste_qty,
      ROUND(COALESCE(mt.waste_val, 0), 2)        AS waste_value,
      ROUND(COALESCE(mt.adjust_qty, 0), 2)       AS adjust_qty,
      ROUND(COALESCE(mt.adjust_val, 0), 2)       AS adjust_value
    FROM all_products ap
    JOIN pr_products pp ON pp.id = ap.product_id
    LEFT JOIN current_lots cl ON cl.product_id = ap.product_id
    LEFT JOIN after_month am ON am.product_id = ap.product_id
    LEFT JOIN month_movements mm ON mm.product_id = ap.product_id
    LEFT JOIN month_by_type mt ON mt.product_id = ap.product_id
    ORDER BY pp.product_code
  )
  SELECT COALESCE(jsonb_agg(row_to_json(result)), '[]'::JSONB)
  INTO v_result
  FROM result;

  RETURN v_result;
END;
$$;
