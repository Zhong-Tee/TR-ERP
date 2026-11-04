-- New documents opt in; existing documents retain the legacy WMS reservation flow.
-- No FIFO lots or physical balances are backfilled by this migration.
-- Rollout: back up and reconcile existing reserved/WMS/borrow balances first.
-- Apply on staging with pg_cron enabled, then briefly pause bill/pick writes,
-- apply migration, deploy client, and refresh all open clients before resuming.
-- Existing documents intentionally stay legacy; do not mass-enable them.
-- Rollback requires releasing new document holds before restoring legacy code;
-- simply dropping these triggers would leave reserved balances stranded.
BEGIN;
ALTER TABLE public.or_orders ADD COLUMN stock_reservation_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.or_orders ALTER COLUMN stock_reservation_enabled SET DEFAULT true;
ALTER TABLE public.or_prebill_documents ADD COLUMN stock_reservation_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.or_prebill_documents ALTER COLUMN stock_reservation_enabled SET DEFAULT true;

CREATE TABLE public.inv_document_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL CHECK (source_type IN ('prebill','order')),
  source_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.pr_products(id),
  qty numeric NOT NULL DEFAULT 0 CHECK(qty >= 0),
  expires_on date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_type,source_id,product_id)
);
CREATE INDEX ON public.inv_document_reservations(product_id) WHERE qty > 0;
CREATE TABLE public.inv_document_reservation_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reservation_id uuid NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  product_id uuid NOT NULL,
  old_qty numeric NOT NULL,
  new_qty numeric NOT NULL,
  actor_id uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.inv_document_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_document_reservation_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY reservation_read ON public.inv_document_reservations FOR SELECT TO authenticated USING(true);
CREATE POLICY reservation_history_read ON public.inv_document_reservation_history FOR SELECT TO authenticated
USING (public.check_user_role(auth.uid(),ARRAY['superadmin','admin','store','manager']));
REVOKE ALL ON public.inv_document_reservations,public.inv_document_reservation_history FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.inv_document_reservations,public.inv_document_reservation_history TO authenticated;

