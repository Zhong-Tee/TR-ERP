BEGIN;

-- The reconciliation view matches every platform order to ERP by a normalized
-- channel order number. Without this expression index PostgreSQL must scan the
-- whole ERP order table repeatedly while rendering the list.
CREATE INDEX IF NOT EXISTS idx_or_orders_channel_order_no_normalized
  ON public.or_orders ((lower(btrim(channel_order_no))))
  WHERE channel_order_no IS NOT NULL;

-- Core reconciliation deliberately excludes the ERP lookup. The former view
-- performed that lookup before LIMIT/OFFSET, so even page 1 could scan and join
-- every matching order before returning 50 rows.
CREATE OR REPLACE VIEW public.ac_v_ecommerce_order_reconciliation_core
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
    order_id,
    COUNT(*) AS line_count,
    SUM(qty) AS item_qty,
    SUM(returned_qty) AS returned_qty
  FROM public.ac_ecommerce_order_lines
  GROUP BY order_id
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
  o.province,
  COALESCE(lt.line_count, 0) AS line_count,
  COALESCE(lt.item_qty, 0) AS item_qty,
  COALESCE(lt.returned_qty, 0) AS returned_qty,
  s.settled_at,
  s.gross_sales,
  s.platform_fee_total,
  s.seller_cost_total,
  s.fee_category_count,
  s.payout_amount,
  s.fee_breakdown,
  w.wallet_amount,
  w.wallet_received_at,
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
  CASE WHEN s.id IS NULL THEN NULL ELSE s.payout_amount - COALESCE(w.wallet_amount, 0) END AS payout_variance
FROM order_keys k
JOIN public.ac_ecommerce_channels c ON c.id = k.channel_id
LEFT JOIN public.ac_ecommerce_orders o ON o.channel_id = k.channel_id AND o.order_no = k.order_no
LEFT JOIN line_totals lt ON lt.order_id = o.id
LEFT JOIN public.ac_ecommerce_settlements s ON s.channel_id = k.channel_id AND s.order_no = k.order_no
LEFT JOIN wallet w ON w.channel_id = k.channel_id AND w.order_no = k.order_no;

GRANT SELECT ON public.ac_v_ecommerce_order_reconciliation_core TO authenticated;

