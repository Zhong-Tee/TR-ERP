BEGIN;

-- Replaces the dashboard functions from migration 588 so databases that
-- already deployed it receive the corrected billed-date payout aging rule.

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
        OR (p_status_filter = 'cancelled_returned' AND r.reconciliation_status IN ('cancelled', 'returned'))
        OR (p_status_filter NOT IN ('all', 'issues', 'paid', 'delivered', 'income_found', 'balance_found', 'cancelled_returned') AND r.reconciliation_status = p_status_filter)
      )
  ), filtered AS (
    SELECT *
    FROM prepared
    WHERE p_aging = 'all'
       OR (p_aging = 'within_7' AND NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'paid_zero') AND pending_age_days <= 7)
       OR (p_aging = 'days_8_14' AND NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'paid_zero') AND pending_age_days BETWEEN 8 AND 14)
       OR (p_aging = 'over_14' AND NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'paid_zero') AND pending_age_days > 14)
  )
  SELECT
    count(*) AS order_count,
    count(*) FILTER (WHERE order_matched) AS order_match_count,
    count(*) FILTER (WHERE income_matched) AS income_match_count,
    count(*) FILTER (WHERE balance_matched) AS balance_match_count,
    count(*) FILTER (WHERE delivery_status = 'delivered') AS delivered_count,
    count(*) FILTER (WHERE reconciliation_status = 'cancelled') AS cancelled_count,
    count(*) FILTER (WHERE reconciliation_status = 'returned') AS returned_count,
    count(*) FILTER (WHERE delivery_status = 'shipping') AS shipping_count,
    count(*) FILTER (WHERE reconciliation_status = 'paid') AS paid_count,
    count(*) FILTER (WHERE reconciliation_status = 'paid_zero') AS paid_zero_count,
    count(*) FILTER (WHERE reconciliation_status = 'waiting_settlement') AS waiting_settlement_count,
    count(*) FILTER (WHERE reconciliation_status = 'waiting_wallet') AS waiting_wallet_count,
    count(*) FILTER (WHERE reconciliation_status = 'amount_mismatch') AS mismatch_count,
    count(*) FILTER (WHERE NOT order_matched) AS missing_order_count,
    count(*) FILTER (WHERE reconciliation_status IN ('not_found_order', 'waiting_delivery', 'waiting_wallet', 'waiting_settlement', 'amount_mismatch')) AS issue_count,
    count(*) FILTER (WHERE NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'paid_zero') AND pending_age_days <= 7) AS within_cycle_count,
    count(*) FILTER (WHERE NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'paid_zero') AND pending_age_days BETWEEN 8 AND 14) AS overdue_cycle_count,
    count(*) FILTER (WHERE NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'paid_zero') AND pending_age_days > 14) AS overdue_two_cycles_count,
    COALESCE(sum(COALESCE(gross_sales, marketplace_order_total, erp_order_total)), 0) AS sales_total,
    COALESCE(sum(COALESCE(gross_sales, order_total)) FILTER (WHERE delivery_status = 'delivered'), 0) AS delivered_total,
    COALESCE(sum(platform_fee_total), 0) AS fee_total,
    COALESCE(sum(payout_amount), 0) AS payout_total,
    COALESCE(sum(wallet_amount), 0) AS wallet_total,
    COALESCE(sum(expected_amount) FILTER (WHERE NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'paid_zero') AND pending_age_days <= 7), 0) AS within_cycle_total,
    COALESCE(sum(expected_amount) FILTER (WHERE NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'paid_zero') AND pending_age_days BETWEEN 8 AND 14), 0) AS overdue_cycle_total,
    COALESCE(sum(expected_amount) FILTER (WHERE NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'paid_zero') AND pending_age_days > 14), 0) AS overdue_two_cycles_total,
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
        OR (p_status_filter = 'cancelled_returned' AND r.reconciliation_status IN ('cancelled', 'returned'))
        OR (p_status_filter NOT IN ('all', 'issues', 'paid', 'delivered', 'income_found', 'balance_found', 'cancelled_returned') AND r.reconciliation_status = p_status_filter)
      )
  ), filtered AS (
    SELECT *
    FROM prepared
    WHERE p_aging = 'all'
       OR (p_aging = 'within_7' AND NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'paid_zero') AND pending_age_days <= 7)
       OR (p_aging = 'days_8_14' AND NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'paid_zero') AND pending_age_days BETWEEN 8 AND 14)
       OR (p_aging = 'over_14' AND NOT balance_matched AND reconciliation_status NOT IN ('cancelled', 'returned', 'paid_zero') AND pending_age_days > 14)
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
