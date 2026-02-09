-- ============================================
-- INVENTORY STOCK TABLES
-- ============================================
CREATE TABLE IF NOT EXISTS inv_stock_balances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID NOT NULL REFERENCES pr_products(id),
  on_hand NUMERIC(12, 2) DEFAULT 0,
  reserved NUMERIC(12, 2) DEFAULT 0,
  safety_stock NUMERIC(12, 2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(product_id)
);

CREATE TABLE IF NOT EXISTS inv_stock_movements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID NOT NULL REFERENCES pr_products(id),
  movement_type TEXT NOT NULL,
  qty NUMERIC(12, 2) NOT NULL,
  ref_type TEXT,
  ref_id UUID,
  note TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE inv_stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_stock_movements ENABLE ROW LEVEL SECURITY;

-- RLS Policies for inventory
CREATE POLICY "Anyone authenticated can view stock balances"
  ON inv_stock_balances FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage stock balances"
  ON inv_stock_balances FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'manager')
    )
  );

CREATE POLICY "Anyone authenticated can view stock movements"
  ON inv_stock_movements FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage stock movements"
  ON inv_stock_movements FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'manager')
    )
  );

DROP TRIGGER IF EXISTS update_inv_stock_balances_updated_at ON inv_stock_balances;
CREATE TRIGGER update_inv_stock_balances_updated_at
  BEFORE UPDATE ON inv_stock_balances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- PR / PO / GR TABLES
-- ============================================
CREATE TABLE IF NOT EXISTS inv_pr (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pr_no TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'pending',
  requested_by UUID,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inv_pr_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pr_id UUID NOT NULL REFERENCES inv_pr(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES pr_products(id),
  qty NUMERIC(12, 2) NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inv_po (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_no TEXT UNIQUE NOT NULL,
  pr_id UUID REFERENCES inv_pr(id),
  status TEXT DEFAULT 'open',
  ordered_by UUID,
  ordered_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inv_po_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_id UUID NOT NULL REFERENCES inv_po(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES pr_products(id),
  qty NUMERIC(12, 2) NOT NULL,
  unit_price NUMERIC(12, 2),
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inv_gr (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gr_no TEXT UNIQUE NOT NULL,
  po_id UUID REFERENCES inv_po(id),
  status TEXT DEFAULT 'pending',
  received_by UUID,
  received_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inv_gr_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gr_id UUID NOT NULL REFERENCES inv_gr(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES pr_products(id),
  qty_received NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE inv_pr ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_pr_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_po ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_po_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_gr ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_gr_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can view PR"
  ON inv_pr FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage PR"
  ON inv_pr FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'manager', 'store')
    )
  );

CREATE POLICY "Anyone authenticated can view PR items"
  ON inv_pr_items FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage PR items"
  ON inv_pr_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'manager', 'store')
    )
  );

CREATE POLICY "Anyone authenticated can view PO"
  ON inv_po FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage PO"
  ON inv_po FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'manager', 'store')
    )
  );

CREATE POLICY "Anyone authenticated can view PO items"
  ON inv_po_items FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage PO items"
  ON inv_po_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'manager', 'store')
    )
  );

CREATE POLICY "Anyone authenticated can view GR"
  ON inv_gr FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage GR"
  ON inv_gr FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'manager', 'store')
    )
  );

CREATE POLICY "Anyone authenticated can view GR items"
  ON inv_gr_items FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage GR items"
  ON inv_gr_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'manager', 'store')
    )
  );

DROP TRIGGER IF EXISTS update_inv_pr_updated_at ON inv_pr;
CREATE TRIGGER update_inv_pr_updated_at
  BEFORE UPDATE ON inv_pr
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_inv_po_updated_at ON inv_po;
CREATE TRIGGER update_inv_po_updated_at
  BEFORE UPDATE ON inv_po
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_inv_gr_updated_at ON inv_gr;
CREATE TRIGGER update_inv_gr_updated_at
  BEFORE UPDATE ON inv_gr
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- AUDIT TABLES
-- ============================================
CREATE TABLE IF NOT EXISTS inv_audits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  audit_no TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'draft',
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  accuracy_percent NUMERIC(5, 2),
  total_items INTEGER,
  total_variance NUMERIC(12, 2),
  note TEXT
);

CREATE TABLE IF NOT EXISTS inv_audit_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  audit_id UUID NOT NULL REFERENCES inv_audits(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES pr_products(id),
  system_qty NUMERIC(12, 2) NOT NULL,
  counted_qty NUMERIC(12, 2) NOT NULL,
  variance NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE inv_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_audit_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can view audits"
  ON inv_audits FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage audits"
  ON inv_audits FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'manager', 'store')
    )
  );

CREATE POLICY "Anyone authenticated can view audit items"
  ON inv_audit_items FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage audit items"
  ON inv_audit_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'manager', 'store')
    )
  );

-- ============================================
-- ADJUSTMENT TABLES
-- ============================================
CREATE TABLE IF NOT EXISTS inv_adjustments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  adjust_no TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'pending',
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  note TEXT
);

CREATE TABLE IF NOT EXISTS inv_adjustment_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  adjustment_id UUID NOT NULL REFERENCES inv_adjustments(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES pr_products(id),
  qty_delta NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE inv_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_adjustment_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can view adjustments"
  ON inv_adjustments FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage adjustments"
  ON inv_adjustments FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'manager', 'store')
    )
  );

CREATE POLICY "Anyone authenticated can view adjustment items"
  ON inv_adjustment_items FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage adjustment items"
  ON inv_adjustment_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'manager', 'store')
    )
  );

-- ============================================
-- RETURNS TABLES
-- ============================================
CREATE TABLE IF NOT EXISTS inv_returns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  return_no TEXT UNIQUE NOT NULL,
  ref_bill_no TEXT,
  reason TEXT,
  status TEXT DEFAULT 'pending',
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  received_by UUID,
  received_at TIMESTAMPTZ,
  note TEXT
);

CREATE TABLE IF NOT EXISTS inv_return_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  return_id UUID NOT NULL REFERENCES inv_returns(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES pr_products(id),
  qty NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE inv_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_return_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can view returns"
  ON inv_returns FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage returns"
  ON inv_returns FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'manager', 'store')
    )
  );

CREATE POLICY "Anyone authenticated can view return items"
  ON inv_return_items FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage return items"
  ON inv_return_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'manager', 'store')
    )
  );
