-- Let sales-tr work as one QT/PC team, replace ordinary deletion with
-- cancellation, and keep the prebill opener separate from the bill creator.

ALTER TABLE public.or_orders
  ADD COLUMN IF NOT EXISTS source_prebill_document_type TEXT
    CHECK (source_prebill_document_type IS NULL OR source_prebill_document_type IN ('quotation', 'production_confirmation')),
  ADD COLUMN IF NOT EXISTS source_prebill_owner_name TEXT;

COMMENT ON COLUMN public.or_orders.source_prebill_document_type IS
  'Immutable type snapshot of the QT/PC used to create this order';
COMMENT ON COLUMN public.or_orders.source_prebill_owner_name IS
  'Immutable display-name snapshot of the user who originally opened the QT/PC';

UPDATE public.or_orders o
SET source_prebill_document_type = d.document_type,
    source_prebill_owner_name = d.owner_name
FROM public.or_prebill_documents d
WHERE o.source_prebill_document_id = d.id
  AND (o.source_prebill_document_type IS NULL OR o.source_prebill_owner_name IS NULL);

CREATE OR REPLACE FUNCTION public.can_manage_prebill_document(p_owner_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.us_users actor
    JOIN public.us_users owner ON owner.id = p_owner_id
    WHERE actor.id = auth.uid()
      AND (
        actor.role = 'superadmin'
        OR actor.id = owner.id
        OR (actor.role = 'sales-tr' AND owner.role = 'sales-tr')
      )
  );
$$;

REVOKE ALL ON FUNCTION public.can_manage_prebill_document(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_prebill_document(UUID) TO authenticated;

DROP POLICY IF EXISTS prebill_documents_select ON public.or_prebill_documents;
CREATE POLICY prebill_documents_select ON public.or_prebill_documents
FOR SELECT TO authenticated
USING (public.can_manage_prebill_document(owner_id));

DROP POLICY IF EXISTS prebill_documents_update ON public.or_prebill_documents;
CREATE POLICY prebill_documents_update ON public.or_prebill_documents
FOR UPDATE TO authenticated
USING (public.can_manage_prebill_document(owner_id))
WITH CHECK (public.can_manage_prebill_document(owner_id));

DROP POLICY IF EXISTS prebill_items_write ON public.or_prebill_items;
CREATE POLICY prebill_items_write ON public.or_prebill_items
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.or_prebill_documents d
    WHERE d.id = document_id AND public.can_manage_prebill_document(d.owner_id)
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.or_prebill_documents d
    WHERE d.id = document_id AND public.can_manage_prebill_document(d.owner_id)
  )
);

