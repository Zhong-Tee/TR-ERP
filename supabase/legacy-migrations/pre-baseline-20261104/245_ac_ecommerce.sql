-- Ecommerce sale file imports (Account menu) + flexible column maps per channel
BEGIN;

CREATE TABLE IF NOT EXISTS ac_ecommerce_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  default_sheet_name TEXT,
  header_rows_to_skip INT NOT NULL DEFAULT 1 CHECK (header_rows_to_skip >= 0 AND header_rows_to_skip <= 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ac_ecommerce_channel_maps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES ac_ecommerce_channels(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL CHECK (field_key IN (
    'order_no', 'payment_at', 'sku_ref', 'price_orig', 'price_sell', 'qty', 'line_total',
    'commission', 'transaction_fee', 'platform_fees_plus1', 'buyer_note', 'province', 'district', 'postal_code'
  )),
  source_type TEXT NOT NULL CHECK (source_type IN ('excel_column_letter', 'header_exact', 'header_contains')),
  source_value TEXT NOT NULL,
  priority INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, field_key, source_type, source_value)
);

CREATE INDEX IF NOT EXISTS idx_ac_ecom_maps_channel ON ac_ecommerce_channel_maps(channel_id);

CREATE TABLE IF NOT EXISTS ac_ecommerce_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES ac_ecommerce_channels(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  row_count INT NOT NULL DEFAULT 0,
  uploaded_by UUID REFERENCES us_users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ac_ecom_batches_channel ON ac_ecommerce_import_batches(channel_id);
CREATE INDEX IF NOT EXISTS idx_ac_ecom_batches_uploaded ON ac_ecommerce_import_batches(uploaded_at DESC);

CREATE TABLE IF NOT EXISTS ac_ecommerce_sale_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES ac_ecommerce_import_batches(id) ON DELETE CASCADE,
  row_index INT NOT NULL,
  order_no TEXT,
  payment_at TIMESTAMPTZ,
  sku_ref TEXT,
  price_orig NUMERIC(18,4),
  price_sell NUMERIC(18,4),
  qty NUMERIC(18,4),
  line_total NUMERIC(18,4),
  commission NUMERIC(18,4),
  transaction_fee NUMERIC(18,4),
  platform_fees_plus1 NUMERIC(18,4),
  buyer_note TEXT,
  province TEXT,
  district TEXT,
  postal_code TEXT,
  raw_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_ac_ecom_lines_batch ON ac_ecommerce_sale_lines(batch_id);
CREATE INDEX IF NOT EXISTS idx_ac_ecom_lines_payment_at ON ac_ecommerce_sale_lines(payment_at);
CREATE INDEX IF NOT EXISTS idx_ac_ecom_lines_order_no ON ac_ecommerce_sale_lines(order_no);
CREATE INDEX IF NOT EXISTS idx_ac_ecom_lines_sku_ref ON ac_ecommerce_sale_lines(sku_ref);

CREATE OR REPLACE FUNCTION trg_ac_ecommerce_channels_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ac_ecommerce_channels_updated_at ON ac_ecommerce_channels;
CREATE TRIGGER trg_ac_ecommerce_channels_updated_at
  BEFORE UPDATE ON ac_ecommerce_channels
  FOR EACH ROW EXECUTE FUNCTION trg_ac_ecommerce_channels_updated_at();

ALTER TABLE ac_ecommerce_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE ac_ecommerce_channel_maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE ac_ecommerce_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ac_ecommerce_sale_lines ENABLE ROW LEVEL SECURITY;

-- Same pattern as ac_manual_slip_checks; include sales-tr for users granted account submenu
CREATE POLICY ac_ecommerce_channels_select ON ac_ecommerce_channels FOR SELECT
  USING (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')));

CREATE POLICY ac_ecommerce_channels_write ON ac_ecommerce_channels FOR ALL
  USING (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account')));

CREATE POLICY ac_ecommerce_channel_maps_select ON ac_ecommerce_channel_maps FOR SELECT
  USING (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')));

CREATE POLICY ac_ecommerce_channel_maps_write ON ac_ecommerce_channel_maps FOR ALL
  USING (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account')));

CREATE POLICY ac_ecommerce_batches_select ON ac_ecommerce_import_batches FOR SELECT
  USING (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')));

CREATE POLICY ac_ecommerce_batches_write ON ac_ecommerce_import_batches FOR ALL
  USING (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')));

CREATE POLICY ac_ecommerce_sale_lines_select ON ac_ecommerce_sale_lines FOR SELECT
  USING (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')));

CREATE POLICY ac_ecommerce_sale_lines_write ON ac_ecommerce_sale_lines FOR ALL
  USING (EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')));

-- Listing + product name + reconciliation (single query from UI; no N+1)
CREATE OR REPLACE VIEW ac_v_ecommerce_sale_lines_enriched AS
SELECT
  sl.id,
  sl.batch_id,
  sl.row_index,
  sl.order_no,
  sl.payment_at,
  sl.sku_ref,
  sl.price_orig,
  sl.price_sell,
  sl.qty,
  sl.line_total,
  sl.commission,
  sl.transaction_fee,
  sl.platform_fees_plus1,
  sl.buyer_note,
  sl.province,
  sl.district,
  sl.postal_code,
  sl.created_at,
  b.channel_id,
  b.file_name,
  b.uploaded_at,
  c.code AS channel_code,
  c.display_name AS channel_name,
  p.product_name AS product_name_from_sku,
  o.id AS erp_order_id,
  o.bill_no AS erp_bill_no,
  o.status AS erp_order_status,
  o.total_amount AS erp_order_total,
  COALESCE(oi_match.erp_line_amount, 0::numeric) AS erp_line_amount_for_sku,
  (o.id IS NOT NULL) AS erp_order_found,
  (oi_match.erp_line_amount IS NOT NULL) AS erp_sku_line_found,
  CASE
    WHEN sl.line_total IS NULL OR oi_match.erp_line_amount IS NULL THEN NULL
    WHEN ABS(COALESCE(sl.line_total, 0) - COALESCE(oi_match.erp_line_amount, 0)) <= 0.02 THEN true
    ELSE false
  END AS erp_amount_matches_line
FROM ac_ecommerce_sale_lines sl
JOIN ac_ecommerce_import_batches b ON b.id = sl.batch_id
JOIN ac_ecommerce_channels c ON c.id = b.channel_id
LEFT JOIN pr_products p ON lower(trim(both FROM p.product_code)) = lower(nullif(trim(both FROM sl.sku_ref), ''))
LEFT JOIN or_orders o ON o.channel_order_no IS NOT NULL
  AND sl.order_no IS NOT NULL
  AND lower(trim(both FROM o.channel_order_no)) = lower(trim(both FROM sl.order_no))
LEFT JOIN LATERAL (
  SELECT SUM(COALESCE(oi.quantity, 0) * COALESCE(oi.unit_price, 0)) AS erp_line_amount
  FROM or_order_items oi
  JOIN pr_products pr ON pr.id = oi.product_id
  WHERE oi.order_id = o.id
    AND sl.sku_ref IS NOT NULL
    AND lower(trim(both FROM pr.product_code)) = lower(trim(both FROM sl.sku_ref))
) oi_match ON true;

COMMENT ON VIEW ac_v_ecommerce_sale_lines_enriched IS 'Ecommerce import lines with ERP reconcile hints; filter payment_at / channel_id in query.';

-- Seed Shopee + column maps (A,H,T,V,W,X,Z,AM,AN,AS,AY,BB,BC,BD)
INSERT INTO ac_ecommerce_channels (code, display_name, is_active, default_sheet_name, header_rows_to_skip)
VALUES ('shopee', 'Shopee', true, 'orders', 1)
ON CONFLICT (code) DO NOTHING;

WITH ch AS (
  SELECT id FROM ac_ecommerce_channels WHERE code = 'shopee' LIMIT 1
)
INSERT INTO ac_ecommerce_channel_maps (channel_id, field_key, source_type, source_value, priority)
SELECT ch.id, v.field_key, 'excel_column_letter'::text, v.letter, 0
FROM ch
CROSS JOIN (VALUES
  ('order_no', 'A'),
  ('payment_at', 'H'),
  ('sku_ref', 'T'),
  ('price_orig', 'V'),
  ('price_sell', 'W'),
  ('qty', 'X'),
  ('line_total', 'Z'),
  ('commission', 'AM'),
  ('transaction_fee', 'AN'),
  ('platform_fees_plus1', 'AS'),
  ('buyer_note', 'AY'),
  ('province', 'BB'),
  ('district', 'BC'),
  ('postal_code', 'BD')
) AS v(field_key, letter)
ON CONFLICT (channel_id, field_key, source_type, source_value) DO NOTHING;

-- Menu access defaults (superadmin bypasses in app; rows optional for consistency)
INSERT INTO st_user_menus (role, menu_key, menu_name, has_access) VALUES
  ('admin', 'account-ecommerce', 'บัญชี · Ecommerce', true),
  ('account', 'account-ecommerce', 'บัญชี · Ecommerce', true),
  ('sales-tr', 'account-ecommerce', 'บัญชี · Ecommerce', false)
ON CONFLICT (role, menu_key) DO NOTHING;

COMMIT;
