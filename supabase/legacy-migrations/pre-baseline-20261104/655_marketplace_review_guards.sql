BEGIN;

ALTER TABLE public.or_orders ADD COLUMN source_marketplace_order_id uuid
  REFERENCES public.mp_orders(id) ON DELETE RESTRICT;
ALTER TABLE public.or_order_items ADD COLUMN source_mp_order_item_id uuid
  REFERENCES public.mp_order_items(id) ON DELETE SET NULL;
CREATE INDEX or_orders_source_marketplace_idx ON public.or_orders(source_marketplace_order_id)
  WHERE source_marketplace_order_id IS NOT NULL;

UPDATE public.or_orders o SET source_marketplace_order_id=m.id
FROM public.mp_orders m WHERE m.billed_order_id=o.id;

-- Legacy metadata is linked only when the original UID position and product agree.
UPDATE public.or_order_items i SET source_mp_order_item_id=d.id
FROM public.or_orders o, public.mp_order_items d
WHERE i.order_id=o.id AND d.mp_order_id=o.source_marketplace_order_id
  AND i.product_id=d.product_id
  AND substring(i.item_uid from '-([0-9]+)$')::bigint=d.line_index+1;

CREATE FUNCTION public.marketplace_product_field_enabled(p_product_id uuid, p_field text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(
    CASE WHEN p_field=ANY(coalesce(ov.required_fields,'{}'::text[])) THEN true
         ELSE (to_jsonb(ov)->>p_field)::boolean END,
    (to_jsonb(c)->>p_field)::boolean, true)
  FROM public.pr_products p
  LEFT JOIN public.pr_product_field_overrides ov ON ov.product_id=p.id
  LEFT JOIN public.pr_category_field_settings c ON c.category=btrim(p.product_category)
  WHERE p.id=p_product_id
$$;

CREATE FUNCTION public.guard_marketplace_review_order()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.source_marketplace_order_id IS NOT NULL AND OLD.status='รอตรวจคำสั่งซื้อ'
       AND EXISTS(SELECT 1 FROM public.mp_orders WHERE billed_order_id=OLD.id) THEN
      RAISE EXCEPTION 'บิล Marketplace อยู่ระหว่างรอตรวจคำสั่งซื้อ ไม่สามารถลบบิลได้';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.source_marketplace_order_id IS NOT NULL THEN
    IF NEW.source_marketplace_order_id IS DISTINCT FROM OLD.source_marketplace_order_id THEN
      RAISE EXCEPTION 'ไม่สามารถเปลี่ยนที่มาของบิล Marketplace';
    END IF;
    IF OLD.status='รอตรวจคำสั่งซื้อ' AND
       (to_jsonb(NEW)-ARRAY['status','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','updated_at']) THEN
      RAISE EXCEPTION 'บิล Marketplace อยู่ระหว่างรอตรวจคำสั่งซื้อ กรุณาตีกลับก่อนแก้ไขข้อมูล';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_guard_marketplace_review_order BEFORE UPDATE OR DELETE ON public.or_orders
FOR EACH ROW EXECUTE FUNCTION public.guard_marketplace_review_order();

CREATE FUNCTION public.guard_marketplace_order_item()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_order public.or_orders; v_id uuid;
BEGIN
  -- Check both parents when an item is moved, and serialize against review transitions.
  FOR v_id IN SELECT DISTINCT id FROM unnest(ARRAY[
    CASE WHEN TG_OP<>'INSERT' THEN OLD.order_id END,
    CASE WHEN TG_OP<>'DELETE' THEN NEW.order_id END]) AS parents(id)
    WHERE id IS NOT NULL ORDER BY id
  LOOP
    SELECT * INTO v_order FROM public.or_orders WHERE id=v_id FOR UPDATE;
    IF v_order.source_marketplace_order_id IS NOT NULL
       AND v_order.status='รอตรวจคำสั่งซื้อ'
       AND EXISTS(SELECT 1 FROM public.mp_orders WHERE id=v_order.source_marketplace_order_id AND billed_order_id=v_id) THEN
      RAISE EXCEPTION 'บิล Marketplace อยู่ระหว่างรอตรวจคำสั่งซื้อ กรุณาตีกลับก่อนแก้ไขรายการ';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  SELECT * INTO v_order FROM public.or_orders WHERE id=NEW.order_id;
  IF v_order.source_marketplace_order_id IS NULL THEN RETURN NEW; END IF;
  IF NOT coalesce(public.marketplace_product_field_enabled(NEW.product_id,'ink_color'),true) THEN NEW.ink_color:=NULL; END IF;
  IF NOT coalesce(public.marketplace_product_field_enabled(NEW.product_id,'layer'),true) THEN NEW.product_type:=NULL; END IF;
  IF NOT coalesce(public.marketplace_product_field_enabled(NEW.product_id,'cartoon_pattern'),true) THEN NEW.cartoon_pattern:=NULL; END IF;
  IF NOT coalesce(public.marketplace_product_field_enabled(NEW.product_id,'line_pattern'),true) THEN NEW.line_pattern:=NULL; END IF;
  IF NOT coalesce(public.marketplace_product_field_enabled(NEW.product_id,'font'),true) THEN NEW.font:=NULL; END IF;
  IF NOT coalesce(public.marketplace_product_field_enabled(NEW.product_id,'line_1'),true)
     AND NOT coalesce(public.marketplace_product_field_enabled(NEW.product_id,'line_2'),true)
     AND NOT coalesce(public.marketplace_product_field_enabled(NEW.product_id,'line_3'),true) THEN NEW.no_name_line:=false; END IF;
  IF NEW.no_name_line OR NOT coalesce(public.marketplace_product_field_enabled(NEW.product_id,'line_1'),true) THEN NEW.line_1:=NULL; END IF;
  IF NEW.no_name_line OR NOT coalesce(public.marketplace_product_field_enabled(NEW.product_id,'line_2'),true) THEN NEW.line_2:=NULL; END IF;
  IF NEW.no_name_line OR NOT coalesce(public.marketplace_product_field_enabled(NEW.product_id,'line_3'),true) THEN NEW.line_3:=NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_guard_marketplace_order_item BEFORE INSERT OR UPDATE OR DELETE ON public.or_order_items
FOR EACH ROW EXECUTE FUNCTION public.guard_marketplace_order_item();

-- Older clients also acquire the source marker when finalizing their Marketplace bill.
CREATE FUNCTION public.link_marketplace_bill_source()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.billed_order_id IS NOT NULL THEN
    UPDATE public.or_orders SET source_marketplace_order_id=NEW.id
    WHERE id=NEW.billed_order_id AND source_marketplace_order_id IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_link_marketplace_bill_source AFTER INSERT OR UPDATE OF billed_order_id ON public.mp_orders
FOR EACH ROW EXECUTE FUNCTION public.link_marketplace_bill_source();

COMMIT;
