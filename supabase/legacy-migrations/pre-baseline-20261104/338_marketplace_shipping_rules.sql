-- Marketplace: map shipping-option values to sales channels and custom urgency labels.
BEGIN;

ALTER TABLE mp_channel_configs
  ADD COLUMN IF NOT EXISTS shipping_rules JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE mp_orders
  ADD COLUMN IF NOT EXISTS shipping_option TEXT,
  ADD COLUMN IF NOT EXISTS urgency_label TEXT;

ALTER TABLE or_orders
  ADD COLUMN IF NOT EXISTS shipping_option TEXT,
  ADD COLUMN IF NOT EXISTS urgency_label TEXT;

COMMENT ON COLUMN mp_channel_configs.shipping_rules IS
  'Ordered rules: source column + value matcher -> channel_code and urgency badge label. First match wins.';

COMMIT;
