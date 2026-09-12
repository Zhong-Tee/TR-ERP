-- 169: Inventory epoch opening + trial balance epoch-aware logic
-- Safe reset mode:
-- - keep historical data untouched
-- - start new accounting epoch from current stock snapshot
-- - trial balance uses epoch baseline for months on/after epoch start

CREATE TABLE IF NOT EXISTS ac_inventory_epochs (
  id BIGSERIAL PRIMARY KEY,
  epoch_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  note TEXT,
  created_by UUID REFERENCES us_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ac_inventory_epoch_openings (
  id BIGSERIAL PRIMARY KEY,
  epoch_id BIGINT NOT NULL REFERENCES ac_inventory_epochs(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES pr_products(id),
  opening_qty NUMERIC(14,2) NOT NULL DEFAULT 0,
  opening_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  opening_safety_qty NUMERIC(14,2) NOT NULL DEFAULT 0,
  opening_safety_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(epoch_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_epochs_active
  ON ac_inventory_epochs(is_active, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_epoch_openings_epoch
  ON ac_inventory_epoch_openings(epoch_id, product_id);

ALTER TABLE ac_inventory_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ac_inventory_epoch_openings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Inventory epoch read auth" ON ac_inventory_epochs;
CREATE POLICY "Inventory epoch read auth"
  ON ac_inventory_epochs FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Inventory epoch admin manage" ON ac_inventory_epochs;
CREATE POLICY "Inventory epoch admin manage"
  ON ac_inventory_epochs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'account')
    )
  );

DROP POLICY IF EXISTS "Inventory epoch openings read auth" ON ac_inventory_epoch_openings;
CREATE POLICY "Inventory epoch openings read auth"
  ON ac_inventory_epoch_openings FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Inventory epoch openings admin manage" ON ac_inventory_epoch_openings;
CREATE POLICY "Inventory epoch openings admin manage"
  ON ac_inventory_epoch_openings FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'account')
    )
  );

CREATE OR REPLACE FUNCTION rpc_start_inventory_epoch(
  p_pin TEXT,
  p_epoch_name TEXT DEFAULT NULL,
  p_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_uid UUID := auth.uid();
  v_epoch_id BIGINT;
  v_epoch_name TEXT;
  v_rows INT := 0;
  v_opening_value NUMERIC := 0;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์เริ่มรอบบัญชีสต๊อกใหม่';
  END IF;

  IF COALESCE(p_pin, '') <> '1688' THEN
    RAISE EXCEPTION 'รหัสยืนยันไม่ถูกต้อง';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('inventory_epoch_start'));

  UPDATE ac_inventory_epochs
  SET is_active = FALSE
  WHERE is_active = TRUE;

  v_epoch_name := COALESCE(
    NULLIF(trim(COALESCE(p_epoch_name, '')), ''),
    'EPOCH-' || to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD-HH24MI')
  );

  INSERT INTO ac_inventory_epochs (
    epoch_name, started_at, is_active, note, created_by
  )
  VALUES (
    v_epoch_name, NOW(), TRUE, p_note, v_uid
  )
  RETURNING id INTO v_epoch_id;

  INSERT INTO ac_inventory_epoch_openings (
    epoch_id, product_id, opening_qty, opening_value, opening_safety_qty, opening_safety_value
  )
  SELECT
    v_epoch_id,
    l.product_id,
    ROUND(SUM(CASE WHEN COALESCE(l.is_safety_stock, FALSE) = FALSE THEN l.qty_remaining ELSE 0 END), 2) AS opening_qty,
    ROUND(SUM(CASE WHEN COALESCE(l.is_safety_stock, FALSE) = FALSE THEN l.qty_remaining * l.unit_cost ELSE 0 END), 2) AS opening_value,
    ROUND(SUM(CASE WHEN COALESCE(l.is_safety_stock, FALSE) = TRUE  THEN l.qty_remaining ELSE 0 END), 2) AS opening_safety_qty,
    ROUND(SUM(CASE WHEN COALESCE(l.is_safety_stock, FALSE) = TRUE  THEN l.qty_remaining * l.unit_cost ELSE 0 END), 2) AS opening_safety_value
  FROM inv_stock_lots l
  WHERE l.qty_remaining > 0
  GROUP BY l.product_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT COALESCE(SUM(opening_value), 0)
  INTO v_opening_value
  FROM ac_inventory_epoch_openings
  WHERE epoch_id = v_epoch_id;

  RETURN jsonb_build_object(
    'success', true,
    'epoch_id', v_epoch_id,
    'epoch_name', v_epoch_name,
    'snapshot_products', v_rows,
    'opening_inventory_value', ROUND(v_opening_value, 2)
  );
END;
$$;

