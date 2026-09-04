-- Keep the Marketplace completed-history pagination fast as the table grows.
CREATE INDEX IF NOT EXISTS idx_mp_orders_status_billed_at
  ON public.mp_orders (status, billed_at DESC);
