-- Billing reconciliation exposes only matching references to accounting roles.
CREATE OR REPLACE FUNCTION public.tr_billing_references(p_keys text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.us_users WHERE id = auth.uid() AND role IN ('superadmin', 'account')) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์กระทบยอดเรียกเก็บ';
  END IF;
  IF coalesce(array_length(p_keys, 1), 0) > 1000 THEN RAISE EXCEPTION 'จำนวนอ้างอิงเกินกำหนด'; END IF;
  RETURN jsonb_build_object(
    'orders', (SELECT coalesce(jsonb_agg(t), '[]'::jsonb) FROM (
      SELECT id, bill_no, channel_order_no, tracking_number, status FROM public.or_orders
      WHERE upper(regexp_replace(coalesce(tracking_number,''), '\s', '', 'g')) = ANY(p_keys)
         OR upper(regexp_replace(coalesce(bill_no,''), '\s', '', 'g')) = ANY(p_keys)
         OR upper(regexp_replace(coalesce(channel_order_no,''), '\s', '', 'g')) = ANY(p_keys)
    ) t),
    'consignments', (SELECT coalesce(jsonb_agg(t), '[]'::jsonb) FROM (
      SELECT DISTINCT tracking_no, order_no FROM public.tr_delivery_check_rows WHERE is_consignment
      AND (upper(regexp_replace(coalesce(tracking_no,''), '\s', '', 'g')) = ANY(p_keys)
        OR upper(regexp_replace(coalesce(order_no,''), '\s', '', 'g')) = ANY(p_keys))
    ) t)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.tr_billing_references(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tr_billing_references(text[]) TO authenticated;
