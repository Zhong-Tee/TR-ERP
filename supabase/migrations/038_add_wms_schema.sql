-- ============================================
-- WMS Schema (wms_*)
-- ============================================

-- WMS Orders (งานจัดสินค้า)
CREATE TABLE IF NOT EXISTS wms_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id TEXT NOT NULL,
  product_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  location TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  assigned_to UUID REFERENCES us_users(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending, picked, correct, wrong, not_find, out_of_stock
  error_count INTEGER DEFAULT 0,
  not_find_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  end_time TIMESTAMPTZ
);

ALTER TABLE wms_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "WMS orders read"
  ON wms_orders FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'production', 'manager', 'picker')
    )
  );

CREATE POLICY "WMS orders write"
  ON wms_orders FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'production', 'manager', 'picker')
    )
  );

-- WMS Order Summaries (KPI)
CREATE TABLE IF NOT EXISTS wms_order_summaries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id TEXT NOT NULL,
  picker_id UUID REFERENCES us_users(id),
  total_items INTEGER DEFAULT 0,
  correct_at_first_check INTEGER DEFAULT 0,
  wrong_at_first_check INTEGER DEFAULT 0,
  not_find_at_first_check INTEGER DEFAULT 0,
  accuracy_percent NUMERIC(5, 2) DEFAULT 0,
  checked_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE wms_order_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "WMS order summaries read"
  ON wms_order_summaries FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'manager')
    )
  );

CREATE POLICY "WMS order summaries write"
  ON wms_order_summaries FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'manager')
    )
  );

-- WMS Notifications
CREATE TABLE IF NOT EXISTS wms_notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type TEXT NOT NULL,
  order_id TEXT NOT NULL,
  picker_id UUID REFERENCES us_users(id),
  status TEXT NOT NULL DEFAULT 'unread', -- unread, fixed
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE wms_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "WMS notifications read"
  ON wms_notifications FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'manager', 'picker')
    )
  );

CREATE POLICY "WMS notifications write"
  ON wms_notifications FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'manager', 'picker')
    )
  );

-- WMS Notification Topics
CREATE TABLE IF NOT EXISTS wms_notification_topics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  topic_name TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE wms_notification_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "WMS notification topics read"
  ON wms_notification_topics FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'production', 'manager', 'picker')
    )
  );

CREATE POLICY "WMS notification topics write"
  ON wms_notification_topics FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store')
    )
  );

-- WMS Requisitions
CREATE TABLE IF NOT EXISTS wms_requisitions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requisition_id TEXT UNIQUE NOT NULL,
  created_by UUID NOT NULL REFERENCES us_users(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  approved_by UUID REFERENCES us_users(id),
  approved_at TIMESTAMPTZ,
  notes TEXT,
  requisition_topic TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE wms_requisitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "WMS requisitions read"
  ON wms_requisitions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'production', 'manager')
    )
  );

CREATE POLICY "WMS requisitions write"
  ON wms_requisitions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'production', 'manager')
    )
  );

-- WMS Requisition Items
CREATE TABLE IF NOT EXISTS wms_requisition_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requisition_id TEXT NOT NULL REFERENCES wms_requisitions(requisition_id) ON DELETE CASCADE,
  product_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  location TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE wms_requisition_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "WMS requisition items read"
  ON wms_requisition_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'production', 'manager')
    )
  );

CREATE POLICY "WMS requisition items write"
  ON wms_requisition_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'production', 'manager')
    )
  );

-- WMS Requisition Topics
CREATE TABLE IF NOT EXISTS wms_requisition_topics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  topic_name TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE wms_requisition_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "WMS requisition topics read"
  ON wms_requisition_topics FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'production', 'manager')
    )
  );

CREATE POLICY "WMS requisition topics write"
  ON wms_requisition_topics FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store')
    )
  );

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wms_orders_status ON wms_orders(status);
CREATE INDEX IF NOT EXISTS idx_wms_orders_order_id ON wms_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_wms_orders_assigned_to ON wms_orders(assigned_to);
CREATE INDEX IF NOT EXISTS idx_wms_requisitions_status ON wms_requisitions(status);
CREATE INDEX IF NOT EXISTS idx_wms_requisitions_created_by ON wms_requisitions(created_by);
CREATE INDEX IF NOT EXISTS idx_wms_requisitions_approved_by ON wms_requisitions(approved_by);
CREATE INDEX IF NOT EXISTS idx_wms_requisition_items_requisition_id ON wms_requisition_items(requisition_id);

-- Triggers (updated_at)
DROP TRIGGER IF EXISTS update_wms_requisitions_updated_at ON wms_requisitions;
CREATE TRIGGER update_wms_requisitions_updated_at
  BEFORE UPDATE ON wms_requisitions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