CREATE OR REPLACE FUNCTION public.ac_ecommerce_reconciliation_page(
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
SECURITY INVOKER
SET search_path = public
AS $$
  WITH page_rows AS MATERIALIZED (
    SELECT r.*
    FROM public.ac_v_ecommerce_order_reconciliation_core r
    WHERE r.channel_id = p_channel_id
      AND CASE p_date_basis
        WHEN 'settled_at' THEN r.settled_at
        WHEN 'wallet_received_at' THEN r.wallet_received_at
        ELSE r.ordered_at
      END >= p_date_from
      AND CASE p_date_basis
        WHEN 'settled_at' THEN r.settled_at
        WHEN 'wallet_received_at' THEN r.wallet_received_at
        ELSE r.ordered_at
      END <= p_date_to
      AND (nullif(btrim(p_search), '') IS NULL OR r.order_no ILIKE '%' || btrim(p_search) || '%')
      AND (
        p_status_filter = 'all'
        OR (p_status_filter = 'issues' AND r.reconciliation_status IN ('waiting_wallet', 'waiting_settlement', 'amount_mismatch', 'needs_review'))
        OR (p_status_filter NOT IN ('all', 'issues') AND r.reconciliation_status = p_status_filter)
      )
    ORDER BY
      CASE p_date_basis
        WHEN 'settled_at' THEN r.settled_at
        WHEN 'wallet_received_at' THEN r.wallet_received_at
        ELSE r.ordered_at
      END DESC NULLS LAST,
      r.order_no DESC
    LIMIT least(greatest(p_limit, 1), 101)
    OFFSET greatest(p_offset, 0)
  ), enriched AS (
    SELECT
      to_jsonb(p) || jsonb_build_object(
        'erp_order_id', erp.id,
        'erp_bill_no', erp.bill_no,
        'erp_order_total', erp.total_amount
      ) AS row_data,
      CASE p_date_basis
        WHEN 'settled_at' THEN p.settled_at
        WHEN 'wallet_received_at' THEN p.wallet_received_at
        ELSE p.ordered_at
      END AS sort_date,
      p.order_no AS sort_order_no
    FROM page_rows p
    LEFT JOIN LATERAL (
      SELECT oo.id, oo.bill_no, oo.total_amount
      FROM public.or_orders oo
      WHERE oo.channel_order_no IS NOT NULL
        AND lower(btrim(oo.channel_order_no)) = lower(btrim(p.order_no))
      ORDER BY oo.created_at DESC
      LIMIT 1
    ) erp ON true
  )
  SELECT COALESCE(jsonb_agg(row_data ORDER BY sort_date DESC NULLS LAST, sort_order_no DESC), '[]'::jsonb) FROM enriched;
$$;

GRANT EXECUTE ON FUNCTION public.ac_ecommerce_reconciliation_page(uuid, text, timestamptz, timestamptz, text, text, integer, integer) TO authenticated;

-- Return one aggregate row instead of transferring up to 10,000 reconciliation
-- rows to the browser just to calculate the overview cards.
CREATE OR REPLACE FUNCTION public.ac_ecommerce_reconciliation_summary(
  p_channel_id uuid,
  p_date_basis text,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_search text DEFAULT NULL,
  p_status_filter text DEFAULT 'all'
)
RETURNS TABLE (
  order_count bigint,
  delivered_count bigint,
  cancelled_count bigint,
  shipping_count bigint,
  paid_count bigint,
  issue_count bigint,
  sales_total numeric,
  fee_total numeric,
  payout_total numeric,
  wallet_total numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH filtered AS (
    SELECT r.*
    FROM public.ac_v_ecommerce_order_reconciliation_core r
    WHERE r.channel_id = p_channel_id
      AND CASE p_date_basis
        WHEN 'settled_at' THEN r.settled_at
        WHEN 'wallet_received_at' THEN r.wallet_received_at
        ELSE r.ordered_at
      END >= p_date_from
      AND CASE p_date_basis
        WHEN 'settled_at' THEN r.settled_at
        WHEN 'wallet_received_at' THEN r.wallet_received_at
        ELSE r.ordered_at
      END <= p_date_to
      AND (nullif(btrim(p_search), '') IS NULL OR r.order_no ILIKE '%' || btrim(p_search) || '%')
      AND (
        p_status_filter = 'all'
        OR (p_status_filter = 'issues' AND r.reconciliation_status IN ('waiting_wallet', 'waiting_settlement', 'amount_mismatch', 'needs_review'))
        OR (p_status_filter NOT IN ('all', 'issues') AND r.reconciliation_status = p_status_filter)
      )
  )
  SELECT
    count(*) AS order_count,
    count(*) FILTER (WHERE delivery_status = 'delivered') AS delivered_count,
    count(*) FILTER (WHERE delivery_status = 'cancelled') AS cancelled_count,
    count(*) FILTER (WHERE delivery_status = 'shipping') AS shipping_count,
    count(*) FILTER (WHERE reconciliation_status IN ('paid', 'paid_zero')) AS paid_count,
    count(*) FILTER (WHERE reconciliation_status IN ('waiting_wallet', 'waiting_settlement', 'amount_mismatch', 'needs_review')) AS issue_count,
    CASE WHEN coalesce(sum(gross_sales), 0) <> 0 THEN coalesce(sum(gross_sales), 0) ELSE coalesce(sum(order_total), 0) END AS sales_total,
    coalesce(sum(platform_fee_total), 0) AS fee_total,
    coalesce(sum(payout_amount), 0) AS payout_total,
    coalesce(sum(wallet_amount), 0) AS wallet_total
  FROM filtered;
$$;

GRANT EXECUTE ON FUNCTION public.ac_ecommerce_reconciliation_summary(uuid, text, timestamptz, timestamptz, text, text) TO authenticated;

COMMIT;
