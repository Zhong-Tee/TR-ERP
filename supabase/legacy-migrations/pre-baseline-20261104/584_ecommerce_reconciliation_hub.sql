-- E-Commerce reconciliation hub: order delivery, platform settlement and wallet payout.
BEGIN;

ALTER TABLE public.ac_ecommerce_import_batches
  ADD COLUMN IF NOT EXISTS file_kind text NOT NULL DEFAULT 'orders',
  ADD COLUMN IF NOT EXISTS report_from date,
  ADD COLUMN IF NOT EXISTS report_to date,
  ADD COLUMN IF NOT EXISTS import_status text NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ac_ecommerce_import_batches_file_kind_check'
  ) THEN
    ALTER TABLE public.ac_ecommerce_import_batches
      ADD CONSTRAINT ac_ecommerce_import_batches_file_kind_check
      CHECK (file_kind IN ('orders', 'income', 'balance'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ac_ecommerce_import_batches_import_status_check'
  ) THEN
    ALTER TABLE public.ac_ecommerce_import_batches
      ADD CONSTRAINT ac_ecommerce_import_batches_import_status_check
      CHECK (import_status IN ('processing', 'completed', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ac_ecom_batches_kind_period
  ON public.ac_ecommerce_import_batches(channel_id, file_kind, report_from, report_to);

CREATE TABLE IF NOT EXISTS public.ac_ecommerce_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.ac_ecommerce_channels(id) ON DELETE CASCADE,
  source_batch_id uuid REFERENCES public.ac_ecommerce_import_batches(id) ON DELETE SET NULL,
  order_no text NOT NULL,
  platform_status text,
  delivery_status text NOT NULL DEFAULT 'other'
    CHECK (delivery_status IN ('delivered', 'shipping', 'cancelled', 'returned', 'other')),
  refund_status text,
  buyer_username text,
  ordered_at timestamptz,
  paid_at timestamptz,
  shipped_at timestamptz,
  completed_at timestamptz,
  tracking_no text,
  buyer_paid numeric(18,4),
  merchandise_total numeric(18,4) NOT NULL DEFAULT 0,
  order_total numeric(18,4),
  estimated_commission numeric(18,4),
  estimated_transaction_fee numeric(18,4),
  estimated_service_fee numeric(18,4),
  estimated_shipping_cost numeric(18,4),
  province text,
  district text,
  postal_code text,
  raw_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel_id, order_no)
);

CREATE INDEX IF NOT EXISTS idx_ac_ecom_orders_period ON public.ac_ecommerce_orders(channel_id, ordered_at);
CREATE INDEX IF NOT EXISTS idx_ac_ecom_orders_delivery ON public.ac_ecommerce_orders(channel_id, delivery_status);

CREATE TABLE IF NOT EXISTS public.ac_ecommerce_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.ac_ecommerce_orders(id) ON DELETE CASCADE,
  source_line_index int NOT NULL,
  sku_ref text,
  product_name text,
  variation text,
  qty numeric(18,4) NOT NULL DEFAULT 0,
  returned_qty numeric(18,4) NOT NULL DEFAULT 0,
  original_price numeric(18,4),
  sale_price numeric(18,4),
  net_line_amount numeric(18,4),
  raw_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id, source_line_index)
);

CREATE INDEX IF NOT EXISTS idx_ac_ecom_order_lines_order ON public.ac_ecommerce_order_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_ac_ecom_order_lines_sku ON public.ac_ecommerce_order_lines(sku_ref);

CREATE TABLE IF NOT EXISTS public.ac_ecommerce_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.ac_ecommerce_channels(id) ON DELETE CASCADE,
  source_batch_id uuid REFERENCES public.ac_ecommerce_import_batches(id) ON DELETE SET NULL,
  order_no text NOT NULL,
  settled_at timestamptz,
  ordered_at timestamptz,
  buyer_username text,
  gross_sales numeric(18,4) NOT NULL DEFAULT 0,
  seller_discounts numeric(18,4) NOT NULL DEFAULT 0,
  refunds numeric(18,4) NOT NULL DEFAULT 0,
  shipping_net numeric(18,4) NOT NULL DEFAULT 0,
  platform_fee_total numeric(18,4) NOT NULL DEFAULT 0,
  seller_cost_total numeric(18,4) NOT NULL DEFAULT 0,
  fee_category_count int NOT NULL DEFAULT 0,
  payout_amount numeric(18,4) NOT NULL DEFAULT 0,
  fee_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel_id, order_no)
);

