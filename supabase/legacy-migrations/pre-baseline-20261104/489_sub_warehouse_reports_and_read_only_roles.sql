-- Make sub-warehouse reports use Thailand day boundaries, keep the movement
-- running balance across the full ledger, and make selected operational roles
-- read-only for stock adjustments and product removal.

DROP FUNCTION IF EXISTS rpc_get_sub_warehouse_moves(UUID, DATE, DATE, TEXT);

CREATE FUNCTION rpc_get_sub_warehouse_moves(
  p_sub_warehouse_id UUID,
  p_date_from DATE,
  p_date_to DATE,
  p_product_code TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  created_by UUID,
  product_id UUID,
  product_code TEXT,
  product_name TEXT,
  unit_name TEXT,
  qty_delta NUMERIC,
  reason TEXT,
  note TEXT,
  balance_after NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT
      make_timestamptz(
        EXTRACT(YEAR FROM p_date_from)::int,
        EXTRACT(MONTH FROM p_date_from)::int,
        EXTRACT(DAY FROM p_date_from)::int,
        0, 0, 0, 'Asia/Bangkok'
      ) AS range_start,
      make_timestamptz(
        EXTRACT(YEAR FROM p_date_to)::int,
        EXTRACT(MONTH FROM p_date_to)::int,
        EXTRACT(DAY FROM p_date_to)::int,
        0, 0, 0, 'Asia/Bangkok'
      ) + interval '1 day' AS range_end_excl
  ),
  ranked AS (
    SELECT
      m.*,
      p.product_code,
      p.product_name,
      p.unit_name,
      SUM(m.qty_delta) OVER (
        PARTITION BY m.product_id
        ORDER BY m.created_at, m.id
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS running_balance
    FROM wh_sub_warehouse_stock_moves m
    JOIN pr_products p ON p.id = m.product_id
    WHERE m.sub_warehouse_id = p_sub_warehouse_id
  )
  SELECT
    r.id,
    r.created_at,
    r.created_by,
    r.product_id,
    r.product_code,
    r.product_name,
    r.unit_name,
    r.qty_delta,
    r.reason,
    r.note,
    r.running_balance AS balance_after
  FROM ranked r
  CROSS JOIN bounds b
  WHERE r.created_at >= b.range_start
    AND r.created_at < b.range_end_excl
    AND (
      p_product_code IS NULL OR btrim(p_product_code) = ''
      OR r.product_code ILIKE ('%' || btrim(p_product_code) || '%')
      OR r.product_name ILIKE ('%' || btrim(p_product_code) || '%')
    )
  ORDER BY r.created_at DESC, r.id DESC;
$$;

GRANT EXECUTE ON FUNCTION rpc_get_sub_warehouse_moves(UUID, DATE, DATE, TEXT) TO authenticated;

-- Product assignment: the three operational roles may still add/see assigned
-- products, but cannot remove them from a sub warehouse.
DROP POLICY IF EXISTS "Desktop roles can manage sub warehouse products" ON wh_sub_warehouse_products;
DROP POLICY IF EXISTS "Desktop roles can insert sub warehouse products" ON wh_sub_warehouse_products;
DROP POLICY IF EXISTS "Desktop roles can update sub warehouse products" ON wh_sub_warehouse_products;
DROP POLICY IF EXISTS "Desktop roles can delete sub warehouse products" ON wh_sub_warehouse_products;

CREATE POLICY "Desktop roles can insert sub warehouse products"
  ON wh_sub_warehouse_products FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin', 'admin', 'sales-tr', 'qc_order', 'sales-pump', 'qc_staff',
          'packing_staff', 'account', 'store', 'production', 'hr'
        )
    )
  );

CREATE POLICY "Desktop roles can update sub warehouse products"
  ON wh_sub_warehouse_products FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin', 'admin', 'sales-tr', 'qc_order', 'sales-pump', 'qc_staff',
          'packing_staff', 'account', 'store', 'production', 'hr'
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin', 'admin', 'sales-tr', 'qc_order', 'sales-pump', 'qc_staff',
          'packing_staff', 'account', 'store', 'production', 'hr'
        )
    )
  );

CREATE POLICY "Desktop roles can delete sub warehouse products"
  ON wh_sub_warehouse_products FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin', 'admin', 'sales-tr', 'qc_order', 'sales-pump',
          'account', 'store', 'hr'
        )
    )
  );

-- Stock movement ledger: production, qc_staff and packing_staff are read-only.
DROP POLICY IF EXISTS "Desktop roles can manage sub warehouse stock moves" ON wh_sub_warehouse_stock_moves;

CREATE POLICY "Desktop roles can manage sub warehouse stock moves"
  ON wh_sub_warehouse_stock_moves FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin', 'admin', 'sales-tr', 'qc_order', 'sales-pump',
          'account', 'store', 'hr'
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin', 'admin', 'sales-tr', 'qc_order', 'sales-pump',
          'account', 'store', 'hr'
        )
    )
  );
