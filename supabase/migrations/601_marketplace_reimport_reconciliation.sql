-- Reconciliation must use only the current, non-cancelled Marketplace work.
-- Superseded rows remain queryable from mp_orders for audit/history.
BEGIN;

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
    WHEN correction.manual_status IS NOT NULL THEN correction.manual_status
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
  CASE WHEN s.id IS NULL THEN NULL ELSE s.payout_amount - COALESCE(wallet.wallet_amount, 0) END AS payout_variance,
  correction.manual_status,
  correction.note AS manual_note,
  correction.updated_at AS manual_updated_at
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
LEFT JOIN public.ac_ecommerce_reconciliation_overrides correction
  ON correction.channel_id = channel.id
 AND lower(btrim(correction.order_no)) = lower(btrim(mp.marketplace_order_no))
LEFT JOIN LATERAL (
  SELECT orders.id, orders.bill_no, orders.total_amount
  FROM public.or_orders orders
  WHERE orders.id = mp.billed_order_id
     OR (mp.billed_order_id IS NULL AND orders.bill_no = mp.billed_bill_no)
  ORDER BY (orders.id = mp.billed_order_id) DESC, orders.created_at DESC
  LIMIT 1
) erp ON true
WHERE mp.is_current
  AND mp.status <> 'cancelled'
  AND (mp.billed_order_id IS NOT NULL OR mp.billed_bill_no IS NOT NULL);

COMMENT ON VIEW public.ac_v_ecommerce_marketplace_bill_reconciliation IS
  'Current non-cancelled ERP bill opened from Marketplace, with optional order, income and balance matches; superseded imports remain in mp_orders for audit.';

COMMIT;
