-- A parcel return is an additional order marker, not a shipping workflow status.
BEGIN;

ALTER TABLE public.or_orders
  ADD COLUMN IF NOT EXISTS has_parcel_return boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_inv_returns_ref_bill_no ON public.inv_returns (ref_bill_no);
CREATE INDEX IF NOT EXISTS idx_or_orders_parcel_return_created
  ON public.or_orders (created_at DESC) WHERE has_parcel_return;

-- Definer triggers let warehouse users update only this derived marker even
-- when their role cannot edit orders. No RPC or additional return read access.
CREATE OR REPLACE FUNCTION public.sync_order_parcel_return_marker()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  NEW.has_parcel_return := EXISTS (
    SELECT 1 FROM public.inv_returns r WHERE r.ref_bill_no = NEW.bill_no
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_parcel_return_orders()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE public.or_orders o
    SET has_parcel_return = EXISTS (
      SELECT 1 FROM public.inv_returns r WHERE r.ref_bill_no = o.bill_no
    )
    WHERE o.bill_no = OLD.ref_bill_no;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE public.or_orders o
    SET has_parcel_return = EXISTS (
      SELECT 1 FROM public.inv_returns r WHERE r.ref_bill_no = o.bill_no
    )
    WHERE o.bill_no = NEW.ref_bill_no;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_order_parcel_return_marker() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_parcel_return_orders() FROM PUBLIC;

DROP TRIGGER IF EXISTS sync_order_parcel_return_marker ON public.or_orders;
CREATE TRIGGER sync_order_parcel_return_marker
  BEFORE INSERT OR UPDATE OF bill_no, has_parcel_return ON public.or_orders
  FOR EACH ROW EXECUTE FUNCTION public.sync_order_parcel_return_marker();

DROP TRIGGER IF EXISTS sync_parcel_return_orders ON public.inv_returns;
CREATE TRIGGER sync_parcel_return_orders
  AFTER INSERT OR UPDATE OF ref_bill_no OR DELETE ON public.inv_returns
  FOR EACH ROW EXECUTE FUNCTION public.sync_parcel_return_orders();

-- Include historical RTNs, including pending receipts and partial returns.
UPDATE public.or_orders o
SET has_parcel_return = true
WHERE EXISTS (SELECT 1 FROM public.inv_returns r WHERE r.ref_bill_no = o.bill_no);


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
    WHEN erp.has_parcel_return THEN 'parcel_returned'
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
  SELECT orders.id, orders.bill_no, orders.total_amount, orders.has_parcel_return
  FROM public.or_orders orders
  WHERE orders.id = mp.billed_order_id
     OR (mp.billed_order_id IS NULL AND orders.bill_no = mp.billed_bill_no)
  ORDER BY (orders.id = mp.billed_order_id) DESC, orders.created_at DESC
  LIMIT 1
) erp ON true
WHERE mp.is_current
  AND mp.status <> 'cancelled'
  AND (mp.billed_order_id IS NOT NULL OR mp.billed_bill_no IS NOT NULL);


