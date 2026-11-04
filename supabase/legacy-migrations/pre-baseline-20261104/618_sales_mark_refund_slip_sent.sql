-- Sales confirms delivery only after Accounting approves and attaches a slip.
-- Keep approved refunds protected by the existing RLS policies: this RPC can
-- change only delivery metadata, never amounts, approval, or slip attachments.
BEGIN;

CREATE OR REPLACE FUNCTION public.mark_refund_slip_sent(p_refund_id uuid)
RETURNS TABLE(refund_slip_sent_at timestamptz, refund_slip_sent_by uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor public.us_users%ROWTYPE;
  refund public.ac_refunds%ROWTYPE;
  order_owner text;
BEGIN
  SELECT * INTO actor FROM public.us_users WHERE id = auth.uid();
  IF actor.id IS NULL OR coalesce(actor.role, '') NOT IN ('sales-tr', 'sales-pump', 'admin', 'superadmin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยืนยันส่งสลิปโอนคืน';
  END IF;

  SELECT * INTO refund FROM public.ac_refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบรายการโอนคืน';
  END IF;
  SELECT btrim(o.admin_user) INTO order_owner FROM public.or_orders o WHERE o.id = refund.order_id;

  IF actor.role = 'sales-pump' AND NOT (
    coalesce(nullif(btrim(actor.username), '') = order_owner, false)
    OR coalesce(nullif(btrim(actor.email), '') = order_owner, false)
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยืนยันรายการโอนคืนของผู้อื่น';
  END IF;
  IF actor.role = 'sales-tr' AND NOT EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.role = 'sales-tr' AND (
      nullif(btrim(u.username), '') = order_owner
      OR nullif(btrim(u.email), '') = order_owner
    )
  ) THEN
    RAISE EXCEPTION 'รายการโอนคืนนี้อยู่นอกทีม Sales TR';
  END IF;
  IF coalesce(refund.status, '') <> 'approved' OR coalesce(cardinality(refund.refund_slip_paths), 0) = 0 THEN
    RAISE EXCEPTION 'บัญชีต้องอนุมัติและแนบสลิปโอนคืนก่อน';
  END IF;

  -- Repeated confirmation preserves the original sender and timestamp.
  IF refund.refund_slip_sent_at IS NULL THEN
    UPDATE public.ac_refunds r
    SET refund_slip_sent_at = now(), refund_slip_sent_by = actor.id
    WHERE r.id = p_refund_id
    RETURNING r.* INTO refund;
  END IF;
  RETURN QUERY SELECT refund.refund_slip_sent_at, refund.refund_slip_sent_by;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_refund_slip_sent(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_refund_slip_sent(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