CREATE INDEX IF NOT EXISTS idx_ac_ecom_settlements_period ON public.ac_ecommerce_settlements(channel_id, settled_at);

CREATE TABLE IF NOT EXISTS public.ac_ecommerce_wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.ac_ecommerce_channels(id) ON DELETE CASCADE,
  source_batch_id uuid REFERENCES public.ac_ecommerce_import_batches(id) ON DELETE SET NULL,
  source_row_index int NOT NULL,
  source_key text NOT NULL,
  order_no text,
  transaction_at timestamptz,
  transaction_type text,
  description text,
  direction text,
  amount numeric(18,4) NOT NULL DEFAULT 0,
  status text,
  balance_after numeric(18,4),
  raw_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_ac_ecom_wallet_period ON public.ac_ecommerce_wallet_transactions(channel_id, transaction_at);
CREATE INDEX IF NOT EXISTS idx_ac_ecom_wallet_order ON public.ac_ecommerce_wallet_transactions(channel_id, order_no);

ALTER TABLE public.ac_ecommerce_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ac_ecommerce_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ac_ecommerce_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ac_ecommerce_wallet_transactions ENABLE ROW LEVEL SECURITY;

-- Policies are recreated intentionally so this script is safe to rerun from
-- the Supabase SQL editor after a partial/manual deployment.
DROP POLICY IF EXISTS ac_ecommerce_orders_select ON public.ac_ecommerce_orders;
DROP POLICY IF EXISTS ac_ecommerce_orders_write ON public.ac_ecommerce_orders;
DROP POLICY IF EXISTS ac_ecommerce_order_lines_select ON public.ac_ecommerce_order_lines;
DROP POLICY IF EXISTS ac_ecommerce_order_lines_write ON public.ac_ecommerce_order_lines;
DROP POLICY IF EXISTS ac_ecommerce_settlements_select ON public.ac_ecommerce_settlements;
DROP POLICY IF EXISTS ac_ecommerce_settlements_write ON public.ac_ecommerce_settlements;
DROP POLICY IF EXISTS ac_ecommerce_wallet_select ON public.ac_ecommerce_wallet_transactions;
DROP POLICY IF EXISTS ac_ecommerce_wallet_write ON public.ac_ecommerce_wallet_transactions;