CREATE OR REPLACE FUNCTION public.guard_prebill_document_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();

  IF TG_OP = 'INSERT' THEN
    IF v_role <> 'superadmin' AND (
      NEW.status NOT IN ('draft', 'active') OR NEW.approved_by IS NOT NULL
      OR NEW.approved_at IS NOT NULL OR NEW.approved_special_discount IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'ไม่มีสิทธิ์กำหนดสถานะอนุมัติ';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- The opener is immutable. Editing a teammate's document must never transfer
  -- ownership or replace the opener's display name.
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.owner_name IS DISTINCT FROM OLD.owner_name THEN
    RAISE EXCEPTION 'ไม่สามารถเปลี่ยนผู้เปิดเอกสาร QT/PC ได้';
  END IF;

  IF OLD.status IN ('converted', 'cancelled') THEN
    IF (to_jsonb(NEW) - ARRAY['converted_order_id', 'source_document_id', 'updated_at'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['converted_order_id', 'source_document_id', 'updated_at']) THEN
      RAISE EXCEPTION 'เอกสารที่เปิดบิลหรือยกเลิกแล้วแก้ไขไม่ได้';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF v_role <> 'superadmin' THEN
    IF NEW.status = 'approved'
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.approved_special_discount IS DISTINCT FROM OLD.approved_special_discount THEN
      RAISE EXCEPTION 'เฉพาะ superadmin เท่านั้นที่อนุมัติส่วนลดได้';
    END IF;
    IF NEW.special_discount IS DISTINCT FROM OLD.special_discount
       AND NEW.status <> 'pending_discount' THEN
      RAISE EXCEPTION 'ส่วนลดพิเศษต้องส่งคำขออนุมัติ';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status IN ('draft', 'active', 'rejected') AND NEW.status IN ('draft', 'active'))
      OR (OLD.status IN ('draft', 'active', 'rejected') AND NEW.status = 'pending_discount'
          AND NEW.discount_requested_by = auth.uid()
          AND btrim(COALESCE(NEW.discount_request_note, '')) <> '')
      OR (OLD.status IN ('active', 'approved') AND NEW.status = 'converted'
          AND NEW.converted_order_id IS NOT NULL)
      OR NEW.status = 'cancelled'
    ) THEN
      RAISE EXCEPTION 'ไม่มีสิทธิ์เปลี่ยนสถานะเอกสาร';
    END IF;
  END IF;

  IF v_role <> 'superadmin' AND OLD.status IN ('pending_discount', 'approved')
     AND NEW.status <> 'cancelled'
     AND NOT (OLD.status = 'approved' AND NEW.status = 'converted'
              AND NEW.converted_order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'เอกสารถูกล็อก แก้ไขได้โดย superadmin เท่านั้น';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_prebill_item_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_locked BOOLEAN;
BEGIN
  -- Only the superadmin-only hard-delete RPC sets this transaction-local flag.
  IF TG_OP = 'DELETE'
     AND current_setting('app.prebill_hard_delete', true) = 'on'
     AND public.check_user_role(auth.uid(), ARRAY['superadmin']) THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.or_prebill_documents d
      WHERE d.id = NEW.document_id AND d.status IN ('converted', 'cancelled')
    ) INTO v_locked;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.or_prebill_documents d
      WHERE d.id = OLD.document_id AND d.status IN ('converted', 'cancelled')
    ) INTO v_locked;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.or_prebill_documents d
      WHERE d.id IN (OLD.document_id, NEW.document_id)
        AND d.status IN ('converted', 'cancelled')
    ) INTO v_locked;
  END IF;

  IF v_locked THEN
    RAISE EXCEPTION 'รายการของเอกสารที่เปิดบิลหรือยกเลิกแล้วแก้ไขไม่ได้';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cancel_prebill_document(p_document_id UUID)