-- Returned summary includes RTNs; aging excludes goods already returned.
CREATE OR REPLACE FUNCTION public.ac_ecommerce_marketplace_bill_summary_v2(
  p_channel_id uuid,
  p_date_basis text,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_search text DEFAULT NULL,
  p_status_filter text DEFAULT 'all',
  p_aging text DEFAULT 'all'
)
RETURNS TABLE (
  order_count bigint,
  order_match_count bigint,
  income_match_count bigint,
  balance_match_count bigint,
  delivered_count bigint,
  cancelled_count bigint,
  returned_count bigint,
  shipping_count bigint,
  paid_count bigint,
  paid_zero_count bigint,
  waiting_settlement_count bigint,
  waiting_wallet_count bigint,
  mismatch_count bigint,
  missing_order_count bigint,
  issue_count bigint,
  within_cycle_count bigint,
  overdue_cycle_count bigint,
  overdue_two_cycles_count bigint,
  sales_total numeric,
  delivered_total numeric,
  fee_total numeric,
  payout_total numeric,
  wallet_total numeric,
  within_cycle_total numeric,
  overdue_cycle_total numeric,
  overdue_two_cycles_total numeric,
  paid_total numeric,
  mismatch_total numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH prepared AS (
    SELECT
      r.*,
      GREATEST(
        CURRENT_DATE - COALESCE(r.marketplace_billed_at, r.ordered_at)::date,
        0
      ) AS pending_age_days,
      COALESCE(r.payout_amount, r.gross_sales, r.order_total, 0) AS expected_amount
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
        OR (p_status_filter = 'delivered' AND r.delivery_status = 'delivered')
        OR (p_status_filter = 'income_found' AND r.income_matched)
        OR (p_status_filter = 'balance_found' AND r.balance_matched)
        OR (p_status_filter = 'cancelled_returned' AND r.reconciliation_status IN ('cancelled', 'returned', 'parcel_returned'))
        OR (p_status_filter NOT IN ('all', 'issues', 'paid', 'delivered', 'income_found', 'balance_found', 'cancelled_returned') AND r.reconciliation_status = p_status_filter)
      )
  ), filtered AS (
    SELECT *
    FROM prepared
    WHERE p_aging = 'all'
       OR (p_aging = 'within_7' AND NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'parcel_returned', 'paid_zero') AND pending_age_days <= 7)
       OR (p_aging = 'days_8_14' AND NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'parcel_returned', 'paid_zero') AND pending_age_days BETWEEN 8 AND 14)
       OR (p_aging = 'over_14' AND NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'parcel_returned', 'paid_zero') AND pending_age_days > 14)
  )
  SELECT
    count(*) AS order_count,
    count(*) FILTER (WHERE order_matched) AS order_match_count,
    count(*) FILTER (WHERE income_matched) AS income_match_count,
    count(*) FILTER (WHERE balance_matched) AS balance_match_count,
    count(*) FILTER (WHERE delivery_status = 'delivered') AS delivered_count,
    count(*) FILTER (WHERE reconciliation_status = 'cancelled') AS cancelled_count,
    count(*) FILTER (WHERE reconciliation_status IN ('returned', 'parcel_returned')) AS returned_count,
    count(*) FILTER (WHERE delivery_status = 'shipping') AS shipping_count,
    count(*) FILTER (WHERE reconciliation_status = 'paid') AS paid_count,
    count(*) FILTER (WHERE reconciliation_status = 'paid_zero') AS paid_zero_count,
    count(*) FILTER (WHERE reconciliation_status = 'waiting_settlement') AS waiting_settlement_count,
    count(*) FILTER (WHERE reconciliation_status = 'waiting_wallet') AS waiting_wallet_count,
    count(*) FILTER (WHERE reconciliation_status = 'amount_mismatch') AS mismatch_count,
    count(*) FILTER (WHERE NOT order_matched) AS missing_order_count,
    count(*) FILTER (WHERE reconciliation_status IN ('not_found_order', 'waiting_delivery', 'waiting_wallet', 'waiting_settlement', 'amount_mismatch')) AS issue_count,
    count(*) FILTER (WHERE NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'parcel_returned', 'paid_zero') AND pending_age_days <= 7) AS within_cycle_count,
    count(*) FILTER (WHERE NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'parcel_returned', 'paid_zero') AND pending_age_days BETWEEN 8 AND 14) AS overdue_cycle_count,
    count(*) FILTER (WHERE NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'parcel_returned', 'paid_zero') AND pending_age_days > 14) AS overdue_two_cycles_count,
    COALESCE(sum(COALESCE(gross_sales, marketplace_order_total, erp_order_total)), 0) AS sales_total,
    COALESCE(sum(COALESCE(gross_sales, order_total)) FILTER (WHERE delivery_status = 'delivered'), 0) AS delivered_total,
    COALESCE(sum(platform_fee_total), 0) AS fee_total,
    COALESCE(sum(payout_amount), 0) AS payout_total,
    COALESCE(sum(wallet_amount), 0) AS wallet_total,
    COALESCE(sum(expected_amount) FILTER (WHERE NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'parcel_returned', 'paid_zero') AND pending_age_days <= 7), 0) AS within_cycle_total,
    COALESCE(sum(expected_amount) FILTER (WHERE NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'parcel_returned', 'paid_zero') AND pending_age_days BETWEEN 8 AND 14), 0) AS overdue_cycle_total,
    COALESCE(sum(expected_amount) FILTER (WHERE NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'parcel_returned', 'paid_zero') AND pending_age_days > 14), 0) AS overdue_two_cycles_total,
    COALESCE(sum(wallet_amount) FILTER (WHERE reconciliation_status IN ('paid', 'paid_zero')), 0) AS paid_total,
    COALESCE(sum(ABS(payout_variance)) FILTER (WHERE reconciliation_status = 'amount_mismatch'), 0) AS mismatch_total
  FROM filtered;
