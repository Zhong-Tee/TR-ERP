-- Marketplace menu: import Shopee/TikTok order files, assign to sales, fill-in, open bills
-- Tables: mp_channel_configs, mp_import_batches, mp_orders, mp_order_items
-- Also adds ship_due_at / overdue_at to or_orders for urgency badges (ส่งด่วน/ล่าช้า)
BEGIN;

-- =========================================================================
-- 1) mp_channel_configs — import channel settings (column map + due rule)
-- =========================================================================
CREATE TABLE IF NOT EXISTS mp_channel_configs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  channel_code  TEXT NOT NULL REFERENCES channels(channel_code),
  sheet_name    TEXT DEFAULT 'orders',
  header_row    INT NOT NULL DEFAULT 0 CHECK (header_row >= 0 AND header_row <= 10),
  -- MpMapRow[]: { field_key, source_type: 'header_exact'|'header_contains'|'excel_column_letter', source_value, priority }
  column_map    JSONB NOT NULL DEFAULT '[]',
  -- { cutoff_time: 'HH:mm', due_time: 'HH:mm', due_day_offset_after_cutoff: int, overdue_after_hours: int }
  due_rule      JSONB NOT NULL DEFAULT '{"cutoff_time":"12:00","due_time":"23:59","due_day_offset_after_cutoff":1,"overdue_after_hours":24}',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION trg_mp_channel_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mp_channel_configs_updated_at ON mp_channel_configs;
CREATE TRIGGER trg_mp_channel_configs_updated_at
  BEFORE UPDATE ON mp_channel_configs
  FOR EACH ROW EXECUTE FUNCTION trg_mp_channel_configs_updated_at();

-- =========================================================================
-- 2) mp_import_batches — upload history
-- =========================================================================
CREATE TABLE IF NOT EXISTS mp_import_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id       UUID NOT NULL REFERENCES mp_channel_configs(id) ON DELETE RESTRICT,
  file_name       TEXT NOT NULL,
  row_count       INT NOT NULL DEFAULT 0,
  order_count     INT NOT NULL DEFAULT 0,
  duplicate_count INT NOT NULL DEFAULT 0,
  uploaded_by     UUID REFERENCES us_users(id) ON DELETE SET NULL,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mp_batches_config ON mp_import_batches(config_id);
CREATE INDEX IF NOT EXISTS idx_mp_batches_uploaded ON mp_import_batches(uploaded_at DESC);

-- =========================================================================
-- 3) mp_orders — one work item per marketplace order number
-- =========================================================================
CREATE TABLE IF NOT EXISTS mp_orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id             UUID NOT NULL REFERENCES mp_import_batches(id) ON DELETE CASCADE,
  config_id            UUID NOT NULL REFERENCES mp_channel_configs(id) ON DELETE RESTRICT,
  channel_code         TEXT NOT NULL,
  marketplace_order_no TEXT NOT NULL,
  -- order-level data from file
  platform_status      TEXT,
  buyer_username       TEXT,
  order_date           TIMESTAMPTZ,
  payment_time         TIMESTAMPTZ,
  recipient_name       TEXT,
  phone                TEXT,
  address              TEXT,
  province             TEXT,
  district             TEXT,
  postal_code          TEXT,
  buyer_note           TEXT,
  tracking_no          TEXT,
  shipping_fee         NUMERIC(18,2),
  order_total          NUMERIC(18,2),
  raw_snapshot         JSONB,
  -- urgency (computed at import from due_rule; frozen)
  ship_due_at          TIMESTAMPTZ,
  overdue_at           TIMESTAMPTZ,
  -- workflow
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','assigned','follow_up','done')),
  assigned_to     UUID REFERENCES us_users(id) ON DELETE SET NULL,
  assigned_at     TIMESTAMPTZ,
  assigned_by     UUID REFERENCES us_users(id) ON DELETE SET NULL,
  follow_up_note  TEXT,
  follow_up_at    TIMESTAMPTZ,
  billed_order_id UUID REFERENCES or_orders(id) ON DELETE SET NULL,
  billed_bill_no  TEXT,
  billed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_code, marketplace_order_no)
);

CREATE INDEX IF NOT EXISTS idx_mp_orders_status      ON mp_orders(status);
CREATE INDEX IF NOT EXISTS idx_mp_orders_assigned_to ON mp_orders(assigned_to);
CREATE INDEX IF NOT EXISTS idx_mp_orders_order_no    ON mp_orders(marketplace_order_no);
CREATE INDEX IF NOT EXISTS idx_mp_orders_batch       ON mp_orders(batch_id);

