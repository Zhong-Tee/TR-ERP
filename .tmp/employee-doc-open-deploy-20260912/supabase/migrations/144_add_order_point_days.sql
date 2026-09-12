BEGIN;

ALTER TABLE pr_products
  ADD COLUMN IF NOT EXISTS order_point_days INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pr_products_order_point_days_non_negative'
  ) THEN
    ALTER TABLE pr_products
      ADD CONSTRAINT pr_products_order_point_days_non_negative
      CHECK (order_point_days IS NULL OR order_point_days >= 0);
  END IF;
END $$;

COMMIT;
