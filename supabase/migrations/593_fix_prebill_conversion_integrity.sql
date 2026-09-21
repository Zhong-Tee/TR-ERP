-- Preserve QT/PC customer, promotion, discount and ownership data when converting
-- to a real order. Also make converted/cancelled source documents immutable.

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

  -- Once converted/cancelled, no role (including superadmin) may alter document
  -- content. The FK may still clear converted_order_id if the target order is
  -- removed, so that system-maintained field is deliberately excluded.
  IF OLD.status IN ('converted', 'cancelled') THEN
    IF (to_jsonb(NEW) - ARRAY['converted_order_id', 'updated_at'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['converted_order_id', 'updated_at']) THEN
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
    IF NEW.special_discount IS DISTINCT FROM OLD.special_discount AND NEW.status <> 'pending_discount' THEN
      RAISE EXCEPTION 'ส่วนลดพิเศษต้องส่งคำขออนุมัติ';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status IN ('draft', 'active', 'rejected') AND NEW.status IN ('draft', 'active'))
      OR (OLD.status IN ('draft', 'active', 'rejected') AND NEW.status = 'pending_discount'
          AND NEW.discount_requested_by = auth.uid() AND btrim(COALESCE(NEW.discount_request_note, '')) <> '')
      OR (OLD.status IN ('active', 'approved') AND NEW.status = 'converted' AND NEW.converted_order_id IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'ไม่มีสิทธิ์เปลี่ยนสถานะเอกสาร';
    END IF;
  END IF;
  IF v_role <> 'superadmin' AND OLD.status IN ('pending_discount', 'approved')
     AND NOT (OLD.status = 'approved' AND NEW.status = 'converted' AND NEW.converted_order_id IS NOT NULL) THEN
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
      WHERE d.id IN (OLD.document_id, NEW.document_id) AND d.status IN ('converted', 'cancelled')
    ) INTO v_locked;
  END IF;

  IF v_locked THEN
    RAISE EXCEPTION 'รายการของเอกสารที่เปิดบิลหรือยกเลิกแล้วแก้ไขไม่ได้';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_prebill_item_write ON public.or_prebill_items;
CREATE TRIGGER trg_guard_prebill_item_write
BEFORE INSERT OR UPDATE OR DELETE ON public.or_prebill_items
FOR EACH ROW EXECUTE FUNCTION public.guard_prebill_item_write();

