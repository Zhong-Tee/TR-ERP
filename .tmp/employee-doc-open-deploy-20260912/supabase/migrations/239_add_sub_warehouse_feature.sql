-- ============================================
-- Sub Warehouse (คลังย่อย)
-- - Separate note stock ledger (no FIFO, no impact to main inventory)
-- ============================================

-- 1) Sub warehouses master
CREATE TABLE IF NOT EXISTS wh_sub_warehouses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES us_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS idx_wh_sub_warehouses_active
  ON wh_sub_warehouses(is_active);

-- 2) Product assignment per sub warehouse
CREATE TABLE IF NOT EXISTS wh_sub_warehouse_products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sub_warehouse_id UUID NOT NULL REFERENCES wh_sub_warehouses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES pr_products(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (sub_warehouse_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_wh_sub_warehouse_products_sub
  ON wh_sub_warehouse_products(sub_warehouse_id);

CREATE INDEX IF NOT EXISTS idx_wh_sub_warehouse_products_product
  ON wh_sub_warehouse_products(product_id);

-- 3) Stock moves ledger (note-only)
CREATE TABLE IF NOT EXISTS wh_sub_warehouse_stock_moves (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sub_warehouse_id UUID NOT NULL REFERENCES wh_sub_warehouses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES pr_products(id),
  qty_delta NUMERIC NOT NULL,
  reason TEXT,
  note TEXT,
  created_by UUID REFERENCES us_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wh_sub_warehouse_stock_moves_sub_product_time
  ON wh_sub_warehouse_stock_moves(sub_warehouse_id, product_id, created_at);

-- RLS
ALTER TABLE wh_sub_warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE wh_sub_warehouse_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE wh_sub_warehouse_stock_moves ENABLE ROW LEVEL SECURITY;

-- Read: any authenticated (UI still controls access via st_user_menus)
DROP POLICY IF EXISTS "Authenticated users can read sub warehouses" ON wh_sub_warehouses;
CREATE POLICY "Authenticated users can read sub warehouses"
  ON wh_sub_warehouses FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can read sub warehouse products" ON wh_sub_warehouse_products;
CREATE POLICY "Authenticated users can read sub warehouse products"
  ON wh_sub_warehouse_products FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can read sub warehouse stock moves" ON wh_sub_warehouse_stock_moves;
CREATE POLICY "Authenticated users can read sub warehouse stock moves"
  ON wh_sub_warehouse_stock_moves FOR SELECT
  USING (auth.role() = 'authenticated');

-- Write: allow desktop roles (menu access is configured in Settings)
DROP POLICY IF EXISTS "Desktop roles can manage sub warehouses" ON wh_sub_warehouses;
CREATE POLICY "Desktop roles can manage sub warehouses"
  ON wh_sub_warehouses FOR ALL
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

DROP POLICY IF EXISTS "Desktop roles can manage sub warehouse products" ON wh_sub_warehouse_products;
CREATE POLICY "Desktop roles can manage sub warehouse products"
  ON wh_sub_warehouse_products FOR ALL
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

DROP POLICY IF EXISTS "Desktop roles can manage sub warehouse stock moves" ON wh_sub_warehouse_stock_moves;
CREATE POLICY "Desktop roles can manage sub warehouse stock moves"
  ON wh_sub_warehouse_stock_moves FOR ALL
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

