BEGIN;

-- A floor is print content, not another physical stamp. Normalize all entry
-- points (including imports that omit is_detail_row) before WMS reads the bill.
CREATE OR REPLACE FUNCTION public.trg_normalize_condo_detail_row()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_category TEXT;
BEGIN
  IF NEW.parent_item_id IS NOT NULL THEN
    NEW.is_detail_row := true;
  ELSIF btrim(coalesce(NEW.product_type,'')) ~ '^ชั้น[[:space:]]*[2-5]$' THEN
    SELECT product_category INTO v_category FROM public.pr_products WHERE id=NEW.product_id;
    IF upper(btrim(coalesce(v_category,''))) IN ('CONDO STAMP 2FL','CONDO STAMP 3FL','CONDO STAMP 5FL')
       OR btrim(coalesce(NEW.product_name,'')) LIKE 'ตรายางคอนโด%' THEN
      NEW.is_detail_row := true;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_normalize_condo_detail_row
BEFORE INSERT OR UPDATE OF product_id,product_name,product_type,parent_item_id,is_detail_row
ON public.or_order_items FOR EACH ROW
EXECUTE FUNCTION public.trg_normalize_condo_detail_row();

UPDATE public.or_order_items oi
SET is_detail_row=true
WHERE NOT coalesce(oi.is_detail_row,false)
  AND (oi.parent_item_id IS NOT NULL OR (
    btrim(coalesce(oi.product_type,'')) ~ '^ชั้น[[:space:]]*[2-5]$'
    AND (btrim(coalesce(oi.product_name,'')) LIKE 'ตรายางคอนโด%'
      OR EXISTS (SELECT 1 FROM public.pr_products p WHERE p.id=oi.product_id
        AND upper(btrim(coalesce(p.product_category,''))) IN ('CONDO STAMP 2FL','CONDO STAMP 3FL','CONDO STAMP 5FL')))
  ));

-- Historical WMS rows can already have FIFO consumption/reservations. Repair
-- only explicit source-item links in a selected work order via the audited void
-- RPC; never delete rows or divide quantities based on a product name.
CREATE OR REPLACE FUNCTION public.rpc_repair_wms_detail_rows(p_work_order_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_ids UUID[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.us_users WHERE id=auth.uid() AND role='superadmin') THEN
    RAISE EXCEPTION 'เฉพาะ superadmin เท่านั้นที่ซ่อมรายการได้';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('WMS_ASSIGN:'||p_work_order_id::TEXT,0));
  SELECT array_agg(w.id ORDER BY w.id) INTO v_ids
  FROM public.wms_orders w
  JOIN public.or_order_items oi ON oi.id=w.source_order_item_id
  JOIN public.or_orders o ON o.id=oi.order_id
  WHERE w.work_order_id=p_work_order_id AND o.work_order_id=p_work_order_id
    AND oi.is_detail_row=true AND w.status<>'cancelled'
    AND (w.fulfillment_mode='warehouse_pick' OR w.fulfillment_mode IS NULL);
  IF coalesce(cardinality(v_ids),0)=0 THEN
    RETURN jsonb_build_object('success',true,'voided_count',0);
  END IF;
  RETURN public.rpc_void_wms_orders(v_ids,'แก้ไข WMS ที่นับแถวรายละเอียดชั้นเป็นสินค้าจริง');
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_repair_wms_detail_rows(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_repair_wms_detail_rows(UUID) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
