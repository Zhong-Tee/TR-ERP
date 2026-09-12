-- ============================================
-- 104: Add Gross Profit fields to Trial Balance
-- Revenue recognition: shipped_time
-- Net sales: gross sales (incl. VAT) - approved refunds
-- ============================================

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

  -- Revenue metrics (recognized by shipped month)
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
