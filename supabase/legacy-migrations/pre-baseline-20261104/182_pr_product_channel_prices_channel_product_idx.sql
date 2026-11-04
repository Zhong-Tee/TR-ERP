-- Improve lookup performance for order form auto pricing by channel.
-- Query pattern: WHERE channel_code = ? then map by product_id.
CREATE INDEX IF NOT EXISTS idx_pr_product_channel_prices_channel_product
  ON pr_product_channel_prices(channel_code, product_id);
