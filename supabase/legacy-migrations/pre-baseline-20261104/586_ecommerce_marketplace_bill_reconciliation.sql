BEGIN;

-- Bridge each Marketplace import configuration to its accounting channel.
ALTER TABLE public.mp_channel_configs
  ADD COLUMN IF NOT EXISTS ecommerce_channel_id uuid
  REFERENCES public.ac_ecommerce_channels(id) ON DELETE SET NULL;

UPDATE public.mp_channel_configs mp
SET ecommerce_channel_id = channel.id
FROM public.ac_ecommerce_channels channel
WHERE mp.ecommerce_channel_id IS NULL
  AND (
    lower(btrim(mp.name)) = lower(btrim(channel.display_name))
    OR lower(btrim(mp.name)) = lower(btrim(channel.code))
    OR (upper(btrim(mp.channel_code)) = 'SPTR' AND lower(btrim(channel.code)) = 'shopee')
  );

CREATE INDEX IF NOT EXISTS idx_mp_channel_configs_ecommerce_channel
  ON public.mp_channel_configs(ecommerce_channel_id);
CREATE INDEX IF NOT EXISTS idx_mp_orders_config_order_no_normalized
  ON public.mp_orders(config_id, (lower(btrim(marketplace_order_no))));

-- The accounting population starts from every bill opened through Marketplace.
-- Shopee Order, Income and Balance are optional matches, so an unmatched bill
-- remains visible instead of disappearing from the report.
CREATE OR REPLACE VIEW public.ac_v_ecommerce_marketplace_bill_reconciliation
WITH (security_invoker = true)
AS
WITH wallet AS (
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
    order_id,
    COUNT(*) AS line_count,
    SUM(qty) AS item_qty,
    SUM(returned_qty) AS returned_qty
  FROM public.ac_ecommerce_order_lines
  GROUP BY order_id
)
SELECT
  channel.id AS channel_id,
  channel.code AS channel_code,
  channel.display_name AS channel_name,
  mp.marketplace_order_no AS order_no,
  mp.id AS marketplace_work_id,
  mp.status AS marketplace_status,
  mp.order_total AS marketplace_order_total,
  mp.billed_at AS marketplace_billed_at,
  o.id AS ecommerce_order_id,
  o.platform_status,
  CASE WHEN o.id IS NULL THEN 'not_found' ELSE COALESCE(o.delivery_status, 'other') END AS delivery_status,
  o.refund_status,
  o.buyer_username,
  COALESCE(o.ordered_at, mp.order_date) AS ordered_at,
  o.paid_at,
  o.shipped_at,
  o.completed_at,
  COALESCE(o.tracking_no, mp.tracking_no) AS tracking_no,
  o.buyer_paid,
  o.merchandise_total,
  COALESCE(o.order_total, mp.order_total, erp.total_amount) AS order_total,
  o.province,
  COALESCE(lines.line_count, 0) AS line_count,
  COALESCE(lines.item_qty, 0) AS item_qty,
  COALESCE(lines.returned_qty, 0) AS returned_qty,
  s.settled_at,
  s.gross_sales,
  s.platform_fee_total,
  s.seller_cost_total,
  s.fee_category_count,
  s.payout_amount,
  s.fee_breakdown,
  wallet.wallet_amount,
  wallet.wallet_received_at,
  erp.id AS erp_order_id,
  COALESCE(erp.bill_no, mp.billed_bill_no) AS erp_bill_no,
  erp.total_amount AS erp_order_total,
  (o.id IS NOT NULL) AS order_matched,
  (s.id IS NOT NULL) AS income_matched,
  (wallet.order_no IS NOT NULL) AS balance_matched,
  CASE
    WHEN COALESCE(o.delivery_status, 'other') = 'cancelled' THEN 'cancelled'
    WHEN COALESCE(o.delivery_status, 'other') = 'returned' THEN 'returned'
    WHEN s.id IS NOT NULL AND s.payout_amount = 0 AND COALESCE(wallet.wallet_amount, 0) = 0 THEN 'paid_zero'
    WHEN s.id IS NOT NULL AND wallet.order_no IS NOT NULL AND ABS(s.payout_amount - wallet.wallet_amount) <= 0.02 THEN 'paid'
    WHEN s.id IS NOT NULL AND wallet.order_no IS NOT NULL THEN 'amount_mismatch'
    WHEN s.id IS NOT NULL THEN 'waiting_wallet'
    WHEN o.id IS NULL THEN 'not_found_order'
    WHEN COALESCE(o.delivery_status, 'other') = 'delivered' THEN 'waiting_settlement'
    WHEN COALESCE(o.delivery_status, 'other') = 'shipping' THEN 'in_transit'
    ELSE 'waiting_delivery'
  END AS reconciliation_status,
  CASE WHEN s.id IS NULL THEN NULL ELSE s.payout_amount - COALESCE(wallet.wallet_amount, 0) END AS payout_variance
