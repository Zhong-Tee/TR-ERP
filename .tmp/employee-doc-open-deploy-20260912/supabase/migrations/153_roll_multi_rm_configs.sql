-- 153: Roll Material Calculator supports multiple RM per FG
-- - Add mapping table: roll_material_config_rms
-- - Backfill from legacy roll_material_configs.rm_product_id
-- - Update upsert/dashboard/usage-log functions to use RM mapping

BEGIN;

CREATE TABLE IF NOT EXISTS roll_material_config_rms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL REFERENCES roll_material_configs(id) ON DELETE CASCADE,
  rm_product_id UUID NOT NULL REFERENCES pr_products(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (config_id, rm_product_id)
);

CREATE INDEX IF NOT EXISTS idx_rmcr_config ON roll_material_config_rms(config_id);
CREATE INDEX IF NOT EXISTS idx_rmcr_rm ON roll_material_config_rms(rm_product_id);

ALTER TABLE roll_material_config_rms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rmcr_select" ON roll_material_config_rms;
CREATE POLICY "rmcr_select" ON roll_material_config_rms
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "rmcr_insert" ON roll_material_config_rms;
CREATE POLICY "rmcr_insert" ON roll_material_config_rms
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "rmcr_update" ON roll_material_config_rms;
CREATE POLICY "rmcr_update" ON roll_material_config_rms
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "rmcr_delete" ON roll_material_config_rms;
CREATE POLICY "rmcr_delete" ON roll_material_config_rms
  FOR DELETE TO authenticated USING (true);

INSERT INTO roll_material_config_rms (config_id, rm_product_id)
SELECT c.id, c.rm_product_id
FROM roll_material_configs c
WHERE c.rm_product_id IS NOT NULL
ON CONFLICT (config_id, rm_product_id) DO NOTHING;

ALTER TABLE roll_material_configs
  ALTER COLUMN rm_product_id DROP NOT NULL;

-- Drop old function signatures first to avoid return/signature conflicts
DROP FUNCTION IF EXISTS fn_upsert_roll_config(UUID, UUID, UUID, NUMERIC, NUMERIC);
DROP FUNCTION IF EXISTS fn_upsert_roll_config(UUID, UUID, UUID, NUMERIC, NUMERIC, UUID[]);

