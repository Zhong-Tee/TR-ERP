-- ============================================
-- Sub warehouse: flexible WMS map (spare ↔ production sum)
-- กลุ่มจับคู่: หลายรหัสอะไหล่คลังย่อย → ยอดผลิต WMS รวมจากหลายรหัสสินค้าผลิต
-- sub_warehouse_id NULL = ใช้กับทุกคลังย่อยเมื่อมีสินค้านั้นในรายการ
-- ============================================

CREATE TABLE IF NOT EXISTS wh_sub_wms_map_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL DEFAULT 'กลุ่มจับคู่',
  sub_warehouse_id UUID REFERENCES wh_sub_warehouses(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wh_sub_wms_map_spares (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES wh_sub_wms_map_groups(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES pr_products(id) ON DELETE CASCADE,
  UNIQUE (product_id)
);

CREATE TABLE IF NOT EXISTS wh_sub_wms_map_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES wh_sub_wms_map_groups(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES pr_products(id) ON DELETE CASCADE,
  UNIQUE (group_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_wh_sub_wms_map_spares_group ON wh_sub_wms_map_spares(group_id);
CREATE INDEX IF NOT EXISTS idx_wh_sub_wms_map_sources_group ON wh_sub_wms_map_sources(group_id);

ALTER TABLE wh_sub_wms_map_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE wh_sub_wms_map_spares ENABLE ROW LEVEL SECURITY;
ALTER TABLE wh_sub_wms_map_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read wh_sub_wms_map_groups" ON wh_sub_wms_map_groups;
CREATE POLICY "Authenticated read wh_sub_wms_map_groups"
  ON wh_sub_wms_map_groups FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Desktop manage wh_sub_wms_map_groups" ON wh_sub_wms_map_groups;
CREATE POLICY "Desktop manage wh_sub_wms_map_groups"
  ON wh_sub_wms_map_groups FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin', 'admin', 'sales-tr', 'qc_order', 'sales-pump', 'qc_staff',
          'packing_staff', 'account', 'store', 'production', 'hr'
        )
    )
  );

DROP POLICY IF EXISTS "Authenticated read wh_sub_wms_map_spares" ON wh_sub_wms_map_spares;
CREATE POLICY "Authenticated read wh_sub_wms_map_spares"
  ON wh_sub_wms_map_spares FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Desktop manage wh_sub_wms_map_spares" ON wh_sub_wms_map_spares;
CREATE POLICY "Desktop manage wh_sub_wms_map_spares"
  ON wh_sub_wms_map_spares FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin', 'admin', 'sales-tr', 'qc_order', 'sales-pump', 'qc_staff',
          'packing_staff', 'account', 'store', 'production', 'hr'
        )
    )
  );

DROP POLICY IF EXISTS "Authenticated read wh_sub_wms_map_sources" ON wh_sub_wms_map_sources;
CREATE POLICY "Authenticated read wh_sub_wms_map_sources"
  ON wh_sub_wms_map_sources FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Desktop manage wh_sub_wms_map_sources" ON wh_sub_wms_map_sources;
CREATE POLICY "Desktop manage wh_sub_wms_map_sources"
  ON wh_sub_wms_map_sources FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin', 'admin', 'sales-tr', 'qc_order', 'sales-pump', 'qc_staff',
          'packing_staff', 'account', 'store', 'production', 'hr'
        )
    )
  );

-- Optional seed (only if empty): mirror previous hardcoded 990000430/431 ← 110000096–099
DO $$
DECLARE
  gid UUID;
  n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM wh_sub_wms_map_groups;
  IF n > 0 THEN
    RETURN;
  END IF;

  INSERT INTO wh_sub_wms_map_groups (name, sub_warehouse_id)
  VALUES ('ตั้งค่าเริ่มต้น (หน้ายาง/โฟม A)', NULL)
  RETURNING id INTO gid;

  INSERT INTO wh_sub_wms_map_spares (group_id, product_id)
  SELECT gid, p.id
  FROM pr_products p
  WHERE p.product_code IN ('990000430', '990000431')
  ON CONFLICT (product_id) DO NOTHING;

  INSERT INTO wh_sub_wms_map_sources (group_id, product_id)
  SELECT gid, p.id
  FROM pr_products p
  WHERE p.product_code IN ('110000096', '110000097', '110000098', '110000099')
  ON CONFLICT (group_id, product_id) DO NOTHING;
