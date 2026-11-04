BEGIN;

CREATE FUNCTION public.marketplace_correction_errors(p_order_id uuid, p_item_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE v_review jsonb; v_index integer;
BEGIN
  SELECT error_fields INTO v_review FROM public.or_order_reviews
    WHERE order_id=p_order_id AND status='rejected' ORDER BY reviewed_at DESC LIMIT 1;
  v_review:=coalesce(v_review,'{}'::jsonb);
  IF p_item_id IS NULL THEN RETURN v_review; END IF;
  IF jsonb_typeof(v_review->'item_ids')='array' THEN
    SELECT ordinality::integer-1 INTO v_index
      FROM jsonb_array_elements_text(v_review->'item_ids') WITH ORDINALITY
      WHERE value=p_item_id::text;
  ELSE
    SELECT position INTO v_index FROM (
      SELECT id,(row_number() OVER(ORDER BY coalesce(sort_order::bigint,
        substring(item_uid from '-([0-9]+)$')::bigint),created_at,id)-1)::integer AS position
      FROM public.or_order_items WHERE order_id=p_order_id
    ) positions WHERE id=p_item_id;
  END IF;
  RETURN (v_review-'items'-'item_ids') || coalesce(v_review->'items'->v_index,'{}'::jsonb);
END $$;

CREATE FUNCTION public.guard_marketplace_flagged_header()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_errors jsonb; v_key text;
BEGIN
  IF OLD.source_marketplace_order_id IS NULL OR OLD.status<>'ลงข้อมูลผิด' THEN RETURN NEW; END IF;
  v_errors:=public.marketplace_correction_errors(OLD.id);
  FOR v_key IN SELECT key FROM jsonb_each(to_jsonb(NEW)) LOOP
    IF v_key=ANY(ARRAY['status','updated_at','last_edited_by','entry_date','item_uid_sequence']) THEN CONTINUE; END IF;
    IF to_jsonb(NEW)->v_key IS NOT DISTINCT FROM to_jsonb(OLD)->v_key THEN CONTINUE; END IF;
    IF v_key=ANY(ARRAY['tracking_number','express_receipt_number']) AND v_errors->>v_key='true' THEN CONTINUE; END IF;
    RAISE EXCEPTION 'แก้ไขได้เฉพาะฟิลด์ที่ผู้ตรวจระบุผิด: %',v_key;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_marketplace_flagged_header BEFORE UPDATE ON public.or_orders
FOR EACH ROW EXECUTE FUNCTION public.guard_marketplace_flagged_header();

CREATE FUNCTION public.guard_marketplace_flagged_items()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_order public.or_orders; v_errors jsonb; v_key text; v_rule text; v_order_id uuid;
BEGIN
  v_order_id:=CASE WHEN TG_OP='INSERT' THEN NEW.order_id ELSE OLD.order_id END;
  SELECT * INTO v_order FROM public.or_orders WHERE id=v_order_id FOR UPDATE;
  IF v_order.source_marketplace_order_id IS NULL OR v_order.status<>'ลงข้อมูลผิด' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'ไม่สามารถเพิ่มหรือลบรายการสินค้า Marketplace ที่ลงข้อมูลผิดได้'; END IF;
  v_errors:=public.marketplace_correction_errors(OLD.order_id,OLD.id);
  FOR v_key IN SELECT key FROM jsonb_each(to_jsonb(NEW)) LOOP
    IF v_key=ANY(ARRAY['updated_at','sort_order']) THEN CONTINUE; END IF;
    IF to_jsonb(NEW)->v_key IS NOT DISTINCT FROM to_jsonb(OLD)->v_key THEN CONTINUE; END IF;
    v_rule:=CASE v_key WHEN 'product_type' THEN 'layer' WHEN 'line_pattern' THEN 'line_art'
      WHEN 'file_attachment' THEN 'attachment' WHEN 'attachment_name' THEN 'attachment' ELSE v_key END;
    IF v_key=ANY(ARRAY['ink_color','product_type','cartoon_pattern','line_pattern','font',
      'line_1','line_2','line_3','notes','file_attachment','attachment_name']) AND v_errors->>v_rule='true' THEN CONTINUE; END IF;
    RAISE EXCEPTION 'แก้ไขได้เฉพาะฟิลด์รายการสินค้าที่ผู้ตรวจระบุผิด: %',v_key;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_marketplace_flagged_items BEFORE INSERT OR UPDATE OR DELETE ON public.or_order_items
FOR EACH ROW EXECUTE FUNCTION public.guard_marketplace_flagged_items();

COMMIT;
