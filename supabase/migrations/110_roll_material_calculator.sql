-- ═══════════════════════════════════════════════════════════
-- 110: Roll Material Calculator
--   - roll_material_categories  (หมวดหมู่ม้วน)
--   - roll_material_configs     (จับคู่ FG ↔ RM + manual values)
--   - roll_usage_logs           (บันทึกการเบิก RM ม้วน)
--   - triggers on requisition / borrow approval
--   - fn_get_roll_calc_dashboard (batch RPC)
-- ═══════════════════════════════════════════════════════════

-- ── 1. Categories ────────────────────────────────────────

CREATE TABLE roll_material_categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  sort_order INT  NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE roll_material_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rmc_select" ON roll_material_categories
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "rmc_insert" ON roll_material_categories
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "rmc_update" ON roll_material_categories
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "rmc_delete" ON roll_material_categories
  FOR DELETE TO authenticated USING (true);

-- ── 2. Configs (FG ↔ RM pairing) ────────────────────────

CREATE TABLE roll_material_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fg_product_id   UUID NOT NULL REFERENCES pr_products(id),
  rm_product_id   UUID NOT NULL REFERENCES pr_products(id),
  category_id     UUID REFERENCES roll_material_categories(id) ON DELETE SET NULL,
  sheets_per_roll NUMERIC(12,2),
  cost_per_sheet  NUMERIC(14,4),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fg_product_id)
);

CREATE INDEX idx_rmc_rm ON roll_material_configs(rm_product_id);
CREATE INDEX idx_rmc_cat ON roll_material_configs(category_id);

ALTER TABLE roll_material_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rmcfg_select" ON roll_material_configs
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "rmcfg_insert" ON roll_material_configs
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "rmcfg_update" ON roll_material_configs
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "rmcfg_delete" ON roll_material_configs
  FOR DELETE TO authenticated USING (true);

-- ── 3. Usage logs ────────────────────────────────────────

CREATE TABLE roll_usage_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rm_product_id  UUID NOT NULL REFERENCES pr_products(id),
  qty            NUMERIC(12,2) NOT NULL DEFAULT 1,
  source_type    TEXT NOT NULL,  -- 'requisition' | 'borrow' | 'manual'
  source_id      UUID,
  event_date     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rul_rm_date ON roll_usage_logs(rm_product_id, event_date DESC);

ALTER TABLE roll_usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rul_select" ON roll_usage_logs
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "rul_insert" ON roll_usage_logs
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "rul_delete" ON roll_usage_logs
  FOR DELETE TO authenticated USING (true);

-- ── 4. Trigger: log on requisition approved ──────────────

CREATE OR REPLACE FUNCTION fn_log_roll_usage_on_requisition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'approved'
     AND (OLD.status IS DISTINCT FROM 'approved')
  THEN
    INSERT INTO roll_usage_logs (rm_product_id, qty, source_type, source_id, event_date)
    SELECT p.id, ri.qty, 'requisition', NEW.id, COALESCE(NEW.approved_at, now())
    FROM wms_requisition_items ri
    JOIN pr_products p ON p.product_code = ri.product_code
    JOIN roll_material_configs rmc ON rmc.rm_product_id = p.id
    WHERE ri.requisition_id = NEW.requisition_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_log_roll_usage_requisition
  AFTER UPDATE ON wms_requisitions
  FOR EACH ROW
  EXECUTE FUNCTION fn_log_roll_usage_on_requisition();

-- ── 5. Trigger: log on borrow approved ───────────────────

CREATE OR REPLACE FUNCTION fn_log_roll_usage_on_borrow()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'approved'
     AND (OLD.status IS DISTINCT FROM 'approved')
  THEN
    INSERT INTO roll_usage_logs (rm_product_id, qty, source_type, source_id, event_date)
    SELECT bi.product_id, bi.qty, 'borrow', NEW.id, COALESCE(NEW.approved_at, now())
    FROM wms_borrow_requisition_items bi
    JOIN roll_material_configs rmc ON rmc.rm_product_id = bi.product_id
    WHERE bi.borrow_requisition_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_log_roll_usage_borrow
  AFTER UPDATE ON wms_borrow_requisitions
  FOR EACH ROW
  EXECUTE FUNCTION fn_log_roll_usage_on_borrow();

-- ── 6. Dashboard RPC (single call) ──────────────────────