CREATE POLICY ac_ecommerce_orders_select ON public.ac_ecommerce_orders FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')));
CREATE POLICY ac_ecommerce_orders_write ON public.ac_ecommerce_orders FOR ALL
  USING (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')));

CREATE POLICY ac_ecommerce_order_lines_select ON public.ac_ecommerce_order_lines FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')));
CREATE POLICY ac_ecommerce_order_lines_write ON public.ac_ecommerce_order_lines FOR ALL
  USING (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')));

CREATE POLICY ac_ecommerce_settlements_select ON public.ac_ecommerce_settlements FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')));
CREATE POLICY ac_ecommerce_settlements_write ON public.ac_ecommerce_settlements FOR ALL
  USING (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')));

CREATE POLICY ac_ecommerce_wallet_select ON public.ac_ecommerce_wallet_transactions FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')));
CREATE POLICY ac_ecommerce_wallet_write ON public.ac_ecommerce_wallet_transactions FOR ALL
  USING (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account', 'sales-tr')));

CREATE OR REPLACE FUNCTION public.trg_ac_ecommerce_reconciliation_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ac_ecommerce_orders_updated_at ON public.ac_ecommerce_orders;
CREATE TRIGGER trg_ac_ecommerce_orders_updated_at
  BEFORE UPDATE ON public.ac_ecommerce_orders
  FOR EACH ROW EXECUTE FUNCTION public.trg_ac_ecommerce_reconciliation_updated_at();

DROP TRIGGER IF EXISTS trg_ac_ecommerce_settlements_updated_at ON public.ac_ecommerce_settlements;
CREATE TRIGGER trg_ac_ecommerce_settlements_updated_at
  BEFORE UPDATE ON public.ac_ecommerce_settlements
  FOR EACH ROW EXECUTE FUNCTION public.trg_ac_ecommerce_reconciliation_updated_at();

CREATE OR REPLACE VIEW public.ac_v_ecommerce_order_reconciliation
WITH (security_invoker = true)
AS
WITH order_keys AS (
  SELECT channel_id, order_no FROM public.ac_ecommerce_orders
  UNION
  SELECT channel_id, order_no FROM public.ac_ecommerce_settlements
  UNION
  SELECT channel_id, order_no FROM public.ac_ecommerce_wallet_transactions WHERE order_no IS NOT NULL
), wallet AS (
  SELECT
    channel_id,
    order_no,
    SUM(amount) AS wallet_amount,
    MAX(transaction_at) AS wallet_received_at,
    COUNT(*) AS wallet_transaction_count
  FROM public.ac_ecommerce_wallet_transactions
  WHERE order_no IS NOT NULL
  GROUP BY channel_id, order_no
), line_totals AS (
  SELECT
    l.order_id,
    COUNT(*) AS line_count,
    SUM(l.qty) AS item_qty,
    SUM(l.returned_qty) AS returned_qty
  FROM public.ac_ecommerce_order_lines l
  GROUP BY l.order_id
)
SELECT
  k.channel_id,
  c.code AS channel_code,
  c.display_name AS channel_name,
  k.order_no,
  o.id AS ecommerce_order_id,
  o.platform_status,
  COALESCE(o.delivery_status, 'other') AS delivery_status,
  o.refund_status,
  o.buyer_username,
  COALESCE(o.ordered_at, s.ordered_at) AS ordered_at,
  o.paid_at,
  o.shipped_at,
  o.completed_at,
  o.tracking_no,
  o.buyer_paid,
  o.merchandise_total,
  o.order_total,
  o.estimated_commission,
  o.estimated_transaction_fee,
  o.estimated_service_fee,
  o.estimated_shipping_cost,
  o.province,
  o.district,
  o.postal_code,
  COALESCE(lt.line_count, 0) AS line_count,
  COALESCE(lt.item_qty, 0) AS item_qty,
  COALESCE(lt.returned_qty, 0) AS returned_qty,
  s.settled_at,
  s.gross_sales,
  s.seller_discounts,
  s.refunds,
  s.shipping_net,
  s.platform_fee_total,
  s.seller_cost_total,
  s.fee_category_count,
  s.payout_amount,
  s.fee_breakdown,
  w.wallet_amount,
  w.wallet_received_at,
  COALESCE(w.wallet_transaction_count, 0) AS wallet_transaction_count,
  erp.id AS erp_order_id,
  erp.bill_no AS erp_bill_no,
  erp.status AS erp_order_status,
  erp.total_amount AS erp_order_total,
  CASE
    WHEN COALESCE(o.delivery_status, 'other') = 'cancelled' THEN 'cancelled'
    WHEN COALESCE(o.delivery_status, 'other') = 'returned' THEN 'returned'
    WHEN s.id IS NOT NULL AND s.payout_amount = 0 AND COALESCE(w.wallet_amount, 0) = 0 THEN 'paid_zero'
    WHEN s.id IS NOT NULL AND w.order_no IS NOT NULL AND ABS(s.payout_amount - w.wallet_amount) <= 0.02 THEN 'paid'
    WHEN s.id IS NOT NULL AND w.order_no IS NOT NULL THEN 'amount_mismatch'
    WHEN s.id IS NOT NULL THEN 'waiting_wallet'
    WHEN COALESCE(o.delivery_status, 'other') = 'delivered' THEN 'waiting_settlement'
    WHEN COALESCE(o.delivery_status, 'other') = 'shipping' THEN 'in_transit'
    ELSE 'needs_review'
  END AS reconciliation_status,
  CASE
    WHEN s.id IS NULL THEN NULL
    ELSE s.payout_amount - COALESCE(w.wallet_amount, 0)
  END AS payout_variance
FROM order_keys k
JOIN public.ac_ecommerce_channels c ON c.id = k.channel_id
LEFT JOIN public.ac_ecommerce_orders o ON o.channel_id = k.channel_id AND o.order_no = k.order_no
LEFT JOIN line_totals lt ON lt.order_id = o.id
LEFT JOIN public.ac_ecommerce_settlements s ON s.channel_id = k.channel_id AND s.order_no = k.order_no
LEFT JOIN wallet w ON w.channel_id = k.channel_id AND w.order_no = k.order_no
LEFT JOIN LATERAL (
  SELECT oo.id, oo.bill_no, oo.status, oo.total_amount
  FROM public.or_orders oo
  WHERE oo.channel_order_no IS NOT NULL
    AND lower(trim(both FROM oo.channel_order_no)) = lower(trim(both FROM k.order_no))
  ORDER BY oo.created_at DESC
  LIMIT 1
) erp ON true;

COMMENT ON VIEW public.ac_v_ecommerce_order_reconciliation IS
  'One row per platform order, joining delivery, settlement, wallet payout and ERP bill.';

GRANT SELECT ON public.ac_v_ecommerce_order_reconciliation TO authenticated;

COMMIT;