FROM public.mp_orders mp
JOIN public.mp_channel_configs config ON config.id = mp.config_id
JOIN public.ac_ecommerce_channels channel ON channel.id = config.ecommerce_channel_id
LEFT JOIN public.ac_ecommerce_orders o
  ON o.channel_id = channel.id
 AND lower(btrim(o.order_no)) = lower(btrim(mp.marketplace_order_no))
LEFT JOIN line_totals lines ON lines.order_id = o.id
LEFT JOIN public.ac_ecommerce_settlements s
  ON s.channel_id = channel.id
 AND lower(btrim(s.order_no)) = lower(btrim(mp.marketplace_order_no))
LEFT JOIN wallet
  ON wallet.channel_id = channel.id
 AND lower(btrim(wallet.order_no)) = lower(btrim(mp.marketplace_order_no))
LEFT JOIN LATERAL (
  SELECT orders.id, orders.bill_no, orders.total_amount
  FROM public.or_orders orders
  WHERE orders.id = mp.billed_order_id
     OR (mp.billed_order_id IS NULL AND orders.bill_no = mp.billed_bill_no)
  ORDER BY (orders.id = mp.billed_order_id) DESC, orders.created_at DESC
  LIMIT 1
) erp ON true
WHERE mp.billed_order_id IS NOT NULL OR mp.billed_bill_no IS NOT NULL;

COMMENT ON VIEW public.ac_v_ecommerce_marketplace_bill_reconciliation IS
  'Every ERP bill opened from Marketplace, with optional Shopee Order, Income and Balance matches.';

