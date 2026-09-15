-- Speed up Marketplace dashboard range filters. The dashboard primarily uses
-- order_date and falls back to created_at only for legacy rows without it.
CREATE INDEX IF NOT EXISTS idx_mp_orders_order_date
  ON public.mp_orders (order_date)
  WHERE order_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mp_orders_created_at_without_order_date
  ON public.mp_orders (created_at)
  WHERE order_date IS NULL;