CREATE FUNCTION public.fn_set_document_reservation(p_type text,p_source uuid,p_product uuid,p_qty numeric,p_expires date DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_old numeric; v_available numeric; v_id uuid;
BEGIN
  INSERT INTO public.inv_stock_balances(product_id,on_hand,reserved,safety_stock)
  VALUES(p_product,0,0,0) ON CONFLICT(product_id) DO NOTHING;
  SELECT coalesce(on_hand,0)-coalesce(reserved,0) INTO v_available
  FROM public.inv_stock_balances WHERE product_id=p_product FOR UPDATE;
  SELECT qty,id INTO v_old,v_id FROM public.inv_document_reservations
  WHERE source_type=p_type AND source_id=p_source AND product_id=p_product FOR UPDATE;
  v_old:=coalesce(v_old,0);
  IF p_qty > v_old AND p_qty-v_old > v_available THEN
    RAISE EXCEPTION 'สต๊อกพร้อมขายไม่พอสำหรับจองสินค้า %: เพิ่มจอง % แต่พร้อมขาย %',p_product,p_qty-v_old,v_available;
  END IF;
  INSERT INTO public.inv_document_reservations(source_type,source_id,product_id,qty,expires_on)
  VALUES(p_type,p_source,p_product,p_qty,p_expires)
  ON CONFLICT(source_type,source_id,product_id) DO UPDATE
  SET qty=excluded.qty,expires_on=excluded.expires_on,updated_at=now()
  RETURNING id INTO v_id;
  IF p_qty <> v_old THEN
    UPDATE public.inv_stock_balances SET reserved=coalesce(reserved,0)+p_qty-v_old,updated_at=now() WHERE product_id=p_product;
    INSERT INTO public.inv_document_reservation_history(reservation_id,source_type,source_id,product_id,old_qty,new_qty)
    VALUES(v_id,p_type,p_source,p_product,v_old,p_qty);
  END IF;
END $$;

CREATE FUNCTION public.fn_sync_document_reservations(p_type text,p_source uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_enabled boolean; v_status text; v_exp date; v_qty numeric; v_claim_ready boolean:=true;
BEGIN
  IF current_setting('app.reservation_save',true)=p_type||':'||p_source::text THEN RETURN; END IF;
  IF p_type='prebill' THEN
    SELECT stock_reservation_enabled,status,valid_until INTO v_enabled,v_status,v_exp
    FROM public.or_prebill_documents WHERE id=p_source FOR UPDATE;
  ELSE
    SELECT stock_reservation_enabled,status,(bill_no NOT LIKE 'REQ%' OR claim_shipping_confirmed_at IS NOT NULL) INTO v_enabled,v_status,v_claim_ready FROM public.or_orders WHERE id=p_source FOR UPDATE;
  END IF;
  IF NOT coalesce(v_enabled,false) AND NOT EXISTS(SELECT 1 FROM public.inv_document_reservations WHERE source_type=p_type AND source_id=p_source AND qty>0) THEN RETURN; END IF;
  FOR r IN
    SELECT product_id FROM public.inv_document_reservations WHERE source_type=p_type AND source_id=p_source
    UNION SELECT product_id FROM public.or_prebill_items WHERE p_type='prebill' AND document_id=p_source AND product_id IS NOT NULL
    UNION SELECT product_id FROM public.or_order_items WHERE p_type='order' AND order_id=p_source AND product_id IS NOT NULL
    ORDER BY product_id
  LOOP
    v_qty:=0;
    IF v_enabled AND p_type='prebill' AND v_status IN ('active','pending_discount','approved','rejected')
       AND v_exp >= timezone('Asia/Bangkok',now())::date THEN
      SELECT coalesce(sum(quantity),0) INTO v_qty FROM public.or_prebill_items
      WHERE document_id=p_source AND product_id=r.product_id AND NOT coalesce(is_detail_row,false);
    ELSIF v_enabled AND v_claim_ready AND p_type='order' AND v_status NOT IN ('ยกเลิก','จัดส่งแล้ว') THEN
      SELECT coalesce(sum(greatest(i.quantity-coalesce(w.covered,0),0)),0) INTO v_qty
      FROM public.or_order_items i
      LEFT JOIN LATERAL (
        SELECT sum(greatest(coalesce(m.net_deducted,0),CASE WHEN x.status IN ('picked','cancelled') THEN x.qty ELSE 0 END)) AS covered
        FROM public.wms_orders x
        LEFT JOIN LATERAL (SELECT greatest(coalesce(sum(-sm.qty),0),0) AS net_deducted FROM public.inv_stock_movements sm
          WHERE sm.ref_type='wms_orders' AND sm.ref_id=x.id AND sm.movement_type IN ('pick','pick_reversal')) m ON true
        WHERE x.source_order_item_id=i.id
      ) w ON true
      WHERE i.order_id=p_source AND i.product_id=r.product_id
        AND NOT coalesce(i.is_detail_row,false) AND i.cancellation_stock_action IS NULL;
    END IF;
    PERFORM public.fn_set_document_reservation(p_type,p_source,r.product_id,v_qty,v_exp);
  END LOOP;
END $$;

CREATE FUNCTION public.fn_document_reservation_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_type text; v_old uuid; v_new uuid;
BEGIN
  v_type:=CASE WHEN TG_TABLE_NAME LIKE 'or_prebill%' THEN 'prebill' ELSE 'order' END;
  IF TG_OP <> 'INSERT' THEN
    v_old:=CASE WHEN TG_TABLE_NAME IN ('or_orders','or_prebill_documents') THEN OLD.id
      WHEN v_type='prebill' THEN (to_jsonb(OLD)->>'document_id')::uuid ELSE (to_jsonb(OLD)->>'order_id')::uuid END;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new:=CASE WHEN TG_TABLE_NAME IN ('or_orders','or_prebill_documents') THEN NEW.id
      WHEN v_type='prebill' THEN (to_jsonb(NEW)->>'document_id')::uuid ELSE (to_jsonb(NEW)->>'order_id')::uuid END;
  END IF;
  IF v_old IS NOT NULL AND v_old IS DISTINCT FROM v_new THEN PERFORM public.fn_sync_document_reservations(v_type,v_old); END IF;
  IF v_new IS NOT NULL THEN PERFORM public.fn_sync_document_reservations(v_type,v_new); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER zzz_document_reservation AFTER INSERT OR UPDATE OR DELETE ON public.or_prebill_documents FOR EACH ROW EXECUTE FUNCTION public.fn_document_reservation_changed();
CREATE TRIGGER zzz_document_reservation AFTER INSERT OR UPDATE OR DELETE ON public.or_prebill_items FOR EACH ROW EXECUTE FUNCTION public.fn_document_reservation_changed();
CREATE TRIGGER zzz_document_reservation AFTER INSERT OR UPDATE OR DELETE ON public.or_orders FOR EACH ROW EXECUTE FUNCTION public.fn_document_reservation_changed();
CREATE TRIGGER zzz_document_reservation AFTER INSERT OR UPDATE OR DELETE ON public.or_order_items FOR EACH ROW EXECUTE FUNCTION public.fn_document_reservation_changed();

-- Transfer from document reservation to the existing WMS reservation/deduction
-- inside the same transaction, before the original AFTER status trigger runs.
CREATE FUNCTION public.fn_transfer_document_reservation_to_wms()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_order uuid; v_product uuid; v_qty numeric;
BEGIN
  IF NEW.status NOT IN ('picked','correct') OR NEW.status IS NOT DISTINCT FROM OLD.status
     OR OLD.status IN ('picked','correct') OR NEW.source_order_item_id IS NULL THEN RETURN NEW; END IF;
  SELECT i.order_id,i.product_id INTO v_order,v_product FROM public.or_order_items i
  JOIN public.or_orders o ON o.id=i.order_id AND o.stock_reservation_enabled
  WHERE i.id=NEW.source_order_item_id AND NOT coalesce(i.is_detail_row,false);
  IF v_product IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.or_orders WHERE id=v_order FOR UPDATE;
  PERFORM 1 FROM public.inv_stock_balances WHERE product_id=v_product FOR UPDATE;
  SELECT qty INTO v_qty FROM public.inv_document_reservations WHERE source_type='order' AND source_id=v_order AND product_id=v_product;
  PERFORM public.fn_set_document_reservation('order',v_order,v_product,greatest(coalesce(v_qty,0)-NEW.qty,0));
  RETURN NEW;
END $$;
CREATE TRIGGER aa_transfer_document_reservation BEFORE UPDATE OF status ON public.wms_orders FOR EACH ROW EXECUTE FUNCTION public.fn_transfer_document_reservation_to_wms();
CREATE FUNCTION public.fn_sync_wms_document_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_source uuid;
BEGIN
  v_source:=coalesce(NEW.source_order_id,OLD.source_order_id);
  IF v_source IS NULL THEN
    SELECT order_id INTO v_source FROM public.or_order_items WHERE id=coalesce(NEW.source_order_item_id,OLD.source_order_item_id);
  END IF;
  IF v_source IS NOT NULL THEN PERFORM public.fn_sync_document_reservations('order',v_source); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER zzz_sync_wms_document_reservation AFTER UPDATE OR DELETE ON public.wms_orders FOR EACH ROW EXECUTE FUNCTION public.fn_sync_wms_document_reservation();

CREATE FUNCTION public.fn_expire_document_reservations()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT source_id FROM public.inv_document_reservations
    WHERE source_type='prebill' AND qty>0 AND expires_on < timezone('Asia/Bangkok',now())::date ORDER BY source_id
  LOOP PERFORM public.fn_sync_document_reservations('prebill',r.source_id); END LOOP;
END $$;

-- Keep legacy stock guard semantics for old documents. New document reservations
-- already include other lines; credit this order's own hold during editing.
CREATE OR REPLACE FUNCTION public.fn_guard_or_order_items_stock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_available numeric; v_own numeric; v_other numeric; v_enabled boolean; v_source uuid;
BEGIN
  IF NEW.product_id IS NULL OR coalesce(NEW.is_detail_row,false) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id AND NEW.quantity=OLD.quantity THEN RETURN NEW; END IF;
  PERFORM public.fn_expire_document_reservations();
  SELECT stock_reservation_enabled,source_prebill_document_id INTO v_enabled,v_source FROM public.or_orders WHERE id=NEW.order_id FOR UPDATE;
  IF v_enabled THEN RETURN NEW; END IF;
  -- Legacy documents retain the previous validation.
  INSERT INTO public.inv_stock_balances(product_id,on_hand,reserved,safety_stock) VALUES(NEW.product_id,0,0,0) ON CONFLICT(product_id) DO NOTHING;
  SELECT coalesce(on_hand,0)-coalesce(reserved,0) INTO v_available FROM public.inv_stock_balances WHERE product_id=NEW.product_id FOR UPDATE;
  SELECT coalesce(sum(qty),0) INTO v_own FROM public.inv_document_reservations WHERE source_type='order' AND source_id=NEW.order_id AND product_id=NEW.product_id;
  SELECT coalesce(sum(quantity),0) INTO v_other FROM public.or_order_items
  WHERE order_id=NEW.order_id AND product_id=NEW.product_id AND NOT coalesce(is_detail_row,false)
    AND cancellation_stock_action IS NULL AND (TG_OP='INSERT' OR id<>OLD.id);
  IF v_other+NEW.quantity > v_available THEN
    RAISE EXCEPTION 'สต๊อกพร้อมขายไม่เพียงพอ: ต้องการ % แต่พร้อมขาย %',v_other+NEW.quantity,v_available;
  END IF;
  RETURN NEW;
END $$;
-- Before conversion item insert, release prebill in the SAME transaction.
CREATE FUNCTION public.fn_transfer_prebill_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record;
BEGIN
  IF NEW.source_prebill_document_id IS NOT NULL AND NEW.stock_reservation_enabled THEN
    PERFORM 1 FROM public.or_prebill_documents WHERE id=NEW.source_prebill_document_id
      AND status IN ('active','approved') AND valid_until>=timezone('Asia/Bangkok',now())::date
      AND public.can_manage_prebill_document(owner_id) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'เอกสารต้นทางไม่พร้อมเปิดบิลหรือไม่มีสิทธิ์'; END IF;
    FOR r IN SELECT product_id FROM public.inv_document_reservations
      WHERE source_type='prebill' AND source_id=NEW.source_prebill_document_id AND qty>0 ORDER BY product_id
    LOOP PERFORM public.fn_set_document_reservation('prebill',NEW.source_prebill_document_id,r.product_id,0); END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aa_transfer_prebill AFTER INSERT ON public.or_orders FOR EACH ROW EXECUTE FUNCTION public.fn_transfer_prebill_reservations();

-- Do not orphan WMS holds or change physical quantities after assignment.
CREATE FUNCTION public.fn_guard_reserved_order_item_links()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.or_orders WHERE id=OLD.order_id AND stock_reservation_enabled)
     AND EXISTS(SELECT 1 FROM public.wms_orders WHERE source_order_item_id=OLD.id
       AND (status NOT IN ('returned','cancelled') OR (status='cancelled' AND stock_action IS NULL)))
     AND (TG_OP='DELETE' OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.quantity IS DISTINCT FROM OLD.quantity) THEN
    RAISE EXCEPTION 'รายการนี้เชื่อมงานหยิบแล้ว กรุณาใช้ขั้นตอนแก้ไข/ยกเลิกบิลและจัดการสต๊อกก่อน';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aa_guard_reserved_order_item_links BEFORE UPDATE OR DELETE ON public.or_order_items
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_reserved_order_item_links();
REVOKE ALL ON FUNCTION public.fn_guard_reserved_order_item_links() FROM PUBLIC,anon,authenticated;

-- Atomic QT/PC save under caller RLS; payload cannot opt out of reservation.
CREATE FUNCTION public.rpc_save_prebill_document(p_id uuid,p_document jsonb,p_items jsonb)
RETURNS public.or_prebill_documents LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE v_doc public.or_prebill_documents; v_item public.or_prebill_items; x jsonb; r record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'กรุณาเข้าสู่ระบบ'; END IF;
  IF jsonb_typeof(p_items)<>'array' THEN RAISE EXCEPTION 'รายการสินค้าไม่ถูกต้อง'; END IF;
  IF p_id IS NOT NULL THEN
    SELECT * INTO STRICT v_doc FROM public.or_prebill_documents WHERE id=p_id FOR UPDATE;
  ELSE
    v_doc:=jsonb_populate_record(NULL::public.or_prebill_documents,
      jsonb_build_object('id',gen_random_uuid(),'status','draft','owner_id',auth.uid(),'special_discount_value',0,
      'stock_reservation_enabled',true,'created_at',now(),'updated_at',now()));
  END IF;
  IF v_doc.status IN ('converted','cancelled') THEN RAISE EXCEPTION 'เอกสารนี้แก้ไขไม่ได้'; END IF;
  PERFORM set_config('app.reservation_save','prebill:'||v_doc.id::text,true);
  p_document:=p_document-'id'-'stock_reservation_enabled'-'converted_order_id'-'converted_at'-'approved_at'-'approved_by'-'approved_special_discount';
  v_doc:=jsonb_populate_record(v_doc,p_document);
  -- Lock products in a consistent order before replacing any rows.
  FOR r IN SELECT product_id FROM public.or_prebill_items WHERE document_id=v_doc.id AND product_id IS NOT NULL
    UNION SELECT (value->>'product_id')::uuid FROM jsonb_array_elements(p_items) WHERE value->>'product_id' IS NOT NULL ORDER BY product_id
  LOOP PERFORM 1 FROM public.inv_stock_balances WHERE product_id=r.product_id FOR UPDATE; END LOOP;
  IF p_id IS NULL THEN INSERT INTO public.or_prebill_documents SELECT (v_doc).*;
  ELSE
    UPDATE public.or_prebill_documents SET
      document_type=v_doc.document_type,document_no=v_doc.document_no,status=v_doc.status,channel_code=v_doc.channel_code,
      header_name=v_doc.header_name,customer_name=v_doc.customer_name,customer_address=v_doc.customer_address,
      recipient_name=v_doc.recipient_name,customer_phone=v_doc.customer_phone,billing_details=v_doc.billing_details,
      delivery_term=v_doc.delivery_term,valid_until=v_doc.valid_until,payment_method=v_doc.payment_method,
      subtotal=v_doc.subtotal,shipping_cost=v_doc.shipping_cost,promotion_discount=v_doc.promotion_discount,
      special_discount=v_doc.special_discount,total_amount=v_doc.total_amount,promotion_ids=v_doc.promotion_ids,
      promotion_snapshot=v_doc.promotion_snapshot,shipping_snapshot=v_doc.shipping_snapshot,internal_note=v_doc.internal_note,
      owner_id=v_doc.owner_id,owner_name=v_doc.owner_name,source_document_id=v_doc.source_document_id,updated_at=now()
    WHERE id=p_id;
  END IF;
  DELETE FROM public.or_prebill_items WHERE document_id=v_doc.id;
  FOR x IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_item:=jsonb_populate_record(NULL::public.or_prebill_items,
      jsonb_build_object('id',gen_random_uuid(),'document_id',v_doc.id,'created_at',now(),'updated_at',now())||x||jsonb_build_object('document_id',v_doc.id));
    INSERT INTO public.or_prebill_items SELECT (v_item).*;
  END LOOP;
  PERFORM set_config('app.reservation_save','',true);
  UPDATE public.or_prebill_documents SET updated_at=now() WHERE id=v_doc.id;
  SELECT * INTO STRICT v_doc FROM public.or_prebill_documents WHERE id=v_doc.id;
  RETURN v_doc;
END $$;

-- Preserve WMS item links when saving order lines; fail atomically on shortage.
CREATE FUNCTION public.rpc_save_order_items(p_order_id uuid,p_items jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE x jsonb; r record; v_item public.or_order_items; v_existing public.or_order_items;
BEGIN
  PERFORM 1 FROM public.or_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบหรือไม่มีสิทธิ์แก้ไขบิล'; END IF;
  IF jsonb_typeof(p_items)<>'array' THEN RAISE EXCEPTION 'รายการสินค้าไม่ถูกต้อง'; END IF;
  PERFORM set_config('app.reservation_save','order:'||p_order_id::text,true);
  FOR r IN SELECT product_id FROM public.or_order_items WHERE order_id=p_order_id AND product_id IS NOT NULL
    UNION SELECT (value->>'product_id')::uuid FROM jsonb_array_elements(p_items) WHERE value->>'product_id' IS NOT NULL ORDER BY product_id
  LOOP PERFORM 1 FROM public.inv_stock_balances WHERE product_id=r.product_id FOR UPDATE; END LOOP;
  DELETE FROM public.or_order_items i WHERE order_id=p_order_id
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) candidate WHERE (candidate.value->>'id')::uuid=i.id);
  UPDATE public.or_order_items SET item_uid='reservation-save-'||id::text WHERE order_id=p_order_id;
  FOR x IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_existing FROM public.or_order_items WHERE id=(x->>'id')::uuid AND order_id=p_order_id;
    IF FOUND THEN
      v_item:=jsonb_populate_record(v_existing,x||jsonb_build_object('order_id',p_order_id));
      UPDATE public.or_order_items SET product_id=v_item.product_id,product_name=v_item.product_name,quantity=v_item.quantity,
        item_uid=v_item.item_uid,is_detail_row=v_item.is_detail_row,parent_item_id=v_item.parent_item_id,unit_price=v_item.unit_price,
        ink_color=v_item.ink_color,product_type=v_item.product_type,cartoon_pattern=v_item.cartoon_pattern,line_pattern=v_item.line_pattern,
        font=v_item.font,line_1=v_item.line_1,line_2=v_item.line_2,line_3=v_item.line_3,no_name_line=v_item.no_name_line,
        is_free=v_item.is_free,notes=v_item.notes,file_attachment=v_item.file_attachment,attachment_name=v_item.attachment_name
      WHERE id=v_item.id AND order_id=p_order_id;
    ELSE
      v_item:=jsonb_populate_record(NULL::public.or_order_items,
        jsonb_build_object('created_at',now(),'updated_at',now())||x||jsonb_build_object('order_id',p_order_id));
      INSERT INTO public.or_order_items SELECT (v_item).*;
    END IF;
  END LOOP;
  PERFORM set_config('app.reservation_save','',true);
  UPDATE public.or_orders SET updated_at=now() WHERE id=p_order_id;