END $$;

-- Replace daily sheet RPC: use map tables instead of hardcoded codes
DROP FUNCTION IF EXISTS rpc_get_sub_warehouse_daily_stock_sheet(UUID, DATE);

CREATE FUNCTION rpc_get_sub_warehouse_daily_stock_sheet(
  p_sub_warehouse_id UUID,
  p_date DATE
)
RETURNS TABLE (
  product_id UUID,
  product_code TEXT,
  product_name TEXT,
  unit_name TEXT,
  received_opening NUMERIC,
  replenish_day NUMERIC,
  reduce_day NUMERIC,
  wms_opening NUMERIC,
  wms_day NUMERIC,
  balance_opening NUMERIC,
  balance_eod NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  WITH bounds AS (
    SELECT
      make_timestamptz(
        EXTRACT(YEAR FROM p_date)::int,
        EXTRACT(MONTH FROM p_date)::int,
        EXTRACT(DAY FROM p_date)::int,
        0, 0, 0,
        'Asia/Bangkok'
      ) AS day_start,
      make_timestamptz(
        EXTRACT(YEAR FROM p_date)::int,
        EXTRACT(MONTH FROM p_date)::int,
        EXTRACT(DAY FROM p_date)::int,
        0, 0, 0,
        'Asia/Bangkok'
      ) + interval '1 day' AS day_end_excl
  ),
  groups_scope AS (
    SELECT g.id
    FROM wh_sub_wms_map_groups g
    WHERE g.sub_warehouse_id IS NULL
       OR g.sub_warehouse_id = p_sub_warehouse_id
  ),
  group_wms_open AS (
    SELECT
      src.group_id,
      COALESCE(SUM(o.qty), 0)::numeric AS qty
    FROM wh_sub_wms_map_sources src
    JOIN groups_scope gs ON gs.id = src.group_id
    JOIN pr_products ps ON ps.id = src.product_id
    JOIN wms_orders o ON o.product_code::text = ps.product_code::text
    JOIN wms_order_summaries s ON s.order_id = o.order_id
    CROSS JOIN bounds b
    WHERE o.status = 'correct'
      AND s.checked_at < b.day_start
    GROUP BY src.group_id
  ),
  group_wms_day AS (
    SELECT
      src.group_id,
      COALESCE(SUM(o.qty), 0)::numeric AS qty
    FROM wh_sub_wms_map_sources src
    JOIN groups_scope gs ON gs.id = src.group_id
    JOIN pr_products ps ON ps.id = src.product_id
    JOIN wms_orders o ON o.product_code::text = ps.product_code::text
    JOIN wms_order_summaries s ON s.order_id = o.order_id
    CROSS JOIN bounds b
    WHERE o.status = 'correct'
      AND s.checked_at >= b.day_start
      AND s.checked_at < b.day_end_excl
    GROUP BY src.group_id
  ),
  spare_group AS (
    SELECT
      sp.product_id,
      sp.group_id
    FROM wh_sub_wms_map_spares sp
    JOIN groups_scope gs ON gs.id = sp.group_id
  ),
  products AS (
    SELECT
      sp.product_id,
      p.product_code,
      p.product_name,
      p.unit_name
    FROM wh_sub_warehouse_products sp
    JOIN pr_products p ON p.id = sp.product_id
    WHERE sp.sub_warehouse_id = p_sub_warehouse_id
  ),
  recv_open AS (
    SELECT
      m.product_id,
      COALESCE(SUM(m.qty_delta), 0)::numeric AS qty
    FROM wh_sub_warehouse_stock_moves m
    CROSS JOIN bounds b
    WHERE m.sub_warehouse_id = p_sub_warehouse_id
      AND m.created_at < b.day_start
    GROUP BY m.product_id
  ),
  recv_day AS (
    SELECT
      m.product_id,
      COALESCE(SUM(CASE WHEN m.qty_delta > 0 THEN m.qty_delta ELSE 0 END), 0)::numeric AS replenish,
      COALESCE(SUM(CASE WHEN m.qty_delta < 0 THEN m.qty_delta ELSE 0 END), 0)::numeric AS reduce_sum
    FROM wh_sub_warehouse_stock_moves m
    CROSS JOIN bounds b
    WHERE m.sub_warehouse_id = p_sub_warehouse_id
      AND m.created_at >= b.day_start
      AND m.created_at < b.day_end_excl
    GROUP BY m.product_id
  ),
  wms_open AS (
    SELECT
      o.product_code::text AS product_code,
      COALESCE(SUM(o.qty), 0)::numeric AS qty
    FROM wms_orders o
    JOIN wms_order_summaries s ON s.order_id = o.order_id
    CROSS JOIN bounds b
    WHERE o.status = 'correct'
      AND s.checked_at < b.day_start
    GROUP BY o.product_code
  ),
  wms_day_tbl AS (
    SELECT
      o.product_code::text AS product_code,
      COALESCE(SUM(o.qty), 0)::numeric AS qty
    FROM wms_orders o
    JOIN wms_order_summaries s ON s.order_id = o.order_id
    CROSS JOIN bounds b
    WHERE o.status = 'correct'
      AND s.checked_at >= b.day_start
      AND s.checked_at < b.day_end_excl
    GROUP BY o.product_code
  )
  SELECT
    pr.product_id,
    pr.product_code,
    pr.product_name,
    pr.unit_name,
    COALESCE(ro.qty, 0)::numeric AS received_opening,
    COALESCE(rd.replenish, 0)::numeric AS replenish_day,
    COALESCE(rd.reduce_sum, 0)::numeric AS reduce_day,
    (
      CASE
        WHEN sg.group_id IS NOT NULL THEN COALESCE(gwo.qty, 0)
        ELSE COALESCE(wo.qty, 0)
      END
    )::numeric AS wms_opening,
    (
      CASE
        WHEN sg.group_id IS NOT NULL THEN COALESCE(gwd.qty, 0)
        ELSE COALESCE(wd.qty, 0)
      END
    )::numeric AS wms_day,
    (
      COALESCE(ro.qty, 0)
      - (
        CASE
          WHEN sg.group_id IS NOT NULL THEN COALESCE(gwo.qty, 0)
          ELSE COALESCE(wo.qty, 0)
        END
      )
    )::numeric AS balance_opening,
    (
      (COALESCE(ro.qty, 0) + COALESCE(rd.replenish, 0) + COALESCE(rd.reduce_sum, 0))
      - (
        (
          CASE
            WHEN sg.group_id IS NOT NULL THEN COALESCE(gwo.qty, 0)
            ELSE COALESCE(wo.qty, 0)
          END
        )
        + (
          CASE
            WHEN sg.group_id IS NOT NULL THEN COALESCE(gwd.qty, 0)
            ELSE COALESCE(wd.qty, 0)
          END
        )
      )
    )::numeric AS balance_eod
  FROM products pr
  LEFT JOIN spare_group sg ON sg.product_id = pr.product_id
  LEFT JOIN group_wms_open gwo ON gwo.group_id = sg.group_id
  LEFT JOIN group_wms_day gwd ON gwd.group_id = sg.group_id
  LEFT JOIN recv_open ro ON ro.product_id = pr.product_id
  LEFT JOIN recv_day rd ON rd.product_id = pr.product_id
  LEFT JOIN wms_open wo ON wo.product_code = pr.product_code
  LEFT JOIN wms_day_tbl wd ON wd.product_code = pr.product_code
  ORDER BY pr.product_code ASC;
$$;

GRANT EXECUTE ON FUNCTION rpc_get_sub_warehouse_daily_stock_sheet(UUID, DATE) TO authenticated;
