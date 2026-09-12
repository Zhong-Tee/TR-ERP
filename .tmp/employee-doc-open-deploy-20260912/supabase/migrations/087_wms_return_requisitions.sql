-- ============================================
-- WMS Return Requisitions (คืนของ)
-- ============================================
CREATE TABLE IF NOT EXISTS wms_return_requisitions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  return_no TEXT UNIQUE NOT NULL,
  topic TEXT,
  status TEXT DEFAULT 'pending',
  created_by UUID REFERENCES us_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_by UUID REFERENCES us_users(id),
  approved_at TIMESTAMPTZ,
  note TEXT
);

CREATE TABLE IF NOT EXISTS wms_return_requisition_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  return_requisition_id UUID NOT NULL REFERENCES wms_return_requisitions(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES pr_products(id),
  qty NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE wms_return_requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_return_requisition_items ENABLE ROW LEVEL SECURITY;

-- SELECT: all authenticated
CREATE POLICY "Anyone authenticated can view return requisitions"
  ON wms_return_requisitions FOR SELECT
  USING (auth.role() = 'authenticated');

-- INSERT: production_mb and admins
CREATE POLICY "Production and admins can create return requisitions"
  ON wms_return_requisitions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','admin-tr','store','manager','production','production_mb')
    )
  );

-- UPDATE/DELETE: store/manager/admin/superadmin
CREATE POLICY "Admins can manage return requisitions"
  ON wms_return_requisitions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','admin-tr','store','manager')
    )
  );

CREATE POLICY "Admins can delete return requisitions"
  ON wms_return_requisitions FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','admin-tr','store','manager')
    )
  );

-- Items: SELECT all, INSERT production_mb+admins, UPDATE/DELETE admins
CREATE POLICY "Anyone authenticated can view return requisition items"
  ON wms_return_requisition_items FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Production and admins can create return requisition items"
  ON wms_return_requisition_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','admin-tr','store','manager','production','production_mb')
    )
  );

CREATE POLICY "Admins can manage return requisition items"
  ON wms_return_requisition_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','admin-tr','store','manager')
    )
  );

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE wms_return_requisitions;