CREATE OR REPLACE FUNCTION fn_get_roll_calc_dashboard()
RETURNS TABLE (
  config_id           UUID,
  fg_product_id       UUID,
  fg_product_code     TEXT,
  fg_product_name     TEXT,
  fg_product_category TEXT,
  rm_product_id       UUID,
  rm_product_code     TEXT,
  rm_product_name     TEXT,
  rm_on_hand          NUMERIC,
  category_id         UUID,
  category_name       TEXT,
  sheets_per_roll     NUMERIC,
  cost_per_sheet      NUMERIC,
  calc_sheets_per_roll NUMERIC,
  calc_cost_per_sheet  NUMERIC,
  calc_period_start   TIMESTAMPTZ,
  calc_period_end     TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  r RECORD;
  v_log1 RECORD;
  v_log2 RECORD;
  v_fg_sold NUMERIC;
  v_rm_lot_cost NUMERIC;
BEGIN
  FOR r IN
    SELECT
      c.id            AS cfg_id,
      fg.id           AS fg_id,
      fg.product_code AS fg_code,
      fg.product_name AS fg_name,
      fg.product_category AS fg_cat,
      rm.id           AS rm_id,
      rm.product_code AS rm_code,
      rm.product_name AS rm_name,
      COALESCE(sb.on_hand, 0) AS rm_oh,
      c.category_id   AS cat_id,
      cat.name        AS cat_name,
      c.sheets_per_roll AS spr,
      c.cost_per_sheet  AS cps
    FROM roll_material_configs c
    JOIN pr_products fg  ON fg.id = c.fg_product_id
    JOIN pr_products rm  ON rm.id = c.rm_product_id
    LEFT JOIN inv_stock_balances sb ON sb.product_id = c.rm_product_id
    LEFT JOIN roll_material_categories cat ON cat.id = c.category_id
    ORDER BY COALESCE(cat.sort_order, 999), fg.product_code
  LOOP
    config_id           := r.cfg_id;
    fg_product_id       := r.fg_id;
    fg_product_code     := r.fg_code;
    fg_product_name     := r.fg_name;
    fg_product_category := r.fg_cat;
    rm_product_id       := r.rm_id;
    rm_product_code     := r.rm_code;
    rm_product_name     := r.rm_name;
    rm_on_hand          := r.rm_oh;
    category_id         := r.cat_id;
    category_name       := r.cat_name;
    sheets_per_roll     := r.spr;
    cost_per_sheet      := r.cps;
    calc_sheets_per_roll := NULL;
    calc_cost_per_sheet  := NULL;
    calc_period_start   := NULL;
    calc_period_end     := NULL;

    -- Find last 2 usage logs for this RM
    SELECT * INTO v_log2
    FROM roll_usage_logs
    WHERE roll_usage_logs.rm_product_id = r.rm_id
    ORDER BY event_date DESC
    LIMIT 1;

    IF FOUND THEN
      SELECT * INTO v_log1
      FROM roll_usage_logs
      WHERE roll_usage_logs.rm_product_id = r.rm_id
        AND roll_usage_logs.id <> v_log2.id
      ORDER BY event_date DESC
      LIMIT 1;

      IF FOUND THEN
        calc_period_start := v_log1.event_date;
        calc_period_end   := v_log2.event_date;

        -- Count FG sold (pick movements) in this period
        SELECT COALESCE(SUM(ABS(m.qty)), 0) INTO v_fg_sold
        FROM inv_stock_movements m
        WHERE m.product_id = r.fg_id
          AND m.movement_type = 'pick'
          AND m.created_at >= v_log1.event_date
          AND m.created_at < v_log2.event_date;

        IF v_fg_sold > 0 AND COALESCE(v_log1.qty, 1) > 0 THEN
          calc_sheets_per_roll := ROUND(v_fg_sold / v_log1.qty, 2);
        END IF;

        -- FIFO cost: oldest lot with remaining qty for RM
        SELECT l.unit_cost INTO v_rm_lot_cost
        FROM inv_stock_lots l
        WHERE l.product_id = r.rm_id
          AND l.qty_remaining > 0
        ORDER BY l.created_at ASC
        LIMIT 1;

        IF v_rm_lot_cost IS NOT NULL AND COALESCE(calc_sheets_per_roll, 0) > 0 THEN
          calc_cost_per_sheet := ROUND(v_rm_lot_cost / calc_sheets_per_roll, 4);
        END IF;
      END IF;
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$$;

-- ── 7. Upsert config RPC ────────────────────────────────

CREATE OR REPLACE FUNCTION fn_upsert_roll_config(
  p_fg_product_id UUID,
  p_rm_product_id UUID,
  p_category_id   UUID DEFAULT NULL,
  p_sheets        NUMERIC DEFAULT NULL,
  p_cost          NUMERIC DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO roll_material_configs (fg_product_id, rm_product_id, category_id, sheets_per_roll, cost_per_sheet)
  VALUES (p_fg_product_id, p_rm_product_id, p_category_id, p_sheets, p_cost)
  ON CONFLICT (fg_product_id) DO UPDATE SET
    rm_product_id   = EXCLUDED.rm_product_id,
    category_id     = EXCLUDED.category_id,
    sheets_per_roll = EXCLUDED.sheets_per_roll,
    cost_per_sheet  = EXCLUDED.cost_per_sheet,
    updated_at      = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
