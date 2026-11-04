-- Allow an authorized claim operator to edit (or keep unchanged) a rejected
-- claim and submit the same request back to the accounting approval queue.

ALTER TABLE public.or_claim_requests
  ADD COLUMN IF NOT EXISTS resubmitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resubmission_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rejection_history JSONB NOT NULL DEFAULT '[]'::JSONB;

CREATE OR REPLACE FUNCTION public.rpc_resubmit_rejected_claim_request(
  p_request_id UUID,
  p_proposed_snapshot JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_request public.or_claim_requests%ROWTYPE;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขและส่งคำขอเคลมอีกครั้ง';
  END IF;

  SELECT * INTO v_request
  FROM public.or_claim_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_request.id IS NULL OR v_request.status <> 'rejected' THEN
    RAISE EXCEPTION 'ไม่พบคำขอเคลมที่ถูกปฏิเสธ หรือรายการนี้ถูกส่งใหม่แล้ว';
  END IF;

  IF p_proposed_snapshot IS NULL
     OR jsonb_typeof(p_proposed_snapshot) <> 'object'
     OR jsonb_typeof(p_proposed_snapshot->'order') <> 'object'
     OR jsonb_typeof(p_proposed_snapshot->'items') <> 'array'
     OR jsonb_array_length(p_proposed_snapshot->'items') = 0 THEN
    RAISE EXCEPTION 'ข้อมูลบิลเคลมไม่สมบูรณ์';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.or_orders reference_order
    WHERE reference_order.id = v_request.ref_order_id
      AND reference_order.status = 'จัดส่งแล้ว'
  ) THEN
    RAISE EXCEPTION 'บิลอ้างอิงต้องอยู่ในสถานะจัดส่งแล้ว';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.or_claim_requests other
    WHERE other.ref_order_id = v_request.ref_order_id
      AND other.status = 'pending'
      AND other.id <> v_request.id
  ) THEN
    RAISE EXCEPTION 'บิลอ้างอิงนี้มีคำขอเคลมที่รออนุมัติอยู่แล้ว';
  END IF;

  UPDATE public.or_claim_requests
  SET proposed_snapshot = p_proposed_snapshot,
      rejection_history = COALESCE(rejection_history, '[]'::JSONB) || jsonb_build_array(
        jsonb_build_object(
          'reason', rejected_reason,
          'reviewed_by', reviewed_by,
          'reviewed_at', reviewed_at,
          'resubmitted_by', v_uid,
          'resubmitted_at', now()
        )
      ),
      status = 'pending',
      reviewed_by = NULL,
      reviewed_at = NULL,
      rejected_reason = NULL,
      resubmitted_at = now(),
      resubmission_count = COALESCE(resubmission_count, 0) + 1
  WHERE id = p_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_resubmit_rejected_claim_request(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_resubmit_rejected_claim_request(UUID, JSONB) TO authenticated;
