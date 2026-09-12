-- Re-open an already-created REQ bill for approval after a failed slip check.
-- The proposed revision is kept on the claim request and is only applied to
-- the existing REQ bill after account approval. No duplicate REQ is created.

BEGIN;

ALTER TABLE public.or_claim_requests
  ADD COLUMN IF NOT EXISTS reapproval_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approval_history JSONB NOT NULL DEFAULT '[]'::JSONB;

CREATE OR REPLACE FUNCTION public.rpc_submit_claim_order_revision(
  p_order_id UUID,
  p_proposed_snapshot JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_request public.or_claim_requests%ROWTYPE;
  v_order public.or_orders%ROWTYPE;
  v_snapshot JSONB;
  v_price NUMERIC;
  v_shipping NUMERIC;
  v_discount NUMERIC;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขและส่งบิลเคลมอนุมัติใหม่';
  END IF;

  SELECT * INTO v_order
  FROM public.or_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL OR upper(COALESCE(v_order.bill_no, '')) NOT LIKE 'REQ%' THEN
    RAISE EXCEPTION 'ไม่พบบิลเคลม';
  END IF;
  IF v_order.status NOT IN ('ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ') THEN
    RAISE EXCEPTION 'ส่งอนุมัติใหม่ได้เฉพาะบิลที่ตรวจสอบสลิปไม่ผ่าน';
  END IF;

  SELECT * INTO v_request
  FROM public.or_claim_requests
  WHERE created_claim_order_id = p_order_id
  ORDER BY reviewed_at DESC NULLS LAST, created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_request.id IS NULL OR v_request.status <> 'approved' THEN
    RAISE EXCEPTION 'ไม่พบคำขอเคลมที่อนุมัติแล้วของบิลนี้';
  END IF;

  IF p_proposed_snapshot IS NULL
     OR jsonb_typeof(p_proposed_snapshot) <> 'object'
     OR jsonb_typeof(p_proposed_snapshot->'order') <> 'object'
     OR jsonb_typeof(p_proposed_snapshot->'items') <> 'array'
     OR jsonb_array_length(p_proposed_snapshot->'items') = 0 THEN
    RAISE EXCEPTION 'ข้อมูลบิลเคลมที่แก้ไขไม่สมบูรณ์';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_proposed_snapshot->'items') AS row(value)
    WHERE btrim(COALESCE(value->>'product_name', '')) = ''
       OR COALESCE((value->>'quantity')::INTEGER, 0) < 1
       OR COALESCE((value->>'unit_price')::NUMERIC, 0) < 0
  ) THEN
    RAISE EXCEPTION 'สินค้า จำนวน หรือราคาไม่ถูกต้อง';
  END IF;

  SELECT COALESCE(SUM(
    CASE WHEN COALESCE((value->>'is_free')::BOOLEAN, false)
      THEN 0
      ELSE COALESCE((value->>'quantity')::NUMERIC, 0) * COALESCE((value->>'unit_price')::NUMERIC, 0)
    END
  ), 0)
  INTO v_price
  FROM jsonb_array_elements(p_proposed_snapshot->'items') AS row(value);

  v_shipping := GREATEST(COALESCE((p_proposed_snapshot->'order'->>'shipping_cost')::NUMERIC, 0), 0);
  v_discount := GREATEST(COALESCE((p_proposed_snapshot->'order'->>'discount')::NUMERIC, 0), 0);
  v_snapshot := jsonb_set(
    p_proposed_snapshot,
    '{order}',
    (p_proposed_snapshot->'order') || jsonb_build_object(
      'price', v_price,
      'shipping_cost', v_shipping,
      'discount', v_discount,
      'total_amount', v_price + v_shipping - v_discount
    )
  );

  UPDATE public.or_claim_requests
  SET proposed_snapshot = v_snapshot,
      approval_history = COALESCE(approval_history, '[]'::JSONB) || jsonb_build_array(
        jsonb_build_object(
          'reviewed_by', reviewed_by,
          'reviewed_at', reviewed_at,
          'revision_submitted_by', v_uid,
          'revision_submitted_at', now()
        )
      ),
      status = 'pending',
      reviewed_by = NULL,
      reviewed_at = NULL,
      rejected_reason = NULL,
      reapproval_count = COALESCE(reapproval_count, 0) + 1
  WHERE id = v_request.id;

  UPDATE public.or_orders
  SET status = 'รออนุมัติเคลม',
      claim_shipping_confirmed_at = NULL,
      updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'request_id', v_request.id,
    'order_id', p_order_id,
    'bill_no', v_order.bill_no,
    'status', 'pending'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_approve_revised_claim_request(p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_request public.or_claim_requests%ROWTYPE;
  v_order public.or_orders%ROWTYPE;
  v_order_snapshot JSONB;
  v_items JSONB;
  v_item JSONB;
  v_idx INTEGER := 0;
  v_item_uid TEXT;
  v_price NUMERIC;
  v_shipping NUMERIC;
  v_discount NUMERIC;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติเคลม (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT * INTO v_request
  FROM public.or_claim_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_request.id IS NULL OR v_request.status <> 'pending' OR v_request.created_claim_order_id IS NULL THEN
    RAISE EXCEPTION 'ไม่พบคำขอแก้ไขบิลเคลมที่รออนุมัติ';
  END IF;

  SELECT * INTO v_order
  FROM public.or_orders
  WHERE id = v_request.created_claim_order_id
  FOR UPDATE;

  IF v_order.id IS NULL OR v_order.status <> 'รออนุมัติเคลม' THEN
    RAISE EXCEPTION 'บิลเคลมไม่ได้อยู่ในสถานะรออนุมัติ';
  END IF;

  v_order_snapshot := v_request.proposed_snapshot->'order';
  v_items := v_request.proposed_snapshot->'items';
  IF v_order_snapshot IS NULL
     OR jsonb_typeof(v_order_snapshot) <> 'object'
     OR v_items IS NULL
     OR jsonb_typeof(v_items) <> 'array'
     OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'ข้อมูลบิลเคลมที่เสนอไม่สมบูรณ์';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_items) AS row(value)
    WHERE btrim(COALESCE(value->>'product_name', '')) = ''
       OR COALESCE((value->>'quantity')::INTEGER, 0) < 1
       OR COALESCE((value->>'unit_price')::NUMERIC, 0) < 0
  ) THEN
    RAISE EXCEPTION 'สินค้า จำนวน หรือราคาไม่ถูกต้อง';
  END IF;

  SELECT COALESCE(SUM(
    CASE WHEN COALESCE((value->>'is_free')::BOOLEAN, false)
      THEN 0
      ELSE COALESCE((value->>'quantity')::NUMERIC, 0) * COALESCE((value->>'unit_price')::NUMERIC, 0)
    END
  ), 0)
  INTO v_price
  FROM jsonb_array_elements(v_items) AS row(value);
  v_shipping := GREATEST(COALESCE((v_order_snapshot->>'shipping_cost')::NUMERIC, 0), 0);
  v_discount := GREATEST(COALESCE((v_order_snapshot->>'discount')::NUMERIC, 0), 0);
  v_order_snapshot := v_order_snapshot || jsonb_build_object(
    'price', v_price,
    'shipping_cost', v_shipping,
    'discount', v_discount,
    'total_amount', v_price + v_shipping - v_discount
  );

  UPDATE public.or_orders
  SET price = v_price,
      shipping_cost = v_shipping,
      discount = v_discount,
      total_amount = v_price + v_shipping - v_discount,
      status = 'รอลงข้อมูล',
      claim_shipping_confirmed_at = NULL,
      updated_at = now()
  WHERE id = v_order.id;

  DELETE FROM public.or_order_items WHERE order_id = v_order.id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) AS t(value)
  LOOP
    v_idx := v_idx + 1;
    v_item_uid := v_order.bill_no || '-' || v_idx::TEXT;

    INSERT INTO public.or_order_items (
      order_id, item_uid, product_id, product_name, quantity, unit_price,
      ink_color, product_type, cartoon_pattern, line_pattern, font,
      line_1, line_2, line_3, no_name_line, is_free, notes,
      file_attachment, attachment_name
    ) VALUES (
      v_order.id,
      v_item_uid,
      NULLIF(btrim(COALESCE(v_item->>'product_id', '')), '')::UUID,
      COALESCE(btrim(v_item->>'product_name'), ''),
      GREATEST(COALESCE((v_item->>'quantity')::INTEGER, 1), 1),
      GREATEST(COALESCE((v_item->>'unit_price')::NUMERIC, 0), 0),
      NULLIF(btrim(COALESCE(v_item->>'ink_color', '')), ''),
      COALESCE(NULLIF(btrim(COALESCE(v_item->>'product_type', '')), ''), 'ชั้น1'),
      NULLIF(btrim(COALESCE(v_item->>'cartoon_pattern', '')), ''),
      NULLIF(btrim(COALESCE(v_item->>'line_pattern', '')), ''),
      NULLIF(btrim(COALESCE(v_item->>'font', '')), ''),
      NULLIF(btrim(COALESCE(v_item->>'line_1', '')), ''),
      NULLIF(btrim(COALESCE(v_item->>'line_2', '')), ''),
      NULLIF(btrim(COALESCE(v_item->>'line_3', '')), ''),
      COALESCE((v_item->>'no_name_line')::BOOLEAN, false),
      COALESCE((v_item->>'is_free')::BOOLEAN, false),
      NULLIF(btrim(COALESCE(v_item->>'notes', '')), ''),
      NULLIF(btrim(COALESCE(v_item->>'file_attachment', '')), ''),
      NULLIF(btrim(COALESCE(v_item->>'attachment_name', '')), '')
    );
  END LOOP;

  UPDATE public.or_claim_requests
  SET status = 'approved',
      reviewed_by = v_uid,
      reviewed_at = now(),
      rejected_reason = NULL,
      proposed_snapshot = jsonb_set(proposed_snapshot, '{order}', v_order_snapshot)
  WHERE id = v_request.id;

  RETURN jsonb_build_object(
    'order_id', v_order.id,
    'bill_no', v_order.bill_no,
    'reapproved', true
  );