CREATE OR REPLACE FUNCTION public.ac_ecommerce_marketplace_bill_summary(
  p_channel_id uuid,
  p_date_basis text,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_search text DEFAULT NULL,
  p_status_filter text DEFAULT 'all'
)
RETURNS TABLE (
  order_count bigint,
  order_match_count bigint,
  income_match_count bigint,
  balance_match_count bigint,
  delivered_count bigint,
  cancelled_count bigint,
  shipping_count bigint,
  paid_count bigint,
  paid_zero_count bigint,
  waiting_settlement_count bigint,
  waiting_wallet_count bigint,
  mismatch_count bigint,
  missing_order_count bigint,
  issue_count bigint,
  sales_total numeric,
  fee_total numeric,
  payout_total numeric,
  wallet_total numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filtered AS (
    SELECT r.*
    FROM public.ac_v_ecommerce_marketplace_bill_reconciliation r
    WHERE auth.uid() IS NOT NULL
      AND r.channel_id = p_channel_id
      AND CASE p_date_basis
        WHEN 'completed_at' THEN COALESCE(r.completed_at, r.marketplace_billed_at, r.ordered_at)
        WHEN 'settled_at' THEN COALESCE(r.settled_at, r.marketplace_billed_at, r.ordered_at)
        WHEN 'wallet_received_at' THEN COALESCE(r.wallet_received_at, r.marketplace_billed_at, r.ordered_at)
        WHEN 'billed_at' THEN COALESCE(r.marketplace_billed_at, r.ordered_at)
        ELSE COALESCE(r.ordered_at, r.marketplace_billed_at)
      END BETWEEN p_date_from AND p_date_to
      AND (
        nullif(btrim(p_search), '') IS NULL
        OR r.order_no ILIKE '%' || btrim(p_search) || '%'
        OR r.erp_bill_no ILIKE '%' || btrim(p_search) || '%'
      )
      AND (
        p_status_filter = 'all'
        OR (p_status_filter = 'issues' AND r.reconciliation_status IN ('not_found_order', 'waiting_delivery', 'waiting_wallet', 'waiting_settlement', 'amount_mismatch'))
        OR (p_status_filter = 'paid' AND r.reconciliation_status IN ('paid', 'paid_zero'))
        OR (p_status_filter NOT IN ('all', 'issues', 'paid') AND r.reconciliation_status = p_status_filter)
      )
  )
  SELECT
    count(*) AS order_count,
    count(*) FILTER (WHERE order_matched) AS order_match_count,
    count(*) FILTER (WHERE income_matched) AS income_match_count,
    count(*) FILTER (WHERE balance_matched) AS balance_match_count,
    count(*) FILTER (WHERE delivery_status = 'delivered') AS delivered_count,
    count(*) FILTER (WHERE delivery_status = 'cancelled') AS cancelled_count,
    count(*) FILTER (WHERE delivery_status = 'shipping') AS shipping_count,
    count(*) FILTER (WHERE reconciliation_status = 'paid') AS paid_count,
    count(*) FILTER (WHERE reconciliation_status = 'paid_zero') AS paid_zero_count,
    count(*) FILTER (WHERE reconciliation_status = 'waiting_settlement') AS waiting_settlement_count,
    count(*) FILTER (WHERE reconciliation_status = 'waiting_wallet') AS waiting_wallet_count,
    count(*) FILTER (WHERE reconciliation_status = 'amount_mismatch') AS mismatch_count,
    count(*) FILTER (WHERE NOT order_matched) AS missing_order_count,
    count(*) FILTER (WHERE reconciliation_status IN ('not_found_order', 'waiting_delivery', 'waiting_wallet', 'waiting_settlement', 'amount_mismatch')) AS issue_count,
    COALESCE(sum(COALESCE(gross_sales, marketplace_order_total, erp_order_total)), 0) AS sales_total,
    COALESCE(sum(platform_fee_total), 0) AS fee_total,
    COALESCE(sum(payout_amount), 0) AS payout_total,
    COALESCE(sum(wallet_amount), 0) AS wallet_total
  FROM filtered;
$$;

CREATE OR REPLACE FUNCTION public.ac_ecommerce_marketplace_bill_page(
  p_channel_id uuid,
  p_date_basis text,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_search text DEFAULT NULL,
  p_status_filter text DEFAULT 'all',
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 51
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filtered AS MATERIALIZED (
    SELECT
      r.*,
      CASE p_date_basis
        WHEN 'completed_at' THEN COALESCE(r.completed_at, r.marketplace_billed_at, r.ordered_at)
        WHEN 'settled_at' THEN COALESCE(r.settled_at, r.marketplace_billed_at, r.ordered_at)
        WHEN 'wallet_received_at' THEN COALESCE(r.wallet_received_at, r.marketplace_billed_at, r.ordered_at)
        WHEN 'billed_at' THEN COALESCE(r.marketplace_billed_at, r.ordered_at)
        ELSE COALESCE(r.ordered_at, r.marketplace_billed_at)
      END AS sort_date
    FROM public.ac_v_ecommerce_marketplace_bill_reconciliation r
    WHERE auth.uid() IS NOT NULL
      AND r.channel_id = p_channel_id
      AND CASE p_date_basis
        WHEN 'completed_at' THEN COALESCE(r.completed_at, r.marketplace_billed_at, r.ordered_at)
        WHEN 'settled_at' THEN COALESCE(r.settled_at, r.marketplace_billed_at, r.ordered_at)
        WHEN 'wallet_received_at' THEN COALESCE(r.wallet_received_at, r.marketplace_billed_at, r.ordered_at)
        WHEN 'billed_at' THEN COALESCE(r.marketplace_billed_at, r.ordered_at)
        ELSE COALESCE(r.ordered_at, r.marketplace_billed_at)
      END BETWEEN p_date_from AND p_date_to
      AND (
        nullif(btrim(p_search), '') IS NULL
        OR r.order_no ILIKE '%' || btrim(p_search) || '%'
        OR r.erp_bill_no ILIKE '%' || btrim(p_search) || '%'
      )
      AND (
        p_status_filter = 'all'
        OR (p_status_filter = 'issues' AND r.reconciliation_status IN ('not_found_order', 'waiting_delivery', 'waiting_wallet', 'waiting_settlement', 'amount_mismatch'))
        OR (p_status_filter = 'paid' AND r.reconciliation_status IN ('paid', 'paid_zero'))
        OR (p_status_filter NOT IN ('all', 'issues', 'paid') AND r.reconciliation_status = p_status_filter)
      )
    ORDER BY sort_date DESC NULLS LAST, r.order_no DESC
    LIMIT least(greatest(p_limit, 1), 101)
    OFFSET greatest(p_offset, 0)
  )
  SELECT COALESCE(
    jsonb_agg(to_jsonb(filtered) - 'sort_date' ORDER BY sort_date DESC NULLS LAST, order_no DESC),
    '[]'::jsonb
  )
  FROM filtered;
$$;

-- Remove the earlier delivered-only draft if this migration was already run.
DROP FUNCTION IF EXISTS public.ac_ecommerce_marketplace_delivered_summary(uuid, timestamptz, timestamptz, text, text);
DROP FUNCTION IF EXISTS public.ac_ecommerce_marketplace_delivered_page(uuid, timestamptz, timestamptz, text, text, integer, integer);

REVOKE ALL ON FUNCTION public.ac_ecommerce_marketplace_bill_summary(uuid, text, timestamptz, timestamptz, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ac_ecommerce_marketplace_bill_page(uuid, text, timestamptz, timestamptz, text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ac_ecommerce_marketplace_bill_summary(uuid, text, timestamptz, timestamptz, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ac_ecommerce_marketplace_bill_page(uuid, text, timestamptz, timestamptz, text, text, integer, integer) TO authenticated;

COMMIT;