-- =========================================================================
-- 4) mp_order_items — one row per file line; also stores sales draft fields
-- =========================================================================
CREATE TABLE IF NOT EXISTS mp_order_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mp_order_id      UUID NOT NULL REFERENCES mp_orders(id) ON DELETE CASCADE,
  line_index       INT NOT NULL,
  -- raw from file
  product_name_raw TEXT,
  sku_ref          TEXT,
  variation        TEXT,
  qty              NUMERIC(18,2),
  unit_price       NUMERIC(18,2),
  line_total       NUMERIC(18,2),
  raw_snapshot     JSONB,
  -- sales fill-in draft (mirrors or_order_items)
  product_id       UUID REFERENCES pr_products(id) ON DELETE SET NULL,
  product_type     TEXT,
  ink_color        TEXT,
  cartoon_pattern  TEXT,
  line_pattern     TEXT,
  font             TEXT,
  line_1           TEXT,
  line_2           TEXT,
  line_3           TEXT,
  no_name_line     BOOLEAN NOT NULL DEFAULT false,
  is_free          BOOLEAN NOT NULL DEFAULT false,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mp_order_id, line_index)
);

CREATE INDEX IF NOT EXISTS idx_mp_items_order ON mp_order_items(mp_order_id);

-- =========================================================================
-- 5) or_orders urgency columns (NULL = no badge; frozen values copied from mp_orders)
-- =========================================================================
ALTER TABLE or_orders
  ADD COLUMN IF NOT EXISTS ship_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS overdue_at  TIMESTAMPTZ;

-- =========================================================================
-- 6) RLS
--    admin/superadmin: full access. sales (role LIKE 'sales-%'): only own assigned work.
-- =========================================================================
ALTER TABLE mp_channel_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mp_import_batches  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mp_orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE mp_order_items     ENABLE ROW LEVEL SECURITY;

-- configs: sales may read (need config names/rules for display), only admin writes
CREATE POLICY mp_configs_select ON mp_channel_configs FOR SELECT
  USING (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid()
                 AND (u.role IN ('superadmin', 'admin') OR u.role LIKE 'sales-%')));

CREATE POLICY mp_configs_write ON mp_channel_configs FOR ALL
  USING (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin')));

-- batches: admin only (upload is an admin action)
CREATE POLICY mp_batches_all ON mp_import_batches FOR ALL
  USING (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin')));

-- mp_orders
CREATE POLICY mp_orders_select ON mp_orders FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin'))
    OR (
      assigned_to = auth.uid()
      AND EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role LIKE 'sales-%')
    )
  );

CREATE POLICY mp_orders_insert ON mp_orders FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin')));

CREATE POLICY mp_orders_update ON mp_orders FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin'))
    OR (
      assigned_to = auth.uid()
      AND EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role LIKE 'sales-%')
    )
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin'))
    OR (
      -- sales cannot reassign work away from themselves
      assigned_to = auth.uid()
      AND EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role LIKE 'sales-%')
    )
  );

CREATE POLICY mp_orders_delete ON mp_orders FOR DELETE
  USING (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin')));

-- mp_order_items: access follows the parent mp_orders row
CREATE POLICY mp_items_select ON mp_order_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM mp_orders o WHERE o.id = mp_order_id AND (
      EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin'))
      OR (o.assigned_to = auth.uid()
          AND EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role LIKE 'sales-%'))
    )
  ));

CREATE POLICY mp_items_insert ON mp_order_items FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin')));

CREATE POLICY mp_items_update ON mp_order_items FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM mp_orders o WHERE o.id = mp_order_id AND (
      EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin'))
      OR (o.assigned_to = auth.uid()
          AND EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role LIKE 'sales-%'))
    )
  ));

CREATE POLICY mp_items_delete ON mp_order_items FOR DELETE
  USING (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin')));

-- =========================================================================
-- 7) Realtime
-- =========================================================================
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE mp_orders;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

