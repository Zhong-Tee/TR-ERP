-- Add product "Hold" status to suppress reorder alerts.
-- is_hold: true = do not alert "ถึงจุดสั่งซื้อ" (wait to sell out, then hide later)

ALTER TABLE pr_products
  ADD COLUMN IF NOT EXISTS is_hold BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pr_products
  ADD COLUMN IF NOT EXISTS hold_reason TEXT;

ALTER TABLE pr_products
  ADD COLUMN IF NOT EXISTS hold_at TIMESTAMPTZ;

ALTER TABLE pr_products
  ADD COLUMN IF NOT EXISTS hold_by UUID REFERENCES us_users(id);

