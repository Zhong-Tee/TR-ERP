BEGIN;

CREATE TABLE IF NOT EXISTS public.ac_ecommerce_reconciliation_overrides (
  channel_id uuid NOT NULL REFERENCES public.ac_ecommerce_channels(id) ON DELETE CASCADE,
  order_no text NOT NULL,
  manual_status text NOT NULL CHECK (manual_status IN ('cancelled', 'returned')),
  note text,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, order_no)
);

ALTER TABLE public.ac_ecommerce_reconciliation_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ac_ecommerce_reconciliation_overrides_select
  ON public.ac_ecommerce_reconciliation_overrides;
CREATE POLICY ac_ecommerce_reconciliation_overrides_select
  ON public.ac_ecommerce_reconciliation_overrides
  FOR SELECT TO authenticated
  USING (true);

GRANT SELECT ON public.ac_ecommerce_reconciliation_overrides TO authenticated;

-- Keep the original imported states intact. Accounting corrections override
-- only the reconciliation result shown by this module.
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
WHERE mp.billed_order_id IS NOT NULL OR mp.billed_bill_no IS NOT NULL;

CREATE OR REPLACE FUNCTION public.ac_ecommerce_set_manual_status(
  p_channel_id uuid,
  p_order_no text,
  p_status text,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_status NOT IN ('cancelled', 'returned') THEN
    RAISE EXCEPTION 'Unsupported manual reconciliation status';
  END IF;

  IF nullif(btrim(p_order_no), '') IS NULL THEN
    RAISE EXCEPTION 'Order number is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.ac_v_ecommerce_marketplace_bill_reconciliation row_check
    WHERE row_check.channel_id = p_channel_id
      AND lower(btrim(row_check.order_no)) = lower(btrim(p_order_no))
  ) THEN
    RAISE EXCEPTION 'Marketplace bill not found';
  END IF;

  INSERT INTO public.ac_ecommerce_reconciliation_overrides (
    channel_id,
    order_no,
    manual_status,
    note,
    updated_by,
    updated_at
  ) VALUES (
    p_channel_id,
    btrim(p_order_no),
    p_status,
    nullif(btrim(p_note), ''),
    auth.uid(),
    now()
  )
  ON CONFLICT (channel_id, order_no) DO UPDATE
  SET manual_status = EXCLUDED.manual_status,
      note = EXCLUDED.note,
      updated_by = EXCLUDED.updated_by,
      updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.ac_ecommerce_set_manual_status(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ac_ecommerce_set_manual_status(uuid, text, text, text) TO authenticated;

COMMIT;