-- =========================================================================
-- 8) Menu access seeds (required: MenuAccessContext returns false when no row)
--    superadmin bypasses in app; sales see only assign/follow-up/done tabs.
-- =========================================================================
INSERT INTO st_user_menus (role, menu_key, menu_name, has_access) VALUES
  ('admin',      'marketplace',            'Marketplace',              true),
  ('admin',      'marketplace-new',        'Marketplace · งานใหม่',    true),
  ('admin',      'marketplace-assign',     'Marketplace · Assign',     true),
  ('admin',      'marketplace-follow-up',  'Marketplace · รอติดตาม',   true),
  ('admin',      'marketplace-done',       'Marketplace · เสร็จสิ้น',  true),
  ('admin',      'marketplace-settings',   'Marketplace · ตั้งค่า',    true),
  ('sales-tr',   'marketplace',            'Marketplace',              true),
  ('sales-tr',   'marketplace-new',        'Marketplace · งานใหม่',    false),
  ('sales-tr',   'marketplace-assign',     'Marketplace · Assign',     true),
  ('sales-tr',   'marketplace-follow-up',  'Marketplace · รอติดตาม',   true),
  ('sales-tr',   'marketplace-done',       'Marketplace · เสร็จสิ้น',  true),
  ('sales-tr',   'marketplace-settings',   'Marketplace · ตั้งค่า',    false),
  ('sales-pump', 'marketplace',            'Marketplace',              true),
  ('sales-pump', 'marketplace-new',        'Marketplace · งานใหม่',    false),
  ('sales-pump', 'marketplace-assign',     'Marketplace · Assign',     true),
  ('sales-pump', 'marketplace-follow-up',  'Marketplace · รอติดตาม',   true),
  ('sales-pump', 'marketplace-done',       'Marketplace · เสร็จสิ้น',  true),
  ('sales-pump', 'marketplace-settings',   'Marketplace · ตั้งค่า',    false)
ON CONFLICT (role, menu_key) DO NOTHING;

-- =========================================================================
-- 9) Seed default Shopee config (header-text mapping matching Shopee TH export)
-- =========================================================================
INSERT INTO mp_channel_configs (name, channel_code, sheet_name, header_row, column_map)
VALUES (
  'Shopee',
  'SPTR',
  'orders',
  0,
  '[
    {"field_key":"order_no","source_type":"header_exact","source_value":"หมายเลขคำสั่งซื้อ","priority":0},
    {"field_key":"platform_status","source_type":"header_exact","source_value":"สถานะการสั่งซื้อ","priority":0},
    {"field_key":"buyer_username","source_type":"header_exact","source_value":"ชื่อผู้ใช้ (ผู้ซื้อ)","priority":0},
    {"field_key":"order_date","source_type":"header_exact","source_value":"วันที่ทำการสั่งซื้อ","priority":0},
    {"field_key":"payment_time","source_type":"header_exact","source_value":"เวลาการชำระสินค้า","priority":0},
    {"field_key":"product_name","source_type":"header_exact","source_value":"ชื่อสินค้า","priority":0},
    {"field_key":"sku_ref","source_type":"header_contains","source_value":"เลขอ้างอิง SKU","priority":0},
    {"field_key":"variation","source_type":"header_exact","source_value":"ชื่อตัวเลือก","priority":0},
    {"field_key":"unit_price","source_type":"header_exact","source_value":"ราคาขาย","priority":0},
    {"field_key":"qty","source_type":"header_exact","source_value":"จำนวน","priority":0},
    {"field_key":"line_total","source_type":"header_exact","source_value":"ราคาขายสุทธิ","priority":0},
    {"field_key":"order_total","source_type":"header_exact","source_value":"จำนวนเงินทั้งหมด","priority":0},
    {"field_key":"shipping_fee","source_type":"header_contains","source_value":"ค่าจัดส่งที่ชำระโดยผู้ซื้อ","priority":0},
    {"field_key":"recipient_name","source_type":"header_exact","source_value":"ชื่อผู้รับ","priority":0},
    {"field_key":"phone","source_type":"header_exact","source_value":"หมายเลขโทรศัพท์","priority":0},
    {"field_key":"buyer_note","source_type":"header_exact","source_value":"หมายเหตุจากผู้ซื้อ","priority":0},
    {"field_key":"address","source_type":"header_contains","source_value":"ที่อยู่ในการจัดส่ง","priority":0},
    {"field_key":"province","source_type":"header_exact","source_value":"จังหวัด","priority":0},
    {"field_key":"district","source_type":"header_exact","source_value":"เขต/อำเภอ","priority":0},
    {"field_key":"postal_code","source_type":"header_contains","source_value":"รหัสไปรษณีย์","priority":0},
    {"field_key":"tracking_no","source_type":"header_contains","source_value":"หมายเลขติดตามพัสดุ","priority":0}
  ]'::jsonb
)
ON CONFLICT (name) DO NOTHING;

COMMIT;