RETURNS public.or_prebill_documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc public.or_prebill_documents;
BEGIN
  SELECT * INTO v_doc
  FROM public.or_prebill_documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF v_doc.id IS NULL THEN RAISE EXCEPTION 'ไม่พบเอกสาร'; END IF;
  IF NOT public.can_manage_prebill_document(v_doc.owner_id) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยกเลิกเอกสารนี้';
  END IF;
  IF v_doc.status = 'converted' OR v_doc.converted_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'ไม่สามารถยกเลิกเอกสารที่เปิดบิลแล้วได้';
  END IF;
  IF v_doc.status = 'cancelled' THEN RETURN v_doc; END IF;

  UPDATE public.or_prebill_documents
  SET status = 'cancelled', updated_at = now()
  WHERE id = p_document_id
  RETURNING * INTO v_doc;
  RETURN v_doc;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_delete_cancelled_prebill_documents(p_document_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF NOT public.check_user_role(auth.uid(), ARRAY['superadmin']) THEN
    RAISE EXCEPTION 'เฉพาะ superadmin เท่านั้นที่ลบเอกสารถาวรได้';
  END IF;
  IF COALESCE(cardinality(p_document_ids), 0) = 0 THEN RETURN 0; END IF;
  IF EXISTS (
    SELECT 1 FROM public.or_prebill_documents
    WHERE id = ANY(p_document_ids) AND status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'ลบถาวรได้เฉพาะเอกสารในแถบยกเลิก';
  END IF;

  PERFORM set_config('app.prebill_hard_delete', 'on', true);
  DELETE FROM public.or_prebill_documents
  WHERE id = ANY(p_document_ids) AND status = 'cancelled';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Keep the old singular endpoint safe for any stale client still calling it.
CREATE OR REPLACE FUNCTION public.rpc_delete_prebill_document(p_document_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.rpc_delete_cancelled_prebill_documents(ARRAY[p_document_id]) = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_request_prebill_discount(
  p_document_id UUID, p_discount_type TEXT, p_discount_value NUMERIC, p_note TEXT
)
RETURNS public.or_prebill_documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc public.or_prebill_documents;
  v_name TEXT;
  v_discount NUMERIC;
BEGIN
  SELECT COALESCE(username, email) INTO v_name FROM public.us_users WHERE id = auth.uid();
  SELECT * INTO v_doc FROM public.or_prebill_documents WHERE id = p_document_id FOR UPDATE;
  IF v_doc.id IS NULL OR NOT public.can_manage_prebill_document(v_doc.owner_id) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์';
  END IF;
  IF v_doc.status NOT IN ('draft', 'active', 'rejected') THEN
    RAISE EXCEPTION 'สถานะเอกสารไม่อนุญาตให้ขอส่วนลด';
  END IF;
  IF p_discount_type NOT IN ('amount', 'percent') OR p_discount_value <= 0 THEN
    RAISE EXCEPTION 'ส่วนลดไม่ถูกต้อง';
  END IF;
  IF btrim(COALESCE(p_note, '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุหมายเหตุคำขอ'; END IF;
  v_discount := CASE WHEN p_discount_type = 'percent'
    THEN round(v_doc.subtotal * least(p_discount_value, 100) / 100, 2)
    ELSE least(p_discount_value, v_doc.subtotal)
  END;
  UPDATE public.or_prebill_documents SET
    status = 'pending_discount', special_discount_type = p_discount_type,
    special_discount_value = p_discount_value, special_discount = v_discount,
    discount_request_note = btrim(p_note), discount_requested_at = now(),
    discount_requested_by = auth.uid(), approved_special_discount = NULL,
    approved_at = NULL, approved_by = NULL, approval_note = NULL, rejection_note = NULL,
    total_amount = greatest(0, subtotal + shipping_cost - promotion_discount - v_discount),
    updated_at = now()
  WHERE id = p_document_id RETURNING * INTO v_doc;
  INSERT INTO public.or_prebill_approval_logs(
    document_id, action, requested_discount, note, actor_id, actor_name
  ) VALUES (p_document_id, 'requested', v_discount, btrim(p_note), auth.uid(), v_name);
  RETURN v_doc;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_convert_prebill_to_order(p_document_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc public.or_prebill_documents;
  v_bill_no TEXT;
  v_order_id UUID;
  v_period TEXT := to_char(timezone('Asia/Bangkok', now()), 'YYMM');
  v_last INTEGER;
  v_promotion_names TEXT;
  v_bill_creator TEXT;
  v_billing_details JSONB;
BEGIN
  SELECT * INTO v_doc FROM public.or_prebill_documents WHERE id = p_document_id FOR UPDATE;
  IF v_doc.id IS NULL OR NOT public.can_manage_prebill_document(v_doc.owner_id) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์';
  END IF;
  IF v_doc.converted_order_id IS NOT NULL OR v_doc.status = 'converted' THEN
    RAISE EXCEPTION 'เอกสารนี้เปิดบิลแล้ว';
  END IF;
  IF v_doc.valid_until < timezone('Asia/Bangkok', now())::DATE THEN
    RAISE EXCEPTION 'เอกสารหมดอายุ กรุณาสร้างเอกสารใหม่';
  END IF;
  IF v_doc.status NOT IN ('active', 'approved') THEN
    RAISE EXCEPTION 'สถานะเอกสารยังไม่พร้อมเปิดบิล';
  END IF;

  SELECT COALESCE(NULLIF(btrim(username), ''), NULLIF(btrim(email), ''), 'unknown')
  INTO v_bill_creator FROM public.us_users WHERE id = auth.uid();
  v_billing_details := COALESCE(v_doc.billing_details, '{}'::jsonb);
  IF NULLIF(btrim(v_doc.customer_phone), '') IS NOT NULL THEN
    v_billing_details := v_billing_details || jsonb_build_object('mobile_phone', btrim(v_doc.customer_phone));
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_doc.channel_code || v_period));
  SELECT COALESCE(max(CASE WHEN right(bill_no, 4) ~ '^[0-9]{4}$'
    THEN right(bill_no, 4)::INTEGER END), 0) INTO v_last
  FROM public.or_orders WHERE bill_no LIKE v_doc.channel_code || v_period || '____';
  v_bill_no := v_doc.channel_code || v_period || lpad((v_last + 1)::TEXT, 4, '0');
  SELECT string_agg(x->>'name', ', ') INTO v_promotion_names
  FROM jsonb_array_elements(v_doc.promotion_snapshot) x;

  INSERT INTO public.or_orders(
    channel_code, bill_no, status, price, shipping_cost, discount, total_amount,
    payment_method, promotion, customer_name, customer_address, recipient_name, admin_user,
    entry_date, billing_details, source_prebill_document_id, prebill_price_locked,
    requires_confirm_design, source_prebill_document_type, source_prebill_owner_name
  ) VALUES (
    v_doc.channel_code, v_bill_no, 'รอลงข้อมูล', v_doc.subtotal, v_doc.shipping_cost,
    v_doc.promotion_discount + v_doc.special_discount, v_doc.total_amount,
    v_doc.payment_method, v_promotion_names, v_doc.customer_name, COALESCE(v_doc.customer_address, ''),
    v_doc.recipient_name, v_bill_creator, timezone('Asia/Bangkok', now())::DATE, v_billing_details,
    v_doc.id, true, false, v_doc.document_type, v_doc.owner_name
  ) RETURNING id INTO v_order_id;

  INSERT INTO public.or_order_items(
    id, order_id, item_uid, product_id, product_name, quantity, unit_price,
    ink_color, product_type, cartoon_pattern, line_pattern, font,
    line_1, line_2, line_3, no_name_line, is_free, notes,
    file_attachment, attachment_name, is_detail_row, parent_item_id
  )
  SELECT i.id, v_order_id, v_bill_no || '-' || row_number() OVER (ORDER BY i.sort_order, i.id),
    i.product_id, i.product_name, i.quantity, CASE WHEN i.is_free THEN 0 ELSE i.unit_price END,
    i.ink_color, i.product_type, i.cartoon_pattern, i.line_pattern, i.font,
    i.line_1, i.line_2, i.line_3, i.no_name_line, i.is_free, i.notes,
    i.file_attachment, i.attachment_name, i.is_detail_row, i.parent_item_id
  FROM public.or_prebill_items i WHERE i.document_id = v_doc.id
  ORDER BY i.sort_order, i.id;

  INSERT INTO public.or_order_promotions(
    order_id, promotion_id, promotion_name_snapshot, promotion_version,
    rule_snapshot, application_count, selected_by
  )
  SELECT v_order_id, p.id,
    COALESCE(NULLIF(snapshot.value->>'name', ''), p.name),
    COALESCE((snapshot.value->>'version')::INTEGER, p.version, 1),
    COALESCE(snapshot.value, to_jsonb(p)),
    GREATEST(COALESCE((snapshot.value->'evaluation'->>'application_count')::INTEGER, 1), 1),
    v_bill_creator
  FROM unnest(v_doc.promotion_ids) AS selected(promotion_id)
  JOIN public.promotion p ON p.id = selected.promotion_id
  LEFT JOIN LATERAL (
    SELECT value FROM jsonb_array_elements(v_doc.promotion_snapshot) value
    WHERE value->>'id' = selected.promotion_id::TEXT LIMIT 1
  ) snapshot ON true
  ON CONFLICT (order_id, promotion_id) DO NOTHING;

  UPDATE public.or_prebill_documents
  SET status = 'converted', converted_order_id = v_order_id,
      converted_at = now(), updated_at = now()
  WHERE id = v_doc.id;

  RETURN jsonb_build_object('order_id', v_order_id, 'bill_no', v_bill_no);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_cancel_prebill_document(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_delete_cancelled_prebill_documents(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_delete_prebill_document(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_request_prebill_discount(UUID, TEXT, NUMERIC, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_convert_prebill_to_order(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_prebill_document(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_delete_cancelled_prebill_documents(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_delete_prebill_document(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_request_prebill_discount(UUID, TEXT, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_convert_prebill_to_order(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