END $$;

CREATE OR REPLACE FUNCTION public.inv_deduct_stock_on_wms_picked()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product_id UUID;
  v_product_code TEXT;
  v_product_name TEXT;
  v_movement_id UUID;
  v_stock_qty NUMERIC;
  v_already_deducted NUMERIC := 0;
  v_deduct_qty NUMERIC := 0;
  v_on_hand NUMERIC := 0;
  v_reserved NUMERIC := 0;
  v_available_for_row NUMERIC := 0;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;

  SELECT p.id, p.product_code, p.product_name
  INTO v_product_id, v_product_code, v_product_name
  FROM public.pr_products p
  WHERE p.product_code = NEW.product_code
  LIMIT 1;

  IF v_product_id IS NULL THEN RETURN NEW; END IF;
  v_stock_qty := COALESCE(NEW.qty, 0);

  IF NEW.status = 'picked'
     AND (OLD.status IS NULL OR OLD.status NOT IN ('picked', 'correct'))
  THEN
    INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_product_id, 0, v_stock_qty, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET reserved = COALESCE(public.inv_stock_balances.reserved, 0) + v_stock_qty,
          updated_at = NOW();
  END IF;

  IF NEW.status = 'correct'
     AND (OLD.status IS NULL OR OLD.status <> 'correct')
  THEN
    SELECT COALESCE(SUM(-m.qty) FILTER (
      WHERE m.movement_type IN ('pick', 'pick_reversal')
    ), 0)
    INTO v_already_deducted
    FROM public.inv_stock_movements m
    WHERE m.ref_type = 'wms_orders' AND m.ref_id = NEW.id;

    v_deduct_qty := GREATEST(v_stock_qty - v_already_deducted, 0);

    INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_product_id, 0, 0, 0)
    ON CONFLICT (product_id) DO NOTHING;

    SELECT COALESCE(b.on_hand, 0), COALESCE(b.reserved, 0)
    INTO v_on_hand, v_reserved
    FROM public.inv_stock_balances b
    WHERE b.product_id = v_product_id
    FOR UPDATE;

    v_available_for_row := v_on_hand - v_reserved
      + CASE WHEN OLD.status = 'picked' THEN v_stock_qty ELSE 0 END;
    IF v_available_for_row < v_deduct_qty THEN
      RAISE EXCEPTION 'สต๊อกพร้อมตัดของสินค้า % - % ไม่เพียงพอ ขาด % %',
        COALESCE(NULLIF(v_product_code, ''), v_product_id::TEXT),
        COALESCE(NULLIF(v_product_name, ''), NEW.product_name, '-'),
        v_deduct_qty - v_available_for_row,
        COALESCE(NULLIF(BTRIM(NEW.unit_name), ''), 'หน่วย');
    END IF;

    IF v_deduct_qty > 0 THEN
      PERFORM public.fn_reconcile_sellable_lots_to_on_hand(v_product_id);

      INSERT INTO public.inv_stock_movements (
        product_id, movement_type, qty, ref_type, ref_id, note
      ) VALUES (
        v_product_id, 'pick', -v_deduct_qty, 'wms_orders', NEW.id,
        'ตัดสต๊อกตามหน่วยสินค้า ' || COALESCE(NULLIF(BTRIM(NEW.unit_name), ''), 'ชิ้น')
      ) RETURNING id INTO v_movement_id;

      PERFORM public.fn_consume_stock_fifo(v_product_id, v_deduct_qty, v_movement_id);

      UPDATE public.inv_stock_balances
      SET on_hand = COALESCE(on_hand, 0) - v_deduct_qty,
          reserved = GREATEST(COALESCE(reserved, 0) - CASE WHEN OLD.status = 'picked' THEN v_stock_qty ELSE 0 END, 0),
          updated_at = NOW()
      WHERE product_id = v_product_id;

      PERFORM public.fn_recalc_product_landed_cost(v_product_id);
    ELSIF OLD.status = 'picked' THEN
      UPDATE public.inv_stock_balances
      SET reserved = GREATEST(COALESCE(reserved, 0) - v_stock_qty, 0),
          updated_at = NOW()
      WHERE product_id = v_product_id;
    END IF;
  END IF;

  IF NEW.status = 'out_of_stock' AND OLD.status = 'picked' THEN
    UPDATE public.inv_stock_balances
    SET reserved = GREATEST(COALESCE(reserved, 0) - v_stock_qty, 0),
        updated_at = NOW()
    WHERE product_id = v_product_id;
  END IF;

  IF NEW.status = 'returned' AND OLD.status IS DISTINCT FROM 'returned' THEN
    IF OLD.status = 'picked' THEN
      UPDATE public.inv_stock_balances
      SET reserved = GREATEST(COALESCE(reserved, 0) - v_stock_qty, 0),
          updated_at = NOW()
      WHERE product_id = v_product_id;
    ELSIF OLD.status = 'correct' THEN
      PERFORM public.fn_reverse_wms_stock(NEW.id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- Immutable cutover marker: clients cannot disable holds or enroll old documents.
CREATE FUNCTION public.fn_guard_reservation_cutover()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN NEW.stock_reservation_enabled:=true;
  ELSIF NEW.stock_reservation_enabled IS DISTINCT FROM OLD.stock_reservation_enabled THEN
    RAISE EXCEPTION 'ไม่สามารถเปลี่ยนโหมดจองของเอกสาร';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aa_guard_reservation_cutover BEFORE INSERT OR UPDATE ON public.or_orders FOR EACH ROW EXECUTE FUNCTION public.fn_guard_reservation_cutover();
CREATE TRIGGER aa_guard_reservation_cutover BEFORE INSERT OR UPDATE ON public.or_prebill_documents FOR EACH ROW EXECUTE FUNCTION public.fn_guard_reservation_cutover();

CREATE FUNCTION public.rpc_refresh_document_reservations()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'กรุณาเข้าสู่ระบบ'; END IF;
  PERFORM public.fn_expire_document_reservations();
END $$;
REVOKE ALL ON FUNCTION public.rpc_refresh_document_reservations() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_refresh_document_reservations() TO authenticated;

CREATE FUNCTION public.rpc_get_reservation_stock(p_type text DEFAULT NULL,p_source uuid DEFAULT NULL)
RETURNS TABLE(product_id uuid,on_hand numeric,reserved numeric,safety_stock numeric,own_reserved numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'กรุณาเข้าสู่ระบบ'; END IF;
  PERFORM public.fn_expire_document_reservations();
  -- Prebill ownership follows the existing team visibility policy.
  IF p_source IS NOT NULL THEN
    IF p_type='prebill' AND NOT public.can_manage_prebill_document((SELECT owner_id FROM public.or_prebill_documents WHERE id=p_source)) THEN
      RAISE EXCEPTION 'ไม่มีสิทธิ์ดูเอกสาร';
    END IF;
  END IF;
  RETURN QUERY SELECT b.product_id,b.on_hand,b.reserved,b.safety_stock,
    coalesce((SELECT sum(r.qty) FROM public.inv_document_reservations r WHERE r.product_id=b.product_id AND r.source_type=p_type AND r.source_id=p_source),0)
    +CASE WHEN p_type='order' AND EXISTS(SELECT 1 FROM public.or_orders o WHERE o.id=p_source AND o.stock_reservation_enabled) THEN coalesce((SELECT sum(w.qty) FROM public.wms_orders w
      JOIN public.or_order_items i ON i.id=w.source_order_item_id
      WHERE i.order_id=p_source AND i.product_id=b.product_id AND w.status IN ('picked','correct')),0) ELSE 0 END
  FROM public.inv_stock_balances b ORDER BY b.product_id;
END $$;

CREATE FUNCTION public.rpc_get_product_reservations(p_product_ids uuid[])
RETURNS TABLE(source_type text,source_id uuid,document_type text,document_no text,source_document_no text,
  customer_name text,owner_name text,product_id uuid,qty numeric,expires_on date,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'กรุณาเข้าสู่ระบบ'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.us_users u WHERE u.id=auth.uid()
    AND (u.role IN ('superadmin','admin','sales-tr','store','account','production','manager')
      OR EXISTS(SELECT 1 FROM public.st_user_menus m WHERE m.role=u.role AND m.menu_key IN ('warehouse','warehouse-stock') AND m.has_access))) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดูรายการจองคลัง' USING ERRCODE='42501';
  END IF;
  PERFORM public.fn_expire_document_reservations();
  RETURN QUERY
  SELECT 'prebill'::text,d.id,CASE d.document_type WHEN 'quotation' THEN 'QT' ELSE 'PC' END,
    d.document_no,NULL::text,d.customer_name,d.owner_name,r.product_id,r.qty,d.valid_until,d.status
  FROM public.inv_document_reservations r JOIN public.or_prebill_documents d ON d.id=r.source_id
  WHERE r.source_type='prebill' AND r.qty>0 AND r.product_id=ANY(p_product_ids)
  UNION ALL
  SELECT 'order',o.id,CASE WHEN o.bill_no LIKE 'REQ%' THEN 'claim' ELSE 'sale' END,
    o.bill_no,d.document_no,o.customer_name,o.admin_user,r.product_id,r.qty,NULL::date,o.status
  FROM public.inv_document_reservations r JOIN public.or_orders o ON o.id=r.source_id
  LEFT JOIN public.or_prebill_documents d ON d.id=o.source_prebill_document_id
  WHERE r.source_type='order' AND r.qty>0 AND r.product_id=ANY(p_product_ids)
  UNION ALL
  SELECT CASE WHEN o.id IS NULL THEN 'wms' ELSE 'order' END,coalesce(o.id,w.id),
    CASE WHEN o.id IS NULL THEN 'wms' WHEN o.bill_no LIKE 'REQ%' THEN 'claim' ELSE 'sale' END,
    coalesce(o.bill_no,w.order_id),d.document_no,coalesce(o.customer_name,'-'),coalesce(o.admin_user,'-'),
    p.id,w.qty,NULL::date,CASE WHEN w.status='cancelled' THEN 'cancelled_pending_stock' ELSE 'picked' END
  FROM public.wms_orders w JOIN public.pr_products p ON p.product_code=w.product_code
  LEFT JOIN public.or_orders o ON o.id=coalesce(w.source_order_id,(SELECT i.order_id FROM public.or_order_items i WHERE i.id=w.source_order_item_id))
  LEFT JOIN public.or_prebill_documents d ON d.id=o.source_prebill_document_id
  WHERE p.id=ANY(p_product_ids) AND (w.status='picked' OR (w.status='cancelled' AND w.status_before_cancel='picked' AND w.stock_action IS NULL))
  UNION ALL
  SELECT 'borrow',b.id,'borrow',b.borrow_no,NULL::text,'-',coalesce(u.username,u.email,'-'),
    i.product_id,greatest(i.qty-coalesce(i.returned_qty,0)-coalesce(i.written_off_qty,0),0),b.due_date,b.status
  FROM public.wms_borrow_requisition_items i JOIN public.wms_borrow_requisitions b ON b.id=i.borrow_requisition_id
  LEFT JOIN public.us_users u ON u.id=b.created_by
  WHERE i.product_id=ANY(p_product_ids) AND b.status IN ('approved','partial_returned','overdue')
    AND i.qty-coalesce(i.returned_qty,0)-coalesce(i.written_off_qty,0)>0;
END $$;

-- Internal mutation functions are never callable through the client API.
REVOKE ALL ON FUNCTION public.fn_set_document_reservation(text,uuid,uuid,numeric,date),
  public.fn_sync_document_reservations(text,uuid),public.fn_expire_document_reservations(),
  public.fn_document_reservation_changed(),public.fn_transfer_document_reservation_to_wms(),
  public.fn_sync_wms_document_reservation(),public.fn_transfer_prebill_reservations(),public.fn_guard_reservation_cutover() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.rpc_save_prebill_document(uuid,jsonb,jsonb),public.rpc_save_order_items(uuid,jsonb),
  public.rpc_get_reservation_stock(text,uuid),public.rpc_get_product_reservations(uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_save_prebill_document(uuid,jsonb,jsonb),public.rpc_save_order_items(uuid,jsonb),
  public.rpc_get_reservation_stock(text,uuid),public.rpc_get_product_reservations(uuid[]) TO authenticated;

-- Minute schedule operates independently of any browser session.
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('expire-document-stock-reservations','* * * * *','SELECT public.fn_expire_document_reservations()');
NOTIFY pgrst,'reload schema';
COMMIT;
