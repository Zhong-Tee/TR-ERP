-- Product sale price per channel
CREATE TABLE IF NOT EXISTS pr_product_channel_prices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID NOT NULL REFERENCES pr_products(id) ON DELETE CASCADE,
  channel_code TEXT NOT NULL REFERENCES channels(channel_code) ON DELETE CASCADE,
  sale_price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(product_id, channel_code)
);

ALTER TABLE pr_product_channel_prices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can read product channel prices" ON pr_product_channel_prices;
CREATE POLICY "Authenticated can read product channel prices"
  ON pr_product_channel_prices FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Admins can manage product channel prices" ON pr_product_channel_prices;
CREATE POLICY "Admins can manage product channel prices"
  ON pr_product_channel_prices FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'order_staff')
    )
  );

CREATE INDEX IF NOT EXISTS idx_pr_product_channel_prices_product_id
  ON pr_product_channel_prices(product_id);

CREATE INDEX IF NOT EXISTS idx_pr_product_channel_prices_channel_code
  ON pr_product_channel_prices(channel_code);

DROP TRIGGER IF EXISTS update_pr_product_channel_prices_updated_at ON pr_product_channel_prices;
CREATE TRIGGER update_pr_product_channel_prices_updated_at
  BEFORE UPDATE ON pr_product_channel_prices
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
