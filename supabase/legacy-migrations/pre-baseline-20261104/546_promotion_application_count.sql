-- Allow an order to record how many times each selected promotion is applied.
ALTER TABLE or_order_promotions
  ADD COLUMN IF NOT EXISTS application_count INTEGER NOT NULL DEFAULT 1;

ALTER TABLE or_order_promotions
  DROP CONSTRAINT IF EXISTS or_order_promotions_application_count_check;

ALTER TABLE or_order_promotions
  ADD CONSTRAINT or_order_promotions_application_count_check
  CHECK (application_count > 0);

NOTIFY pgrst, 'reload schema';