$$;

CREATE OR REPLACE FUNCTION public.ac_ecommerce_marketplace_bill_page_v2(
  p_channel_id uuid,
  p_date_basis text,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_search text DEFAULT NULL,
  p_status_filter text DEFAULT 'all',
  p_aging text DEFAULT 'all',
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 51
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH prepared AS MATERIALIZED (
    SELECT
      r.*,
      CASE p_date_basis
        WHEN 'completed_at' THEN COALESCE(r.completed_at, r.marketplace_billed_at, r.ordered_at)
        WHEN 'settled_at' THEN COALESCE(r.settled_at, r.marketplace_billed_at, r.ordered_at)
        WHEN 'wallet_received_at' THEN COALESCE(r.wallet_received_at, r.marketplace_billed_at, r.ordered_at)
        WHEN 'billed_at' THEN COALESCE(r.marketplace_billed_at, r.ordered_at)
        ELSE COALESCE(r.ordered_at, r.marketplace_billed_at)
      END AS sort_date,
      GREATEST(
        CURRENT_DATE - COALESCE(r.marketplace_billed_at, r.ordered_at)::date,
        0
      ) AS pending_age_days
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
        OR (p_status_filter = 'delivered' AND r.delivery_status = 'delivered')
        OR (p_status_filter = 'income_found' AND r.income_matched)
        OR (p_status_filter = 'balance_found' AND r.balance_matched)
        OR (p_status_filter = 'cancelled_returned' AND r.reconciliation_status IN ('cancelled', 'returned', 'parcel_returned'))
        OR (p_status_filter NOT IN ('all', 'issues', 'paid', 'delivered', 'income_found', 'balance_found', 'cancelled_returned') AND r.reconciliation_status = p_status_filter)
      )
  ), filtered AS (
    SELECT *
    FROM prepared
    WHERE p_aging = 'all'
       OR (p_aging = 'within_7' AND NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'parcel_returned', 'paid_zero') AND pending_age_days <= 7)
       OR (p_aging = 'days_8_14' AND NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'parcel_returned', 'paid_zero') AND pending_age_days BETWEEN 8 AND 14)
       OR (p_aging = 'over_14' AND NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'parcel_returned', 'paid_zero') AND pending_age_days > 14)
    ORDER BY sort_date DESC NULLS LAST, order_no DESC
    LIMIT least(greatest(p_limit, 1), 101)
    OFFSET greatest(p_offset, 0)
  )
  SELECT COALESCE(
    jsonb_agg(to_jsonb(filtered) - 'sort_date' ORDER BY sort_date DESC NULLS LAST, order_no DESC),
    '[]'::jsonb
  )
  FROM filtered;
$$;

REVOKE ALL ON FUNCTION public.ac_ecommerce_marketplace_bill_summary_v2(uuid, text, timestamptz, timestamptz, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ac_ecommerce_marketplace_bill_page_v2(uuid, text, timestamptz, timestamptz, text, text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ac_ecommerce_marketplace_bill_summary_v2(uuid, text, timestamptz, timestamptz, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ac_ecommerce_marketplace_bill_page_v2(uuid, text, timestamptz, timestamptz, text, text, text, integer, integer) TO authenticated;

COMMIT;
