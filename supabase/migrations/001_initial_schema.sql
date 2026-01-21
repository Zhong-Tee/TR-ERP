-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- USERS TABLE (us_users)
-- ============================================
CREATE TABLE IF NOT EXISTS us_users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE us_users ENABLE ROW LEVEL SECURITY;

-- RLS Policies for us_users
CREATE POLICY "Users can view their own data"
  ON us_users FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Admins can view all users"
  ON us_users FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin')
    )
  );

CREATE POLICY "Admins can update users"
  ON us_users FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin')
    )
  );

-- ============================================
-- PRODUCTS TABLE (pr_products)
-- ============================================
CREATE TABLE IF NOT EXISTS pr_products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_code TEXT UNIQUE NOT NULL,
  product_name TEXT NOT NULL,
  product_category TEXT,
  product_type TEXT,
  rubber_code TEXT,
  storage_location TEXT,
  image_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE pr_products ENABLE ROW LEVEL SECURITY;

-- RLS Policies for pr_products
CREATE POLICY "Anyone authenticated can view active products"
  ON pr_products FOR SELECT
  USING (auth.role() = 'authenticated' AND is_active = true);

CREATE POLICY "Admins can manage products"
  ON pr_products FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff')
    )
  );

-- ============================================
-- CARTOON PATTERNS TABLE (cp_cartoon_patterns)
-- ============================================
CREATE TABLE IF NOT EXISTS cp_cartoon_patterns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pattern_name TEXT NOT NULL,
  pattern_code TEXT UNIQUE NOT NULL,
  image_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE cp_cartoon_patterns ENABLE ROW LEVEL SECURITY;

-- RLS Policies for cp_cartoon_patterns
CREATE POLICY "Anyone authenticated can view active patterns"
  ON cp_cartoon_patterns FOR SELECT
  USING (auth.role() = 'authenticated' AND is_active = true);

CREATE POLICY "Admins can manage patterns"
  ON cp_cartoon_patterns FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff')
    )
  );

-- ============================================
-- ORDERS TABLE (or_orders)
-- ============================================
CREATE TABLE IF NOT EXISTS or_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_code TEXT NOT NULL,
  bill_no TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'รอลงข้อมูล',
  price NUMERIC(10, 2) DEFAULT 0,
  shipping_cost NUMERIC(10, 2) DEFAULT 0,
  discount NUMERIC(10, 2) DEFAULT 0,
  total_amount NUMERIC(10, 2) DEFAULT 0,
  payment_method TEXT,
  promotion TEXT,
  payment_date DATE,
  payment_time TIME,
  customer_name TEXT NOT NULL,
  customer_address TEXT NOT NULL,
  admin_user TEXT NOT NULL,
  entry_date DATE DEFAULT CURRENT_DATE,
  work_order_name TEXT,
  shipped_by TEXT,
  shipped_time TIMESTAMPTZ,
  tracking_number TEXT,
  claim_type TEXT,
  claim_details TEXT,
  billing_details JSONB,
  packing_meta JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE or_orders ENABLE ROW LEVEL SECURITY;

-- RLS Policies for or_orders
CREATE POLICY "Order staff can view and manage orders"
  ON or_orders FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'admin_qc', 'account_staff')
    )
  );

CREATE POLICY "QC staff can view orders"
  ON or_orders FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'qc_staff', 'packing_staff')
    )
  );

-- ============================================
-- ORDER ITEMS TABLE (or_order_items)
-- ============================================
CREATE TABLE IF NOT EXISTS or_order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  item_uid TEXT NOT NULL,
  product_id UUID REFERENCES pr_products(id),
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  ink_color TEXT,
  product_type TEXT,
  cartoon_pattern TEXT,
  line_pattern TEXT,
  font TEXT,
  line_1 TEXT,
  line_2 TEXT,
  line_3 TEXT,
  notes TEXT,
  file_attachment TEXT,
  packing_status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(order_id, item_uid)
);

ALTER TABLE or_order_items ENABLE ROW LEVEL SECURITY;

-- RLS Policies for or_order_items
CREATE POLICY "Order staff can manage order items"
  ON or_order_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'admin_qc', 'account_staff')
    )
  );

CREATE POLICY "QC and packing staff can view order items"
  ON or_order_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'qc_staff', 'packing_staff')
    )
  );

-- ============================================
-- ORDER REVIEWS TABLE (or_order_reviews)
-- ============================================
CREATE TABLE IF NOT EXISTS or_order_reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  reviewed_by UUID NOT NULL REFERENCES us_users(id),
  reviewed_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(order_id)
);

ALTER TABLE or_order_reviews ENABLE ROW LEVEL SECURITY;

-- RLS Policies for or_order_reviews
CREATE POLICY "Admin QC can manage reviews"
  ON or_order_reviews FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'admin_qc')
    )
  );

CREATE POLICY "Anyone authenticated can view reviews"
  ON or_order_reviews FOR SELECT
  USING (auth.role() = 'authenticated');

-- ============================================
-- WORK ORDERS TABLE (or_work_orders)
-- ============================================
CREATE TABLE IF NOT EXISTS or_work_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_order_name TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'กำลังผลิต',
  order_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE or_work_orders ENABLE ROW LEVEL SECURITY;

-- RLS Policies for or_work_orders
CREATE POLICY "Order staff can manage work orders"
  ON or_work_orders FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'packing_staff')
    )
  );

CREATE POLICY "QC staff can view work orders"
  ON or_work_orders FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'qc_staff')
    )
  );