CREATE OR REPLACE FUNCTION fn_upsert_roll_config(
  p_fg_product_id UUID,
  p_rm_product_id UUID,
  p_category_id   UUID DEFAULT NULL,
  p_sheets        NUMERIC DEFAULT NULL,
  p_cost          NUMERIC DEFAULT NULL,
  p_rm_product_ids UUID[] DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_id UUID;
  v_primary_rm UUID;
  v_rm_ids UUID[];
BEGIN
  IF p_rm_product_ids IS NOT NULL AND COALESCE(array_length(p_rm_product_ids, 1), 0) > 0 THEN
    v_rm_ids := p_rm_product_ids;
  ELSIF p_rm_product_id IS NOT NULL THEN
    v_rm_ids := ARRAY[p_rm_product_id];
  ELSE
    v_rm_ids := ARRAY[]::UUID[];
  END IF;

  IF COALESCE(array_length(v_rm_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'ต้องเลือกรายการ RM อย่างน้อย 1 รายการ';
  END IF;

  v_primary_rm := v_rm_ids[1];

  INSERT INTO roll_material_configs (fg_product_id, rm_product_id, category_id, sheets_per_roll, cost_per_sheet)
  VALUES (p_fg_product_id, v_primary_rm, p_category_id, p_sheets, p_cost)
  ON CONFLICT (fg_product_id) DO UPDATE SET
    rm_product_id   = EXCLUDED.rm_product_id,
    category_id     = EXCLUDED.category_id,
    sheets_per_roll = EXCLUDED.sheets_per_roll,
    cost_per_sheet  = EXCLUDED.cost_per_sheet,
    updated_at      = now()
  RETURNING id INTO v_id;

  DELETE FROM roll_material_config_rms WHERE config_id = v_id;
  INSERT INTO roll_material_config_rms (config_id, rm_product_id)
  SELECT v_id, x
  FROM unnest(v_rm_ids) AS x
  ON CONFLICT (config_id, rm_product_id) DO NOTHING;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION fn_log_roll_usage_on_requisition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'approved'
     AND (OLD.status IS DISTINCT FROM 'approved')
  THEN
    INSERT INTO roll_usage_logs (rm_product_id, qty, source_type, source_id, event_date)
    SELECT DISTINCT p.id, ri.qty, 'requisition', NEW.id, COALESCE(NEW.approved_at, now())
    FROM wms_requisition_items ri
    JOIN pr_products p ON p.product_code = ri.product_code
    WHERE ri.requisition_id = NEW.requisition_id
      AND EXISTS (
        SELECT 1
        FROM roll_material_config_rms m
        WHERE m.rm_product_id = p.id
      );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fn_log_roll_usage_on_borrow()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'approved'
     AND (OLD.status IS DISTINCT FROM 'approved')
  THEN
    INSERT INTO roll_usage_logs (rm_product_id, qty, source_type, source_id, event_date)
    SELECT DISTINCT bi.product_id, bi.qty, 'borrow', NEW.id, COALESCE(NEW.approved_at, now())
    FROM wms_borrow_requisition_items bi
    WHERE bi.borrow_requisition_id = NEW.id
      AND EXISTS (
        SELECT 1
        FROM roll_material_config_rms m
        WHERE m.rm_product_id = bi.product_id
      );
  END IF;
  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS fn_get_roll_calc_dashboard();

CREATE OR REPLACE FUNCTION fn_get_roll_calc_dashboard()
RETURNS TABLE (
  config_id            UUID,
  fg_product_id        UUID,
  fg_product_code      TEXT,
  fg_product_name      TEXT,
  fg_product_category  TEXT,
  rm_product_id        UUID,
  rm_product_code      TEXT,
  rm_product_name      TEXT,
  rm_count             INT,
  rm_on_hand           NUMERIC,
  category_id          UUID,
  category_name        TEXT,
  sheets_per_roll      NUMERIC,
  cost_per_sheet       NUMERIC,
  calc_sheets_per_roll NUMERIC,
  calc_cost_per_sheet  NUMERIC,
  calc_period_start    TIMESTAMPTZ,
  calc_period_end      TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  r RECORD;
  v_log1 RECORD;
  v_log2 RECORD;
  v_fg_sold NUMERIC;
  v_rm_used_total NUMERIC;
  v_rm_lot_cost NUMERIC;
BEGIN
  FOR r IN
    SELECT
      c.id AS cfg_id,
      fg.id AS fg_id,
      fg.product_code AS fg_code,
      fg.product_name AS fg_name,
      fg.product_category AS fg_cat,
      MIN(m.rm_product_id) AS first_rm_id,
      COALESCE(STRING_AGG(rm.product_code, E'\n' ORDER BY rm.product_code), '-') AS rm_codes,
      COALESCE(STRING_AGG(rm.product_name, E'\n' ORDER BY rm.product_code), '-') AS rm_names,
      COUNT(m.rm_product_id)::INT AS rm_count_val,
      COALESCE(SUM(sb.on_hand), 0) AS rm_oh,
      c.category_id AS cat_id,
      cat.name AS cat_name,
      c.sheets_per_roll AS spr,
      c.cost_per_sheet AS cps
      ,
      COALESCE(cat.sort_order, 999) AS cat_sort
    FROM roll_material_configs c
    JOIN pr_products fg ON fg.id = c.fg_product_id
    LEFT JOIN roll_material_config_rms m ON m.config_id = c.id
    LEFT JOIN pr_products rm ON rm.id = m.rm_product_id
    LEFT JOIN inv_stock_balances sb ON sb.product_id = m.rm_product_id
    LEFT JOIN roll_material_categories cat ON cat.id = c.category_id
    GROUP BY
      c.id, fg.id, fg.product_code, fg.product_name, fg.product_category,
      c.category_id, cat.name, c.sheets_per_roll, c.cost_per_sheet, cat.sort_order
    ORDER BY cat_sort, fg.product_code
  LOOP
    config_id            := r.cfg_id;
    fg_product_id        := r.fg_id;
    fg_product_code      := r.fg_code;
    fg_product_name      := r.fg_name;
    fg_product_category  := r.fg_cat;
    rm_product_id        := r.first_rm_id;
    rm_product_code      := r.rm_codes;
    rm_product_name      := r.rm_names;
    rm_count             := r.rm_count_val;
    rm_on_hand           := r.rm_oh;
    category_id          := r.cat_id;
    category_name        := r.cat_name;
    sheets_per_roll      := r.spr;
    cost_per_sheet       := r.cps;
    calc_sheets_per_roll := NULL;
    calc_cost_per_sheet  := NULL;
    calc_period_start    := NULL;
    calc_period_end      := NULL;

    SELECT l.id, l.event_date INTO v_log2
    FROM roll_usage_logs l
    JOIN roll_material_config_rms m ON m.rm_product_id = l.rm_product_id
    WHERE m.config_id = r.cfg_id
    ORDER BY l.event_date DESC, l.created_at DESC, l.id DESC
    LIMIT 1;

    IF FOUND THEN
      SELECT l.id, l.event_date INTO v_log1
      FROM roll_usage_logs l
      JOIN roll_material_config_rms m ON m.rm_product_id = l.rm_product_id
      WHERE m.config_id = r.cfg_id
        AND l.id <> v_log2.id
      ORDER BY l.event_date DESC, l.created_at DESC, l.id DESC
      LIMIT 1;

      IF FOUND THEN
        calc_period_start := v_log1.event_date;
        calc_period_end   := v_log2.event_date;

        SELECT COALESCE(SUM(ABS(mv.qty)), 0) INTO v_fg_sold
        FROM inv_stock_movements mv
        WHERE mv.product_id = r.fg_id
          AND mv.movement_type = 'pick'
          AND mv.created_at >= v_log1.event_date
          AND mv.created_at < v_log2.event_date;

        SELECT COALESCE(SUM(lg.qty), 0) INTO v_rm_used_total
        FROM roll_usage_logs lg
        JOIN roll_material_config_rms mm ON mm.rm_product_id = lg.rm_product_id
        WHERE mm.config_id = r.cfg_id
          AND lg.event_date >= v_log1.event_date
          AND lg.event_date < v_log2.event_date;

        IF v_fg_sold > 0 AND v_rm_used_total > 0 THEN
          calc_sheets_per_roll := ROUND(v_fg_sold / v_rm_used_total, 2);
        END IF;

        SELECT
          CASE
            WHEN SUM(l.qty_remaining) > 0 THEN SUM(l.qty_remaining * l.unit_cost) / SUM(l.qty_remaining)
            ELSE NULL
          END
        INTO v_rm_lot_cost
        FROM inv_stock_lots l
        JOIN roll_material_config_rms mm ON mm.rm_product_id = l.product_id
        WHERE mm.config_id = r.cfg_id
          AND l.qty_remaining > 0;

        IF v_rm_lot_cost IS NOT NULL AND COALESCE(calc_sheets_per_roll, 0) > 0 THEN
          calc_cost_per_sheet := ROUND(v_rm_lot_cost / calc_sheets_per_roll, 4);
        END IF;
      END IF;
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$$;

COMMIT;
