-- Sales drafts do not reserve; activation checks stock atomically.
BEGIN;
CREATE OR REPLACE FUNCTION public.fn_sync_document_reservations(p_type text,p_source uuid)
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
    ELSIF v_enabled AND v_claim_ready AND p_type='order' AND v_status NOT IN ('รอลงข้อมูล','ยกเลิก','จัดส่งแล้ว') THEN
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
CREATE FUNCTION public.fn_enable_sales_reservation_on_activation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.status='รอลงข้อมูล' AND NEW.status NOT IN ('รอลงข้อมูล','ยกเลิก','จัดส่งแล้ว') THEN
    NEW.stock_reservation_enabled:=true;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_enable_sales_reservation_on_activation() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER enable_sales_reservation_on_activation BEFORE UPDATE OF status ON public.or_orders
FOR EACH ROW EXECUTE FUNCTION public.fn_enable_sales_reservation_on_activation();
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT DISTINCT o.id FROM public.or_orders o
    JOIN public.inv_document_reservations d ON d.source_type='order' AND d.source_id=o.id AND d.qty>0
    WHERE o.status='รอลงข้อมูล' ORDER BY o.id
  LOOP PERFORM public.fn_sync_document_reservations('order',r.id); END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;


