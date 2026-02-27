-- ============================================
-- 143: Safety Stock valuation by latest GR lot cost
-- - Keep FIFO movement costing logic unchanged
-- - Change only reporting valuation for safety stock
-- ============================================

-- Support fast lookup for latest GR lot per product
CREATE INDEX IF NOT EXISTS idx_stock_lots_product_ref_created_desc
  ON inv_stock_lots(product_id, ref_type, created_at DESC);

-- Helper: latest GR lot unit_cost per product
-- Fallback order: latest GR lot cost -> pr_products.landed_cost -> 0
CREATE OR REPLACE FUNCTION fn_get_latest_gr_lot_cost(p_product_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_cost NUMERIC;
BEGIN
  SELECT l.unit_cost
  INTO v_cost
  FROM inv_stock_lots l
  WHERE l.product_id = p_product_id
    AND l.ref_type = 'inv_gr'
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT 1;

  IF v_cost IS NULL THEN
    SELECT p.landed_cost
    INTO v_cost
    FROM pr_products p
    WHERE p.id = p_product_id;
  END IF;

  RETURN COALESCE(v_cost, 0);
END;
$$;

-- Summary RPC: use safety_qty * latest_gr_cost
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
  v_gross_sales      NUMERIC := 0;
  v_refunds_approved NUMERIC := 0;
  v_net_sales        NUMERIC := 0;
  v_gross_profit     NUMERIC := 0;
  v_gross_margin_pct NUMERIC := 0;
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
      WHEN 'pick_reversal'        THEN v_cogs        := v_cogs - v_rec.total;
      WHEN 'return_requisition'   THEN v_returns     := v_returns + v_rec.total;
      WHEN 'return'               THEN v_returns     := v_returns + v_rec.total;
      WHEN 'waste'                THEN v_waste       := ABS(v_rec.total);
      WHEN 'adjust'               THEN v_adjustments := v_rec.total;
      ELSE NULL;
    END CASE;
  END LOOP;

  SELECT COUNT(DISTINCT product_id) INTO v_product_count
  FROM inv_stock_movements
  WHERE created_at >= v_month_start AND created_at < v_month_end;

  SELECT COALESCE(SUM(qty_remaining * unit_cost), 0)
  INTO v_current_lot_val
  FROM inv_stock_lots
  WHERE qty_remaining > 0 AND is_safety_stock = FALSE;

  WITH safety_qty AS (
    SELECT product_id, SUM(qty_remaining) AS ss_qty
    FROM inv_stock_lots
    WHERE qty_remaining > 0
      AND is_safety_stock = TRUE
    GROUP BY product_id
  )
  SELECT COALESCE(SUM(sq.ss_qty * fn_get_latest_gr_lot_cost(sq.product_id)), 0)
  INTO v_current_ss_val
  FROM safety_qty sq;

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

  SELECT COALESCE(SUM(o.total_amount), 0)
  INTO v_gross_sales
  FROM or_orders o
  WHERE o.status = 'จัดส่งแล้ว'
    AND o.shipped_time IS NOT NULL
    AND o.shipped_time >= v_month_start
    AND o.shipped_time < v_month_end;

  SELECT COALESCE(SUM(r.amount), 0)
  INTO v_refunds_approved
  FROM ac_refunds r
  JOIN or_orders o ON o.id = r.order_id
  WHERE r.status = 'approved'
    AND o.status = 'จัดส่งแล้ว'
    AND o.shipped_time IS NOT NULL
    AND o.shipped_time >= v_month_start
    AND o.shipped_time < v_month_end;

  v_net_sales := v_gross_sales - v_refunds_approved;
  v_gross_profit := v_net_sales - v_cogs;
  v_gross_margin_pct := CASE
    WHEN ABS(v_net_sales) < 0.000001 THEN 0
    ELSE (v_gross_profit / v_net_sales) * 100
  END;

  RETURN jsonb_build_object(
    'beginning_inventory', ROUND(v_beginning, 2),
    'ending_inventory',    ROUND(v_ending, 2),
    'safety_stock_value',  ROUND(v_current_ss_val, 2),
    'purchases',           ROUND(v_purchases, 2),
    'cogs',                ROUND(v_cogs, 2),
    'returns',             ROUND(v_returns, 2),
    'waste',               ROUND(v_waste, 2),
    'adjustments',         ROUND(v_adjustments, 2),
    'gross_sales',         ROUND(v_gross_sales, 2),
    'refunds_approved',    ROUND(v_refunds_approved, 2),
    'net_sales',           ROUND(v_net_sales, 2),
    'gross_profit',        ROUND(v_gross_profit, 2),
    'gross_margin_pct',    ROUND(v_gross_margin_pct, 2),
    'movement_count',      v_movement_count,
    'product_count',       v_product_count
  );
END;
$$;

-- Product RPC: safety_stock_value = safety_stock_qty * latest_gr_cost
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
           SUM(CASE WHEN is_safety_stock = TRUE  THEN qty_remaining ELSE 0 END) AS ss_qty
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
           SUM(CASE WHEN movement_type IN ('return_requisition','return')       THEN qty ELSE 0 END) AS returns_qty,
           SUM(CASE WHEN movement_type IN ('return_requisition','return')       THEN total_cost ELSE 0 END) AS returns_val,
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
      ROUND(COALESCE(cl.ss_qty, 0), 2) AS safety_stock_qty,
      ROUND(COALESCE(cl.ss_qty, 0) * fn_get_latest_gr_lot_cost(ap.product_id), 2) AS safety_stock_value,
      ROUND(COALESCE(mt.purchases_qty, 0), 2) AS purchases_qty,
      ROUND(COALESCE(mt.purchases_val, 0), 2) AS purchases_value,
      ROUND(COALESCE(mt.cogs_qty, 0), 2) AS cogs_qty,
      ROUND(COALESCE(mt.cogs_val, 0), 2) AS cogs_value,
      ROUND(COALESCE(mt.returns_qty, 0), 2) AS returns_qty,
      ROUND(COALESCE(mt.returns_val, 0), 2) AS returns_value,
      ROUND(COALESCE(mt.waste_qty, 0), 2) AS waste_qty,
      ROUND(COALESCE(mt.waste_val, 0), 2) AS waste_value,
      ROUND(COALESCE(mt.adjust_qty, 0), 2) AS adjust_qty,
      ROUND(COALESCE(mt.adjust_val, 0), 2) AS adjust_value
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