REVOKE ALL ON FUNCTION rpc_start_inventory_epoch(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_start_inventory_epoch(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_start_inventory_epoch(TEXT, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION rpc_trial_balance_summary(p_year INT, p_month INT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_month_start TIMESTAMPTZ;
  v_month_end   TIMESTAMPTZ;
  v_calc_start  TIMESTAMPTZ;
  v_use_epoch   BOOLEAN := FALSE;
  v_epoch_id    BIGINT;
  v_epoch_start TIMESTAMPTZ;
  v_opening_inventory NUMERIC := 0;
  v_opening_safety    NUMERIC := 0;
  v_net_before_month  NUMERIC := 0;
  v_purchases        NUMERIC := 0;
  v_cogs             NUMERIC := 0;
  v_requisition_cogs NUMERIC := 0;
  v_customer_cogs    NUMERIC := 0;
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
  v_calc_start := v_month_start;

  SELECT id, started_at
  INTO v_epoch_id, v_epoch_start
  FROM ac_inventory_epochs
  WHERE is_active = TRUE
  ORDER BY started_at DESC, id DESC
  LIMIT 1;

  IF v_epoch_id IS NOT NULL AND v_month_end > v_epoch_start THEN
    v_use_epoch := TRUE;
    IF v_epoch_start > v_calc_start THEN
      v_calc_start := v_epoch_start;
    END IF;
  END IF;

  FOR v_rec IN
    SELECT movement_type,
           SUM(total_cost) AS total,
           COUNT(*)        AS cnt
    FROM inv_stock_movements
    WHERE created_at >= v_calc_start AND created_at < v_month_end
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
  WHERE created_at >= v_calc_start AND created_at < v_month_end;

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

  IF v_use_epoch THEN
    SELECT
      COALESCE(SUM(opening_value), 0),
      COALESCE(SUM(opening_safety_value), 0)
    INTO v_opening_inventory, v_opening_safety
    FROM ac_inventory_epoch_openings
    WHERE epoch_id = v_epoch_id;

    IF v_month_start > v_epoch_start THEN
      SELECT COALESCE(SUM(total_cost), 0)
      INTO v_net_before_month
      FROM inv_stock_movements
      WHERE created_at >= v_epoch_start
        AND created_at < v_month_start
        AND movement_type <> 'waste'
        AND total_cost IS NOT NULL;
    END IF;

    v_beginning := v_opening_inventory + v_net_before_month;

    SELECT COALESCE(SUM(total_cost), 0)
    INTO v_month_net
    FROM inv_stock_movements
    WHERE created_at >= v_calc_start AND created_at < v_month_end
      AND movement_type <> 'waste'
      AND total_cost IS NOT NULL;

    v_ending := v_beginning + v_month_net;
    v_current_ss_val := COALESCE(v_current_ss_val, v_opening_safety);
  ELSE
    SELECT COALESCE(SUM(qty_remaining * unit_cost), 0)
    INTO v_current_lot_val
    FROM inv_stock_lots
    WHERE qty_remaining > 0 AND is_safety_stock = FALSE;

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
  END IF;

  SELECT COALESCE(SUM(
    CASE
      WHEN sm.movement_type = 'pick' THEN ABS(sm.total_cost)
      WHEN sm.movement_type = 'pick_reversal' THEN -sm.total_cost
      ELSE 0
    END
  ), 0)
  INTO v_requisition_cogs
  FROM inv_stock_movements sm
  JOIN wms_orders wo ON wo.id = sm.ref_id
  WHERE sm.created_at >= v_calc_start
    AND sm.created_at < v_month_end
    AND sm.ref_type = 'wms_orders'
    AND sm.movement_type IN ('pick', 'pick_reversal')
    AND sm.total_cost IS NOT NULL
    AND wo.order_id LIKE 'REQ-%';

  v_customer_cogs := v_cogs - v_requisition_cogs;

  WITH picked_orders AS (
    SELECT DISTINCT o.id, o.total_amount
    FROM inv_stock_movements sm
    JOIN wms_orders wo
      ON wo.id = sm.ref_id
     AND sm.ref_type = 'wms_orders'
     AND sm.movement_type = 'pick'
    JOIN or_orders o
      ON o.work_order_name = wo.order_id
    WHERE sm.created_at >= v_calc_start
      AND sm.created_at < v_month_end
      AND o.status <> 'ยกเลิก'
  )
  SELECT COALESCE(SUM(total_amount), 0)
  INTO v_gross_sales
  FROM picked_orders;

  SELECT COALESCE(SUM(r.amount), 0)
  INTO v_refunds_approved
  FROM ac_refunds r
  JOIN or_orders o ON o.id = r.order_id
  WHERE r.status = 'approved'
    AND o.shipped_time IS NOT NULL
    AND o.shipped_time >= v_calc_start
    AND o.shipped_time < v_month_end;

  v_net_sales := ROUND(v_gross_sales / 1.07, 2);
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
    'requisition_cogs',    ROUND(v_requisition_cogs, 2),
    'customer_cogs',       ROUND(v_customer_cogs, 2),
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
