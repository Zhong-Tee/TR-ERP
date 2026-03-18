-- 155: Remove unused calculated fields from roll calc dashboard RPC
-- Keep only fields used by current UI

DROP FUNCTION IF EXISTS fn_get_roll_calc_dashboard();

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
  rm_count            INT,
  rm_on_hand          NUMERIC,
  category_id         UUID,
  category_name       TEXT,
  sheets_per_roll     NUMERIC,
  cost_per_sheet      NUMERIC
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  r RECORD;
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
      c.cost_per_sheet AS cps,
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
    config_id           := r.cfg_id;
    fg_product_id       := r.fg_id;
    fg_product_code     := r.fg_code;
    fg_product_name     := r.fg_name;
    fg_product_category := r.fg_cat;
    rm_product_id       := r.first_rm_id;
    rm_product_code     := r.rm_codes;
    rm_product_name     := r.rm_names;
    rm_count            := r.rm_count_val;
    rm_on_hand          := r.rm_oh;
    category_id         := r.cat_id;
    category_name       := r.cat_name;
    sheets_per_roll     := r.spr;
    cost_per_sheet      := r.cps;

    RETURN NEXT;
  END LOOP;
END;
$$;