-- ============================================
-- VERIFIED SLIPS TABLE (ac_verified_slips)
-- ============================================
CREATE TABLE IF NOT EXISTS ac_verified_slips (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  slip_image_url TEXT NOT NULL,
  verified_amount NUMERIC(10, 2) NOT NULL,
  verified_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(slip_image_url)
);

ALTER TABLE ac_verified_slips ENABLE ROW LEVEL SECURITY;

-- RLS Policies for ac_verified_slips
CREATE POLICY "Order and account staff can manage verified slips"
  ON ac_verified_slips FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'account_staff')
    )
  );

CREATE POLICY "Anyone authenticated can view verified slips"
  ON ac_verified_slips FOR SELECT
  USING (auth.role() = 'authenticated');

-- ============================================
-- REFUNDS TABLE (ac_refunds)
-- ============================================
CREATE TABLE IF NOT EXISTS ac_refunds (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  amount NUMERIC(10, 2) NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by UUID REFERENCES us_users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ac_refunds ENABLE ROW LEVEL SECURITY;

-- RLS Policies for ac_refunds
CREATE POLICY "Account staff can manage refunds"
  ON ac_refunds FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'account_staff')
    )
  );

CREATE POLICY "Order staff can view refunds"
  ON ac_refunds FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff')
    )
  );

-- ============================================
-- QC SESSIONS TABLE (qc_sessions)
-- ============================================
CREATE TABLE IF NOT EXISTS qc_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username TEXT NOT NULL,
  filename TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  total_items INTEGER DEFAULT 0,
  pass_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  kpi_score NUMERIC(10, 2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE qc_sessions ENABLE ROW LEVEL SECURITY;

-- RLS Policies for qc_sessions
CREATE POLICY "QC staff can manage sessions"
  ON qc_sessions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'qc_staff')
    )
  );

CREATE POLICY "Anyone authenticated can view sessions"
  ON qc_sessions FOR SELECT
  USING (auth.role() = 'authenticated');

-- ============================================
-- QC RECORDS TABLE (qc_records)
-- ============================================
CREATE TABLE IF NOT EXISTS qc_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES qc_sessions(id) ON DELETE CASCADE,
  item_uid TEXT NOT NULL,
  qc_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'pending')),
  fail_reason TEXT,
  is_rejected BOOLEAN DEFAULT false,
  retry_count INTEGER DEFAULT 1,
  product_code TEXT,
  product_name TEXT,
  bill_no TEXT,
  ink_color TEXT,
  font TEXT,
  floor TEXT,
  cartoon_name TEXT,
  line1 TEXT,
  line2 TEXT,
  line3 TEXT,
  qty INTEGER DEFAULT 1,
  remark TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE qc_records ENABLE ROW LEVEL SECURITY;

-- RLS Policies for qc_records
CREATE POLICY "QC staff can manage records"
  ON qc_records FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'qc_staff')
    )
  );

CREATE POLICY "Packing staff can view QC records"
  ON qc_records FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'packing_staff')
    )
  );

-- ============================================
-- PACKING LOGS TABLE (pk_packing_logs)
-- ============================================
CREATE TABLE IF NOT EXISTS pk_packing_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  item_id UUID REFERENCES or_order_items(id),
  packed_by TEXT NOT NULL,
  packed_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT
);

ALTER TABLE pk_packing_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies for pk_packing_logs
CREATE POLICY "Packing staff can manage logs"
  ON pk_packing_logs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'packing_staff')
    )
  );

CREATE POLICY "Anyone authenticated can view packing logs"
  ON pk_packing_logs FOR SELECT
  USING (auth.role() = 'authenticated');

-- ============================================
-- USER MENUS TABLE (st_user_menus)
-- ============================================
CREATE TABLE IF NOT EXISTS st_user_menus (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role TEXT NOT NULL,
  menu_key TEXT NOT NULL,
  menu_name TEXT NOT NULL,
  has_access BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(role, menu_key)
);

ALTER TABLE st_user_menus ENABLE ROW LEVEL SECURITY;

-- RLS Policies for st_user_menus
CREATE POLICY "Anyone authenticated can view menu permissions"
  ON st_user_menus FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage menu permissions"
  ON st_user_menus FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin')
    )
  );

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_orders_status ON or_orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_bill_no ON or_orders(bill_no);
CREATE INDEX IF NOT EXISTS idx_orders_work_order_name ON or_orders(work_order_name);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON or_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_item_uid ON or_order_items(item_uid);
CREATE INDEX IF NOT EXISTS idx_order_reviews_order_id ON or_order_reviews(order_id);
CREATE INDEX IF NOT EXISTS idx_verified_slips_order_id ON ac_verified_slips(order_id);
CREATE INDEX IF NOT EXISTS idx_verified_slips_image_url ON ac_verified_slips(slip_image_url);
CREATE INDEX IF NOT EXISTS idx_qc_records_session_id ON qc_records(session_id);
CREATE INDEX IF NOT EXISTS idx_qc_records_item_uid ON qc_records(item_uid);
CREATE INDEX IF NOT EXISTS idx_packing_logs_order_id ON pk_packing_logs(order_id);

-- ============================================
-- FUNCTIONS
-- ============================================
-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_us_users_updated_at BEFORE UPDATE ON us_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_pr_products_updated_at BEFORE UPDATE ON pr_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_cp_cartoon_patterns_updated_at BEFORE UPDATE ON cp_cartoon_patterns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_or_orders_updated_at BEFORE UPDATE ON or_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_or_order_items_updated_at BEFORE UPDATE ON or_order_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_or_work_orders_updated_at BEFORE UPDATE ON or_work_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ac_refunds_updated_at BEFORE UPDATE ON ac_refunds
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_st_user_menus_updated_at BEFORE UPDATE ON st_user_menus
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