END;
$$;

-- Keep the existing REQ bill out of normal queues while a revised request is
-- pending, and return it to the failed queue if account rejects the revision.
CREATE OR REPLACE FUNCTION public.tr_fn_sync_revised_claim_review_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.created_claim_order_id IS NULL OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'pending' THEN
    UPDATE public.or_orders
    SET status = 'รออนุมัติเคลม',
        claim_shipping_confirmed_at = NULL,
        updated_at = now()
    WHERE id = NEW.created_claim_order_id
      AND status IN ('ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ');
  ELSIF NEW.status = 'rejected' THEN
    UPDATE public.or_orders
    SET status = 'ตรวจสอบไม่ผ่าน',
        updated_at = now()
    WHERE id = NEW.created_claim_order_id
      AND status = 'รออนุมัติเคลม';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_sync_revised_claim_review_state ON public.or_claim_requests;
CREATE TRIGGER tr_sync_revised_claim_review_state
  AFTER UPDATE OF status ON public.or_claim_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_fn_sync_revised_claim_review_state();

REVOKE ALL ON FUNCTION public.rpc_submit_claim_order_revision(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_approve_revised_claim_request(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_submit_claim_order_revision(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_approve_revised_claim_request(UUID) TO authenticated;

COMMENT ON FUNCTION public.rpc_submit_claim_order_revision(UUID, JSONB) IS
  'Submits changed items/prices of an existing failed-slip REQ bill for account reapproval without mutating the approved bill.';
COMMENT ON FUNCTION public.rpc_approve_revised_claim_request(UUID) IS
  'Applies an approved revision atomically to the existing REQ bill and returns it to shipping/slip confirmation.';

COMMIT;
