-- Persist bill order independently of stable item identity.
ALTER TABLE public.or_orders ADD COLUMN IF NOT EXISTS item_uid_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE public.or_order_items ADD COLUMN IF NOT EXISTS sort_order integer;
WITH positions AS (
  SELECT id, row_number() OVER (PARTITION BY order_id ORDER BY
    substring(item_uid from '-([0-9]+)$')::bigint NULLS LAST, created_at, id)::integer AS position
  FROM public.or_order_items
)
UPDATE public.or_order_items i SET sort_order=p.position FROM positions p
WHERE i.id=p.id AND i.sort_order IS NULL;

CREATE OR REPLACE FUNCTION public.rpc_save_order_items(p_order_id uuid,p_items jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE x jsonb; r record; v_item public.or_order_items; v_existing public.or_order_items; v_position integer := 0; v_sequence bigint; v_bill_no text;
BEGIN
  PERFORM 1 FROM public.or_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบหรือไม่มีสิทธิ์แก้ไขบิล'; END IF;
  IF jsonb_typeof(p_items)<>'array' THEN RAISE EXCEPTION 'รายการสินค้าไม่ถูกต้อง'; END IF;
  PERFORM set_config('app.reservation_save','order:'||p_order_id::text,true);
  FOR r IN SELECT product_id FROM public.or_order_items WHERE order_id=p_order_id AND product_id IS NOT NULL
    UNION SELECT (value->>'product_id')::uuid FROM jsonb_array_elements(p_items) WHERE value->>'product_id' IS NOT NULL ORDER BY product_id
  LOOP PERFORM 1 FROM public.inv_stock_balances WHERE product_id=r.product_id FOR UPDATE; END LOOP;
  SELECT bill_no INTO v_bill_no FROM public.or_orders WHERE id=p_order_id;
  SELECT greatest(coalesce(max(substring(item_uid from '-([0-9]+)$')::bigint),0),
    (SELECT item_uid_sequence FROM public.or_orders WHERE id=p_order_id)) INTO v_sequence
    FROM public.or_order_items WHERE order_id=p_order_id;
  DELETE FROM public.or_order_items i WHERE order_id=p_order_id
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) candidate WHERE (candidate.value->>'id')::uuid=i.id);
  FOR x IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_position := v_position + 1;
    x := x || jsonb_build_object('sort_order',v_position);
    SELECT * INTO v_existing FROM public.or_order_items WHERE id=(x->>'id')::uuid AND order_id=p_order_id;
    IF FOUND THEN
      v_item:=jsonb_populate_record(v_existing,x||jsonb_build_object('order_id',p_order_id,'item_uid',v_existing.item_uid));
      UPDATE public.or_order_items SET product_id=v_item.product_id,product_name=v_item.product_name,quantity=v_item.quantity,
        sort_order=v_item.sort_order,item_uid=v_item.item_uid,is_detail_row=v_item.is_detail_row,parent_item_id=v_item.parent_item_id,unit_price=v_item.unit_price,
        ink_color=v_item.ink_color,product_type=v_item.product_type,cartoon_pattern=v_item.cartoon_pattern,line_pattern=v_item.line_pattern,
        font=v_item.font,line_1=v_item.line_1,line_2=v_item.line_2,line_3=v_item.line_3,no_name_line=v_item.no_name_line,
        is_free=v_item.is_free,notes=v_item.notes,file_attachment=v_item.file_attachment,attachment_name=v_item.attachment_name
      WHERE id=v_item.id AND order_id=p_order_id;
    ELSE
      v_sequence := v_sequence + 1;
      IF v_bill_no IS NOT NULL THEN
        x := x || jsonb_build_object('item_uid',v_bill_no||'-'||v_sequence);
      END IF;
      v_item:=jsonb_populate_record(NULL::public.or_order_items,
        jsonb_build_object('created_at',now(),'updated_at',now())||x||jsonb_build_object('order_id',p_order_id));
      INSERT INTO public.or_order_items SELECT (v_item).*;
    END IF;
  END LOOP;
  PERFORM set_config('app.reservation_save','',true);
  UPDATE public.or_orders SET updated_at=now(),item_uid_sequence=v_sequence WHERE id=p_order_id;
END $$;


-- Direct inserts (imports and converted prebills) also persist their UID order.
CREATE OR REPLACE FUNCTION public.set_bill_item_initial_sort_order()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.sort_order IS NULL THEN
    NEW.sort_order := substring(NEW.item_uid from '-([0-9]+)$')::integer;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_bill_item_initial_sort_order ON public.or_order_items;
CREATE TRIGGER trg_bill_item_initial_sort_order BEFORE INSERT ON public.or_order_items
FOR EACH ROW EXECUTE FUNCTION public.set_bill_item_initial_sort_order();