CREATE OR REPLACE FUNCTION public.rpc_convert_prebill_to_order(p_document_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc public.or_prebill_documents;
  v_role TEXT;
  v_bill_no TEXT;
  v_order_id UUID;
  v_period TEXT := to_char(timezone('Asia/Bangkok', now()), 'YYMM');
  v_last INTEGER;
  v_promotion_names TEXT;
  v_owner_admin TEXT;
  v_billing_details JSONB;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  SELECT * INTO v_doc FROM public.or_prebill_documents WHERE id = p_document_id FOR UPDATE;
  IF v_doc.id IS NULL OR (v_role <> 'superadmin' AND v_doc.owner_id <> auth.uid()) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์'; END IF;
  IF v_doc.converted_order_id IS NOT NULL OR v_doc.status = 'converted' THEN RAISE EXCEPTION 'เอกสารนี้เปิดบิลแล้ว'; END IF;
  IF v_doc.valid_until < timezone('Asia/Bangkok', now())::DATE THEN RAISE EXCEPTION 'เอกสารหมดอายุ กรุณาสร้างเอกสารใหม่'; END IF;
  IF v_doc.status NOT IN ('active', 'approved') THEN RAISE EXCEPTION 'สถานะเอกสารยังไม่พร้อมเปิดบิล'; END IF;

  SELECT COALESCE(NULLIF(btrim(u.username), ''), NULLIF(btrim(u.email), ''), v_doc.owner_name)
  INTO v_owner_admin
  FROM public.us_users u
  WHERE u.id = v_doc.owner_id;
  v_owner_admin := COALESCE(v_owner_admin, v_doc.owner_name);

  v_billing_details := COALESCE(v_doc.billing_details, '{}'::jsonb);
  IF NULLIF(btrim(v_doc.customer_phone), '') IS NOT NULL THEN
    v_billing_details := v_billing_details || jsonb_build_object('mobile_phone', btrim(v_doc.customer_phone));
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_doc.channel_code || v_period));
  SELECT COALESCE(max(CASE WHEN right(bill_no, 4) ~ '^[0-9]{4}$' THEN right(bill_no, 4)::INTEGER END), 0) INTO v_last
  FROM public.or_orders
  WHERE bill_no LIKE v_doc.channel_code || v_period || '____';
  v_bill_no := v_doc.channel_code || v_period || lpad((v_last + 1)::TEXT, 4, '0');
  SELECT string_agg(x->>'name', ', ') INTO v_promotion_names
  FROM jsonb_array_elements(v_doc.promotion_snapshot) x;

  INSERT INTO public.or_orders(
    channel_code, bill_no, status, price, shipping_cost, discount, total_amount,
    payment_method, promotion, customer_name, customer_address, recipient_name, admin_user,
    entry_date, billing_details, source_prebill_document_id, prebill_price_locked
  ) VALUES (
    v_doc.channel_code, v_bill_no, 'รอลงข้อมูล', v_doc.subtotal, v_doc.shipping_cost,
    v_doc.promotion_discount + v_doc.special_discount, v_doc.total_amount,
    v_doc.payment_method, v_promotion_names, v_doc.customer_name, COALESCE(v_doc.customer_address, ''),
    v_doc.recipient_name, v_owner_admin, timezone('Asia/Bangkok', now())::DATE, v_billing_details,
    v_doc.id, true
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
  FROM public.or_prebill_items i WHERE i.document_id = v_doc.id ORDER BY i.sort_order, i.id;

  INSERT INTO public.or_order_promotions(
    order_id, promotion_id, promotion_name_snapshot, promotion_version,
    rule_snapshot, application_count, selected_by
  )
  SELECT v_order_id, p.id,
    COALESCE(NULLIF(snapshot.value->>'name', ''), p.name),
    COALESCE((snapshot.value->>'version')::INTEGER, p.version, 1),
    COALESCE(snapshot.value, to_jsonb(p)),
    GREATEST(COALESCE((snapshot.value->'evaluation'->>'application_count')::INTEGER, 1), 1),
    v_owner_admin
  FROM unnest(v_doc.promotion_ids) AS selected(promotion_id)
  JOIN public.promotion p ON p.id = selected.promotion_id
  LEFT JOIN LATERAL (
    SELECT value
    FROM jsonb_array_elements(v_doc.promotion_snapshot) value
    WHERE value->>'id' = selected.promotion_id::TEXT
    LIMIT 1
  ) snapshot ON true
  ON CONFLICT (order_id, promotion_id) DO NOTHING;

  UPDATE public.or_prebill_documents
  SET status = 'converted', converted_order_id = v_order_id, converted_at = now(), updated_at = now()
  WHERE id = v_doc.id;

  RETURN jsonb_build_object('order_id', v_order_id, 'bill_no', v_bill_no);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_convert_prebill_to_order(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_convert_prebill_to_order(UUID) TO authenticated;

-- Repair already-converted draft orders without changing their approved totals.
UPDATE public.or_orders o
SET recipient_name = COALESCE(NULLIF(o.recipient_name, ''), d.recipient_name),
    billing_details = CASE
      WHEN NULLIF(btrim(d.customer_phone), '') IS NULL THEN o.billing_details
      ELSE COALESCE(o.billing_details, '{}'::jsonb) || jsonb_build_object('mobile_phone', btrim(d.customer_phone))
    END,
    admin_user = CASE
      WHEN NULLIF(btrim(o.admin_user), '') IS NULL OR o.admin_user = d.owner_name
        THEN COALESCE(NULLIF(btrim(u.username), ''), NULLIF(btrim(u.email), ''), d.owner_name)
      ELSE o.admin_user
    END
FROM public.or_prebill_documents d
LEFT JOIN public.us_users u ON u.id = d.owner_id
WHERE o.source_prebill_document_id = d.id
  AND d.status = 'converted';

INSERT INTO public.or_order_promotions(
  order_id, promotion_id, promotion_name_snapshot, promotion_version,
  rule_snapshot, application_count, selected_by
)
SELECT o.id, p.id,
  COALESCE(NULLIF(snapshot.value->>'name', ''), p.name),
  COALESCE((snapshot.value->>'version')::INTEGER, p.version, 1),
  COALESCE(snapshot.value, to_jsonb(p)),
  GREATEST(COALESCE((snapshot.value->'evaluation'->>'application_count')::INTEGER, 1), 1),
  COALESCE(NULLIF(btrim(u.username), ''), NULLIF(btrim(u.email), ''), d.owner_name)
FROM public.or_prebill_documents d
JOIN public.or_orders o ON o.source_prebill_document_id = d.id
JOIN LATERAL unnest(d.promotion_ids) AS selected(promotion_id) ON true
JOIN public.promotion p ON p.id = selected.promotion_id
LEFT JOIN public.us_users u ON u.id = d.owner_id
LEFT JOIN LATERAL (
  SELECT value
  FROM jsonb_array_elements(d.promotion_snapshot) value
  WHERE value->>'id' = selected.promotion_id::TEXT
  LIMIT 1
) snapshot ON true
WHERE d.status = 'converted'
ON CONFLICT (order_id, promotion_id) DO NOTHING;
