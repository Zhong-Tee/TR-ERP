-- Unified discount review. No historical bill backfill.
BEGIN;
ALTER TABLE public.or_orders ADD COLUMN discount_approval_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN payment_not_required boolean NOT NULL DEFAULT false,
 ADD COLUMN automatic_discount_snapshot jsonb;
CREATE TABLE public.or_sales_discount_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES public.or_orders(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('pending','approved','rejected','stale','cancelled')),
 snapshot jsonb NOT NULL, reason text NOT NULL CHECK(btrim(reason)<>''),
 requested_by uuid NOT NULL REFERENCES public.us_users(id), requested_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), reviewed_by uuid REFERENCES public.us_users(id),
 reviewed_name text, reviewed_at timestamptz, review_note text
);
CREATE UNIQUE INDEX or_sales_discount_one_pending ON public.or_sales_discount_requests(order_id) WHERE status='pending';
CREATE INDEX or_sales_discount_order ON public.or_sales_discount_requests(order_id,created_at DESC);

CREATE FUNCTION public.or_discount_can_manage(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.us_users u JOIN public.or_orders o ON o.id=p_id
 WHERE u.id=auth.uid() AND u.is_active AND (u.role IN ('superadmin','admin')
 OR (u.role IN ('sales-tr','sales-pump') AND (o.admin_user IN (u.username,u.email)
 OR (u.role='sales-tr' AND EXISTS(SELECT 1 FROM public.us_users owner WHERE owner.role='sales-tr' AND o.admin_user IN(owner.username,owner.email)))))))
$$;
ALTER TABLE public.or_sales_discount_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_discount_read ON public.or_sales_discount_requests FOR SELECT TO authenticated USING(public.or_discount_can_manage(order_id));
REVOKE ALL ON public.or_sales_discount_requests FROM anon,authenticated;
GRANT SELECT ON public.or_sales_discount_requests TO authenticated;
DO $pub$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.or_sales_discount_requests; END IF;
END $pub$;
ALTER TABLE public.or_prebill_documents ADD COLUMN discount_review_snapshot jsonb;

-- Stable multiset of commercial lines; database IDs and presentation order do not affect approval.
CREATE FUNCTION public.or_discount_lines(p_items jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_agg(line ORDER BY line::text),'[]'::jsonb) FROM (
 SELECT jsonb_build_object('product_id',x->>'product_id','quantity',coalesce((x->>'quantity')::numeric,0),
 'unit_price',round(coalesce((x->>'unit_price')::numeric,0),2),'is_free',coalesce((x->>'is_free')::boolean,false),
 'is_detail_row',coalesce((x->>'is_detail_row')::boolean,false)) line
 FROM jsonb_array_elements(coalesce(p_items,'[]')) x WHERE nullif(x->>'product_id','') IS NOT NULL) q
$$;
CREATE FUNCTION public.or_discount_snapshot(p_header jsonb,p_items jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('price',round(coalesce((p_header->>'price')::numeric,0),2),'shipping_cost',round(coalesce((p_header->>'shipping_cost')::numeric,0),2),
 'discount',round(coalesce((p_header->>'discount')::numeric,0),2),'total_amount',round(coalesce((p_header->>'total_amount')::numeric,0),2),
 'channel_code',p_header->>'channel_code','payment_method',p_header->>'payment_method',
 'fulfillment_method',coalesce(p_header->>'fulfillment_method','shipping'),'items',public.or_discount_lines(p_items))
$$;
CREATE FUNCTION public.or_prebill_discount_snapshot(p_header jsonb,p_items jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT public.or_discount_snapshot(p_header||jsonb_build_object('price',p_header->'subtotal',
 'discount',coalesce((p_header->>'promotion_discount')::numeric,0)+coalesce((p_header->>'special_discount')::numeric,0)),p_items)
$$;
CREATE FUNCTION public.or_discount_items(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(i)),'[]'::jsonb) FROM public.or_order_items i WHERE order_id=p_id
$$;

-- Same capacity allocation as promotionRules.allocateGroups: satisfy every minimum,
-- then maximize eligible quantity-at-least groups; highest priced eligible lines first.
CREATE FUNCTION public.or_discount_group_value(p_items jsonb,p_groups jsonb,p_count int,p_extra boolean DEFAULT false)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE ni int:=jsonb_array_length(p_items); ng int:=jsonb_array_length(p_groups); n int:=ni+ng+2;
 cap numeric[][]; cost numeric[][]; dist numeric[]; prev int[]; i int; j int; k int; v int; w int;
 qty numeric; demand numeric:=0; flow numeric:=0; pushed numeric; total_cost numeric:=0; expanded boolean:=false; changed boolean;
 item jsonb; grp jsonb; opt jsonb; need numeric; available numeric:=0;
BEGIN
 IF ng=0 THEN RETURN 0; END IF;
 cap:=array_fill(0::numeric,ARRAY[n,n]); cost:=array_fill(0::numeric,ARRAY[n,n]);
 FOR i IN 1..ni LOOP
  item:=p_items->(i-1); qty:=greatest(0,floor(coalesce((item->>'quantity')::numeric,0))); available:=available+qty;
  cap[1][i+1]:=qty;
  FOR j IN 1..ng LOOP
   grp:=p_groups->(j-1);
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(grp->'options','[]')) o
    WHERE (o->>'selector_type'='sku' AND o->>'product_id'=item->>'product_id') OR
    (o->>'selector_type'='category' AND o->>'category'=item->>'product_category')) THEN
    cap[i+1][ni+j+1]:=qty;
    cost[i+1][ni+j+1]:=-round(coalesce((item->>'unit_price')::numeric,0)*100);
    cost[ni+j+1][i+1]:=-cost[i+1][ni+j+1];
   END IF;
  END LOOP;
 END LOOP;
 FOR j IN 1..ng LOOP
  need:=greatest(1,floor(coalesce((p_groups->(j-1)->>'quantity')::numeric,1)))*p_count;
  cap[ni+j+1][n]:=need; demand:=demand+need;
 END LOOP;
 LOOP
  IF flow=demand THEN
   IF NOT p_extra OR expanded THEN EXIT; END IF;
   expanded:=true;
   FOR j IN 1..ng LOOP
    IF coalesce((p_groups->(j-1)->>'quantity_at_least')::boolean,false) THEN cap[ni+j+1][n]:=cap[ni+j+1][n]+available; demand:=demand+available; END IF;
   END LOOP;
   IF flow=demand THEN EXIT; END IF;
  END IF;
  dist:=array_fill(1e30::numeric,ARRAY[n]); prev:=array_fill(0,ARRAY[n]); dist[1]:=0;
  FOR k IN 1..n-1 LOOP
   changed:=false;
   FOR v IN 1..n LOOP
    FOR w IN 1..n LOOP
     IF cap[v][w]>0 AND dist[v]<1e30 AND dist[w]>dist[v]+cost[v][w] THEN
      dist[w]:=dist[v]+cost[v][w]; prev[w]:=v; changed:=true;
     END IF;
    END LOOP;
   END LOOP;
   EXIT WHEN NOT changed;
  END LOOP;
  EXIT WHEN prev[n]=0;
  pushed:=demand-flow; v:=n;
  WHILE v<>1 LOOP pushed:=least(pushed,cap[prev[v]][v]); v:=prev[v]; END LOOP;
  v:=n;
  WHILE v<>1 LOOP w:=prev[v]; cap[w][v]:=cap[w][v]-pushed; cap[v][w]:=cap[v][w]+pushed; total_cost:=total_cost+pushed*cost[w][v]; v:=w; END LOOP;
  flow:=flow+pushed;
 END LOOP;
 IF NOT expanded AND flow<demand THEN RETURN NULL; END IF;
 RETURN round(-total_cost/100,2);
END $$;

CREATE FUNCTION public.or_discount_automatic(p_header jsonb,p_items jsonb,p_promotions jsonb) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE link jsonb; p public.promotion; cfg jsonb; paid jsonb; count_ int; amount numeric; total_ numeric:=0;
 subtotal numeric:=round(coalesce((p_header->>'price')::numeric,0),2); val numeric; allocated numeric;
BEGIN
 IF jsonb_array_length(coalesce(p_promotions,'[]'))>1 AND EXISTS(
  SELECT 1 FROM jsonb_array_elements(p_promotions) x JOIN public.promotion pr ON pr.id=(x->>'promotion_id')::uuid WHERE NOT pr.allow_stack
 ) THEN RETURN 0; END IF;
 SELECT coalesce(jsonb_agg(x||jsonb_build_object('product_category',pr.product_category)),'[]') INTO paid
 FROM jsonb_array_elements(p_items) x JOIN public.pr_products pr ON pr.id=(x->>'product_id')::uuid
 WHERE NOT coalesce((x->>'is_free')::boolean,false) AND NOT coalesce((x->>'is_detail_row')::boolean,false);
 FOR link IN SELECT value FROM jsonb_array_elements(coalesce(p_promotions,'[]')) LOOP
  SELECT * INTO p FROM public.promotion WHERE id=(link->>'promotion_id')::uuid;
  IF p.id IS NULL OR p.rule_type='legacy' OR NOT p.is_active OR
   (cardinality(p.channel_codes)>0 AND NOT (p_header->>'channel_code'=ANY(p.channel_codes))) OR
   (p.start_date IS NOT NULL AND p.start_date>(now() AT TIME ZONE 'Asia/Bangkok')::date) OR
   (p.end_date IS NOT NULL AND p.end_date<(now() AT TIME ZONE 'Asia/Bangkok')::date) OR
   (jsonb_array_length(p_promotions)>1 AND NOT p.allow_stack) THEN CONTINUE; END IF;
  cfg:=p.rule_config; count_:=greatest(1,coalesce((link->>'application_count')::int,1));
  IF count_>greatest(1,coalesce((cfg->>'max_applications')::int,1)) THEN CONTINUE; END IF;
  val:=greatest(0,coalesce((cfg->>'discount_value')::numeric,0)); amount:=0;
  IF p.rule_type IN ('spend_fixed','spend_percent') THEN
   IF subtotal>=greatest(0,coalesce((cfg->>'threshold_amount')::numeric,0))*count_ THEN
    amount:=CASE WHEN p.rule_type='spend_percent' THEN subtotal*val/100 ELSE val*count_ END;
   END IF;
  ELSIF p.rule_type IN ('quantity_fixed','quantity_percent','bundle_fixed_price') THEN
   IF jsonb_array_length(coalesce(cfg->'condition_groups','[]'))=0 THEN CONTINUE; END IF;
   allocated:=public.or_discount_group_value(paid,cfg->'condition_groups',count_,p.rule_type='quantity_percent');
   IF allocated IS NOT NULL THEN
    amount:=CASE p.rule_type WHEN 'quantity_fixed' THEN val*count_
     WHEN 'quantity_percent' THEN CASE WHEN val<=100 THEN allocated*val/100 ELSE 0 END
     ELSE greatest(0,allocated-greatest(0,coalesce((cfg->>'set_price')::numeric,0))*count_) END;
   END IF;
  END IF;
  total_:=total_+round(least(subtotal,greatest(0,amount)),2);
 END LOOP;
 RETURN total_;
END $$;

CREATE FUNCTION public.or_discount_state(p_id uuid,p_header jsonb,p_items jsonb,p_promotions jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE snap jsonb:=public.or_discount_snapshot(p_header,p_items); r public.or_sales_discount_requests;
 d public.or_prebill_documents; required_ boolean; approved_ boolean:=false; auto_ numeric; o public.or_orders; source_ text;
BEGIN
 IF p_id IS NOT NULL THEN SELECT * INTO o FROM public.or_orders WHERE id=p_id; END IF;
 auto_:=public.or_discount_automatic(p_header,p_items,p_promotions);
 required_:=round(coalesce((p_header->>'discount')::numeric,0),2)>0 AND round((p_header->>'discount')::numeric,2)<>auto_;
 IF p_id IS NOT NULL THEN
  SELECT * INTO r FROM public.or_sales_discount_requests WHERE order_id=p_id ORDER BY created_at DESC,id DESC LIMIT 1;
  approved_:=r.status='approved' AND r.snapshot=snap;
  IF approved_ THEN source_:='sale'; END IF;
  IF o.source_prebill_document_id IS NOT NULL THEN
   SELECT * INTO d FROM public.or_prebill_documents WHERE id=o.source_prebill_document_id AND converted_order_id=p_id
    AND status='converted' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_special_discount IS NOT NULL;
   IF d.id IS NOT NULL AND (d.discount_review_snapshot IS NULL OR d.discount_review_snapshot=public.or_prebill_discount_snapshot(to_jsonb(d),coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM public.or_prebill_items i WHERE document_id=d.id),'[]'))) AND d.approved_special_discount=d.special_discount AND (d.special_discount>0)
    AND snap=public.or_discount_snapshot(jsonb_build_object('price',d.subtotal,'shipping_cost',d.shipping_cost,
      'discount',d.promotion_discount+d.special_discount,'total_amount',d.total_amount,'channel_code',d.channel_code,
      'payment_method',d.payment_method,'fulfillment_method',coalesce(to_jsonb(o)->>'fulfillment_method','shipping')),
      coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM public.or_prebill_items i WHERE document_id=d.id),'[]')) THEN
     approved_:=true; source_:='prebill';
   END IF;
  END IF;
 END IF;
 approved_:=coalesce(approved_,false);
 -- Old unchanged commercial snapshots retain their previous workflow; no historical backfill.
 IF o.automatic_discount_snapshot=snap THEN required_:=false; END IF;
 IF o.id IS NOT NULL AND NOT o.discount_approval_enabled AND snap=public.or_discount_snapshot(to_jsonb(o),public.or_discount_items(o.id)) THEN required_:=false; END IF;
 RETURN jsonb_build_object('required',required_,'approved',approved_,'source',source_,
  'zero_payment',coalesce(approved_ AND (p_header->>'total_amount')::numeric=0,false),
  'status',CASE WHEN r.id IS NULL THEN 'none' WHEN r.snapshot<>snap AND r.status IN ('pending','approved') THEN 'stale' ELSE r.status END,
  'legacy_unchanged',o.id IS NOT NULL AND NOT o.discount_approval_enabled AND snap=public.or_discount_snapshot(to_jsonb(o),public.or_discount_items(o.id)),
  'reason',r.reason,'review_note',r.review_note,'automatic_discount',auto_);
END $$;

CREATE FUNCTION public.rpc_check_order_discount(p_order_id uuid,p_header jsonb,p_items jsonb,p_promotions jsonb DEFAULT '[]') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND is_active AND role IN ('superadmin','admin','sales-tr','sales-pump','account','qc_order'))
  OR (p_order_id IS NOT NULL AND NOT public.or_discount_can_manage(p_order_id) AND NOT EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND is_active AND role IN ('account','qc_order'))) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์'; END IF;
 RETURN public.or_discount_state(p_order_id,p_header,p_items,p_promotions);
END $$;

CREATE FUNCTION public.rpc_request_sales_discount(p_order_id uuid,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.or_orders; req uuid; snap jsonb; state_ jsonb; who text;
BEGIN
 IF NOT public.or_discount_can_manage(p_order_id) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์'; END IF;
 SELECT * INTO o FROM public.or_orders WHERE id=p_order_id FOR UPDATE;
 IF o.status NOT IN ('รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ') OR o.work_order_id IS NOT NULL
  OR o.source_prebill_document_id IS NOT NULL OR o.source_marketplace_order_id IS NOT NULL OR upper(o.bill_no) LIKE 'REQ%' THEN RAISE EXCEPTION 'บิลนี้ไม่สามารถส่งขอส่วนลดโดยตรงได้'; END IF;
 IF btrim(coalesce(p_reason,''))='' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลขอส่วนลด'; END IF;
 snap:=public.or_discount_snapshot(to_jsonb(o),public.or_discount_items(o.id));
 IF o.total_amount IS NULL OR o.price IS NULL OR o.discount IS NULL OR o.shipping_cost IS NULL OR o.discount<=0 OR o.total_amount<0 OR o.discount>o.price+o.shipping_cost OR o.total_amount<>round(o.price+o.shipping_cost-o.discount,2)
  OR jsonb_array_length(snap->'items')=0 THEN RAISE EXCEPTION 'สินค้า ส่วนลด หรือยอดสุทธิไม่ถูกต้อง'; END IF;
 UPDATE public.or_sales_discount_requests SET status='stale' WHERE order_id=o.id AND status IN ('pending','approved');
 SELECT coalesce(username,email) INTO who FROM public.us_users WHERE id=auth.uid();
 INSERT INTO public.or_sales_discount_requests(order_id,status,snapshot,reason,requested_by,requested_name)
 VALUES(o.id,'pending',snap,btrim(p_reason),auth.uid(),who) RETURNING id INTO req;
 UPDATE public.or_orders SET discount_approval_enabled=true WHERE id=o.id;
 RETURN req;
END $$;

CREATE FUNCTION public.rpc_review_sales_discount(p_request_id uuid,p_approve boolean,p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.or_sales_discount_requests; o public.or_orders; who text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND is_active AND role='superadmin') THEN RAISE EXCEPTION 'เฉพาะ superadmin เท่านั้นที่อนุมัติส่วนลดได้'; END IF;
 IF p_approve IS NULL THEN RAISE EXCEPTION 'กรุณาระบุผลพิจารณา'; END IF;
 SELECT * INTO r FROM public.or_sales_discount_requests WHERE id=p_request_id;
 SELECT * INTO o FROM public.or_orders WHERE id=r.order_id FOR UPDATE;
 SELECT * INTO r FROM public.or_sales_discount_requests WHERE id=p_request_id FOR UPDATE;
 IF r.id IS NULL OR r.status<>'pending' THEN RAISE EXCEPTION 'คำขอไม่ได้รออนุมัติ'; END IF;
 IF o.status NOT IN ('รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ') OR o.work_order_id IS NOT NULL
  OR r.snapshot<>public.or_discount_snapshot(to_jsonb(o),public.or_discount_items(o.id)) THEN RAISE EXCEPTION 'รายการหรือยอดเปลี่ยนแล้ว ต้องส่งขออนุมัติใหม่'; END IF;
 IF NOT p_approve AND btrim(coalesce(p_note,''))='' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ไม่อนุมัติ'; END IF;
 SELECT coalesce(username,email) INTO who FROM public.us_users WHERE id=auth.uid();
 UPDATE public.or_sales_discount_requests SET status=CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
 reviewed_by=auth.uid(),reviewed_name=who,reviewed_at=now(),review_note=nullif(btrim(p_note),'') WHERE id=r.id;
END $$;

-- All new direct sales are protected. Historical financial snapshots remain untouched.
CREATE FUNCTION public.or_guard_sales_discount() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE state_ jsonb; role_ text; commercial_change boolean:=false;
BEGIN
 IF (TG_OP='INSERT' AND NEW.source_prebill_document_id IS NOT NULL) OR
  (TG_OP='UPDATE' AND NEW.source_prebill_document_id IS DISTINCT FROM OLD.source_prebill_document_id) THEN
  IF NEW.source_prebill_document_id IS NULL OR coalesce(current_setting('app.discount_prebill_conversion',true),'')<>NEW.source_prebill_document_id::text THEN
   RAISE EXCEPTION 'เอกสาร QT/PC ต้องเชื่อมผ่านขั้นตอนเปิดบิลเท่านั้น';
  END IF;
 END IF;
 IF TG_OP='INSERT' THEN NEW.automatic_discount_snapshot:=NULL; NEW.discount_approval_enabled:=true;
 ELSE
  NEW.automatic_discount_snapshot:=OLD.automatic_discount_snapshot;
  commercial_change:=public.or_discount_snapshot(to_jsonb(NEW),'[]')<>public.or_discount_snapshot(to_jsonb(OLD),'[]');
  NEW.discount_approval_enabled:=OLD.discount_approval_enabled OR NEW.discount_approval_enabled OR commercial_change;
 END IF;
 NEW.payment_not_required:=false;
 IF NEW.discount_approval_enabled AND NEW.source_marketplace_order_id IS NULL AND NEW.web_import_snapshot IS NULL AND upper(coalesce(NEW.bill_no,'')) NOT LIKE 'REQ%' THEN
  IF NEW.total_amount IS NULL OR NEW.price IS NULL OR NEW.discount IS NULL OR NEW.shipping_cost IS NULL THEN RAISE EXCEPTION 'กรุณาระบุยอดสินค้า ค่าส่ง ส่วนลด และยอดสุทธิ'; END IF;
  IF NEW.total_amount<0 OR NEW.discount<0 THEN RAISE EXCEPTION 'ยอดสุทธิและส่วนลดต้องไม่ติดลบ'; END IF;
  state_:=public.or_discount_state(NEW.id,to_jsonb(NEW),public.or_discount_items(NEW.id),
    coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM public.or_order_promotions p WHERE order_id=NEW.id),'[]'));
  NEW.payment_not_required:=coalesce((state_->>'zero_payment')::boolean,false);
  IF NEW.discount>0 AND NOT (state_->>'required')::boolean AND NEW.status NOT IN ('รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ','ยกเลิก') THEN
   NEW.automatic_discount_snapshot:=public.or_discount_snapshot(to_jsonb(NEW),public.or_discount_items(NEW.id));
  END IF;

  IF NEW.payment_not_required AND NEW.status='ลงข้อมูลเสร็จสิ้น' THEN
   SELECT role INTO role_ FROM public.us_users WHERE NEW.admin_user IN(username,email) ORDER BY (username=NEW.admin_user) DESC NULLS LAST LIMIT 1;
   NEW.status:=CASE WHEN upper(NEW.channel_code)='WY' THEN 'ตรวจสอบแล้ว'
    WHEN role_='sales-tr' AND ((NEW.channel_code='PUMP' AND NEW.requires_confirm_design=false) OR (NEW.channel_code<>'PUMP' AND NOT coalesce(NEW.requires_confirm_design,false))) THEN 'รอตรวจคำสั่งซื้อ'
    WHEN NEW.channel_code='PUMP' AND NEW.requires_confirm_design=false THEN 'ไม่ต้องออกแบบ' ELSE 'ตรวจสอบแล้ว' END;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zzzzzz_sales_discount BEFORE INSERT OR UPDATE ON public.or_orders FOR EACH ROW EXECUTE FUNCTION public.or_guard_sales_discount();

-- Lock the parent before line edits too; request/review/completion share this lock.
CREATE FUNCTION public.or_discount_lock_lines() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN RAISE EXCEPTION 'ไม่สามารถย้ายรายการระหว่างบิล'; END IF;
 PERFORM 1 FROM public.or_orders WHERE id=coalesce((to_jsonb(NEW)->>'order_id')::uuid,(to_jsonb(OLD)->>'order_id')::uuid) FOR UPDATE;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aa_discount_lock_lines BEFORE INSERT OR UPDATE OR DELETE ON public.or_order_items FOR EACH ROW EXECUTE FUNCTION public.or_discount_lock_lines();
CREATE TRIGGER aa_discount_lock_promotions BEFORE INSERT OR UPDATE OR DELETE ON public.or_order_promotions FOR EACH ROW EXECUTE FUNCTION public.or_discount_lock_lines();

CREATE FUNCTION public.or_validate_sales_discount() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.or_orders; id_ uuid; state_ jsonb;
BEGIN
 id_:=CASE WHEN TG_TABLE_NAME='or_orders' THEN (to_jsonb(NEW)->>'id')::uuid ELSE coalesce((to_jsonb(NEW)->>'order_id')::uuid,(to_jsonb(OLD)->>'order_id')::uuid) END;
 SELECT * INTO o FROM public.or_orders WHERE id=id_ FOR UPDATE;
 IF o.id IS NULL OR NOT o.discount_approval_enabled OR o.source_marketplace_order_id IS NOT NULL OR o.web_import_snapshot IS NOT NULL OR upper(coalesce(o.bill_no,'')) LIKE 'REQ%' THEN RETURN NULL; END IF;
 state_:=public.or_discount_state(o.id,to_jsonb(o),public.or_discount_items(o.id),coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM public.or_order_promotions p WHERE order_id=o.id),'[]'));
 UPDATE public.or_sales_discount_requests SET status=CASE WHEN o.status='ยกเลิก' THEN 'cancelled' ELSE 'stale' END
 WHERE order_id=o.id AND status IN ('pending','approved') AND (o.status='ยกเลิก' OR snapshot<>public.or_discount_snapshot(to_jsonb(o),public.or_discount_items(o.id)));
 IF o.status='ยกเลิก' THEN state_:=state_||jsonb_build_object('approved',false,'zero_payment',false); END IF;
 IF o.payment_not_required IS DISTINCT FROM coalesce((state_->>'zero_payment')::boolean,false) THEN
  UPDATE public.or_orders SET payment_not_required=coalesce((state_->>'zero_payment')::boolean,false) WHERE id=o.id;
 END IF;
 IF o.status NOT IN ('รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ','ยกเลิก') THEN
  IF o.total_amount IS NULL OR o.price IS NULL OR o.shipping_cost IS NULL OR o.discount IS NULL OR o.total_amount<>round(o.price+o.shipping_cost-o.discount,2) OR o.total_amount<0 THEN RAISE EXCEPTION 'ยอดสุทธิไม่ตรงกับสินค้า ค่าส่ง และส่วนลด'; END IF;
  IF (state_->>'required')::boolean AND NOT (state_->>'approved')::boolean THEN RAISE EXCEPTION 'ส่วนลดต้องได้รับอนุมัติจาก superadmin และตรงกับรายการปัจจุบันก่อนยืนยันบิล'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER sales_discount_final_header AFTER INSERT OR UPDATE ON public.or_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.or_validate_sales_discount();
CREATE CONSTRAINT TRIGGER sales_discount_final_items AFTER INSERT OR UPDATE OR DELETE ON public.or_order_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.or_validate_sales_discount();
CREATE CONSTRAINT TRIGGER sales_discount_final_promotions AFTER INSERT OR UPDATE OR DELETE ON public.or_order_promotions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.or_validate_sales_discount();

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
  IF NOT EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND is_active) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์'; END IF;
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
  v_discount:=least(v_discount,greatest(0,v_doc.subtotal+v_doc.shipping_cost-v_doc.promotion_discount));
  IF v_discount<=0 THEN RAISE EXCEPTION 'ไม่มียอดคงเหลือให้ขอส่วนลด'; END IF;
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

CREATE OR REPLACE FUNCTION public.rpc_review_prebill_discount(
  p_document_id UUID, p_approve BOOLEAN, p_approved_discount NUMERIC, p_note TEXT
)
RETURNS public.or_prebill_documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc public.or_prebill_documents;
  v_name TEXT;
  v_requested NUMERIC;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND role='superadmin' AND is_active) THEN RAISE EXCEPTION 'เฉพาะ superadmin เท่านั้น'; END IF;
  IF p_approve IS NULL THEN RAISE EXCEPTION 'กรุณาระบุผลพิจารณา'; END IF;
  IF NOT p_approve AND btrim(coalesce(p_note,''))='' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ไม่อนุมัติ'; END IF;
  SELECT COALESCE(username, email) INTO v_name FROM public.us_users WHERE id = auth.uid();
  SELECT * INTO v_doc FROM public.or_prebill_documents WHERE id = p_document_id FOR UPDATE;
  IF v_doc.id IS NULL OR v_doc.status <> 'pending_discount' THEN RAISE EXCEPTION 'เอกสารไม่ได้รออนุมัติ'; END IF;
  v_requested := v_doc.special_discount;
  IF p_approve THEN
    UPDATE public.or_prebill_documents SET status = 'approved',
      approved_special_discount = greatest(0, least(COALESCE(p_approved_discount, special_discount), subtotal, greatest(0,subtotal+shipping_cost-promotion_discount))),
      special_discount = greatest(0, least(COALESCE(p_approved_discount, special_discount), subtotal, greatest(0,subtotal+shipping_cost-promotion_discount))),
      approved_at = now(), approved_by = auth.uid(), approval_note = NULLIF(btrim(COALESCE(p_note,'')), ''),
      rejection_note = NULL,
      total_amount = greatest(0, subtotal + shipping_cost - promotion_discount - greatest(0, least(COALESCE(p_approved_discount, special_discount), subtotal, greatest(0,subtotal+shipping_cost-promotion_discount)))),
      updated_at = now()
    WHERE id = p_document_id RETURNING * INTO v_doc;
    INSERT INTO public.or_prebill_approval_logs(document_id, action, requested_discount, approved_discount, note, actor_id, actor_name)
    VALUES (p_document_id, 'approved', v_requested, v_doc.approved_special_discount, p_note, auth.uid(), v_name);
  ELSE
    UPDATE public.or_prebill_documents SET status = 'rejected', rejection_note = NULLIF(btrim(COALESCE(p_note,'')), ''),
      special_discount = 0, total_amount = greatest(0, subtotal + shipping_cost - promotion_discount), updated_at = now()
    WHERE id = p_document_id RETURNING * INTO v_doc;
    INSERT INTO public.or_prebill_approval_logs(document_id, action, requested_discount, note, actor_id, actor_name)
    VALUES (p_document_id, 'rejected', v_requested, p_note, auth.uid(), v_name);
  END IF;
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

  PERFORM set_config('app.discount_prebill_conversion',v_doc.id::text,true);
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

  PERFORM set_config('app.discount_prebill_conversion','',true);
  RETURN jsonb_build_object('order_id', v_order_id, 'bill_no', v_bill_no);
END;
$$;

-- QT/PC approvals keep their existing RPC/audit trail. Editing approved financial
-- data invalidates the approval even for superadmin, before another conversion.
CREATE FUNCTION public.or_prebill_discount_invalidate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE items_ jsonb:=coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM public.or_prebill_items i WHERE document_id=NEW.id),'[]');
 old_snap jsonb:=public.or_prebill_discount_snapshot(to_jsonb(OLD),items_);
 new_snap jsonb:=public.or_prebill_discount_snapshot(to_jsonb(NEW),items_);
BEGIN
 IF NEW.converted_order_id IS DISTINCT FROM OLD.converted_order_id AND NEW.converted_order_id IS NOT NULL THEN
  IF OLD.converted_order_id IS NOT NULL OR NEW.status<>'converted' OR coalesce(current_setting('app.discount_prebill_conversion',true),'')<>NEW.id::text THEN
   RAISE EXCEPTION 'ไม่สามารถเปลี่ยนบิลอ้างอิงเพื่อใช้ผลอนุมัติ QT/PC ซ้ำ';
  END IF;
 END IF;
 IF NEW.status='pending_discount' AND OLD.status<>'pending_discount' THEN NEW.discount_review_snapshot:=new_snap;
 ELSE NEW.discount_review_snapshot:=coalesce(OLD.discount_review_snapshot,CASE WHEN OLD.status IN ('approved','pending_discount') THEN old_snap END); END IF;
 IF OLD.status IN ('approved','pending_discount') AND NEW.status=OLD.status AND new_snap<>old_snap THEN
  NEW.status:='active'; NEW.approved_at:=NULL; NEW.approved_by:=NULL; NEW.approved_special_discount:=NULL;
 END IF;
 IF NEW.status='approved' AND OLD.status<>'approved' THEN
  IF NOT EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND role='superadmin' AND is_active) THEN RAISE EXCEPTION 'เฉพาะ superadmin เท่านั้น'; END IF;
  IF OLD.discount_review_snapshot IS NOT NULL AND OLD.discount_review_snapshot<>old_snap THEN RAISE EXCEPTION 'รายการ QT/PC เปลี่ยนแล้ว ต้องส่งขออนุมัติใหม่'; END IF;
  IF NEW.valid_until<(now() AT TIME ZONE 'Asia/Bangkok')::date THEN RAISE EXCEPTION 'เอกสารหมดอายุ'; END IF;
  NEW.discount_review_snapshot:=new_snap;
 END IF;
 IF NEW.status='converted' AND NEW.special_discount>0 AND (OLD.status<>'approved' OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL OR NEW.approved_special_discount IS DISTINCT FROM NEW.special_discount
 OR (OLD.discount_review_snapshot IS NOT NULL AND OLD.discount_review_snapshot<>old_snap)) THEN
  RAISE EXCEPTION 'ส่วนลด QT/PC ต้องได้รับอนุมัติและตรงกับรายการก่อนเปิดบิล';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_prebill_discount_invalidate BEFORE UPDATE ON public.or_prebill_documents FOR EACH ROW EXECUTE FUNCTION public.or_prebill_discount_invalidate();
CREATE FUNCTION public.or_prebill_discount_lock_items() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.or_prebill_documents;
BEGIN
 IF TG_OP='UPDATE' AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN RAISE EXCEPTION 'ไม่สามารถย้ายรายการระหว่าง QT/PC'; END IF;
 SELECT * INTO d FROM public.or_prebill_documents WHERE id=coalesce((to_jsonb(NEW)->>'document_id')::uuid,(to_jsonb(OLD)->>'document_id')::uuid) FOR UPDATE;
 -- Capture pre-migration approvals only when an actual edit is attempted.
 IF d.status IN ('approved','pending_discount') AND d.discount_review_snapshot IS NULL THEN
  UPDATE public.or_prebill_documents SET updated_at=updated_at WHERE id=d.id;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aa_prebill_discount_lock_items BEFORE INSERT OR UPDATE OR DELETE ON public.or_prebill_items FOR EACH ROW EXECUTE FUNCTION public.or_prebill_discount_lock_items();
CREATE FUNCTION public.or_prebill_discount_item_invalidate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.or_prebill_documents;
BEGIN
 SELECT * INTO d FROM public.or_prebill_documents WHERE id=coalesce((to_jsonb(NEW)->>'document_id')::uuid,(to_jsonb(OLD)->>'document_id')::uuid) FOR UPDATE;
 IF d.status IN ('approved','pending_discount') AND d.discount_review_snapshot IS NOT NULL AND d.discount_review_snapshot<>
  public.or_prebill_discount_snapshot(to_jsonb(d),coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM public.or_prebill_items i WHERE document_id=d.id),'[]')) THEN
  UPDATE public.or_prebill_documents SET status='active',approved_at=NULL,approved_by=NULL,approved_special_discount=NULL WHERE id=d.id;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER zz_prebill_discount_item_invalidate AFTER INSERT OR UPDATE OR DELETE ON public.or_prebill_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.or_prebill_discount_item_invalidate();

CREATE FUNCTION public.rpc_discount_approval_queue(p_status text DEFAULT 'pending',p_type text DEFAULT 'all',p_offset int DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result_ jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND is_active AND role='superadmin') THEN RAISE EXCEPTION 'เฉพาะ superadmin เท่านั้น'; END IF;
 WITH rows_ AS (
 SELECT 'sale'::text source,r.id,o.id document_id,o.bill_no document_no,r.requested_name owner_name,r.reason,
 (r.snapshot->>'price')::numeric subtotal,(r.snapshot->>'shipping_cost')::numeric shipping_cost,
 (r.snapshot->>'discount')::numeric discount,(r.snapshot->>'total_amount')::numeric total_amount,r.created_at,
 CASE WHEN o.status='ยกเลิก' THEN 'cancelled' WHEN r.status IN ('pending','approved') AND r.snapshot<>public.or_discount_snapshot(to_jsonb(o),public.or_discount_items(o.id)) THEN 'stale' ELSE r.status END status,
 r.reviewed_name,r.reviewed_at,r.review_note,r.snapshot||jsonb_build_object('items',coalesce((SELECT jsonb_agg(x||jsonb_build_object('product_name',p.product_name)) FROM jsonb_array_elements(r.snapshot->'items') x LEFT JOIN public.pr_products p ON p.id=(x->>'product_id')::uuid),'[]')) snapshot
 FROM public.or_sales_discount_requests r JOIN public.or_orders o ON o.id=r.order_id
 UNION ALL
 SELECT CASE d.document_type WHEN 'quotation' THEN 'QT' ELSE 'PC' END,d.id,d.id,d.document_no,d.owner_name,d.discount_request_note,
 coalesce((d.discount_review_snapshot->>'price')::numeric,d.subtotal),coalesce((d.discount_review_snapshot->>'shipping_cost')::numeric,d.shipping_cost),coalesce((d.discount_review_snapshot->>'discount')::numeric,d.promotion_discount+d.special_discount),coalesce((d.discount_review_snapshot->>'total_amount')::numeric,d.total_amount),coalesce(d.discount_requested_at,d.created_at),
 CASE WHEN d.status='pending_discount' AND d.valid_until>=(now() AT TIME ZONE 'Asia/Bangkok')::date THEN 'pending'
 WHEN d.status IN ('approved','converted') AND d.approved_by IS NOT NULL THEN 'approved'
 WHEN d.status='rejected' THEN 'rejected' WHEN d.status='cancelled' THEN 'cancelled' WHEN d.status='pending_discount' THEN 'expired' ELSE 'stale' END,
 u.username,d.approved_at,coalesce(d.approval_note,d.rejection_note),jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM public.or_prebill_items i WHERE document_id=d.id),'[]'))
 FROM public.or_prebill_documents d LEFT JOIN public.us_users u ON u.id=d.approved_by
 WHERE d.discount_requested_at IS NOT NULL
 ), filtered AS (SELECT * FROM rows_ WHERE (p_status='all' OR status=p_status) AND (p_type='all' OR source=p_type)),
 page AS (SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT 50 OFFSET greatest(0,p_offset))
 SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]'),
 'count',(SELECT count(*) FROM filtered),'pending_count',(SELECT count(*) FROM rows_ WHERE status='pending')) INTO result_;
 RETURN result_;
END $$;

-- Only RPCs may create or decide requests. Helpers are internal to definer functions.
REVOKE ALL ON FUNCTION public.or_discount_lines(jsonb),public.or_discount_snapshot(jsonb,jsonb),public.or_prebill_discount_snapshot(jsonb,jsonb),public.or_discount_items(uuid),
 public.or_discount_group_value(jsonb,jsonb,int,boolean),public.or_discount_automatic(jsonb,jsonb,jsonb),public.or_discount_state(uuid,jsonb,jsonb,jsonb),
 public.or_guard_sales_discount(),public.or_discount_lock_lines(),public.or_validate_sales_discount(),public.or_prebill_discount_invalidate(),public.or_prebill_discount_lock_items(),public.or_prebill_discount_item_invalidate() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.or_discount_can_manage(uuid),public.rpc_check_order_discount(uuid,jsonb,jsonb,jsonb),public.rpc_request_sales_discount(uuid,text),
 public.rpc_review_sales_discount(uuid,boolean,text),public.rpc_discount_approval_queue(text,text,int),public.rpc_request_prebill_discount(uuid,text,numeric,text),public.rpc_review_prebill_discount(uuid,boolean,numeric,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.or_discount_can_manage(uuid),public.rpc_check_order_discount(uuid,jsonb,jsonb,jsonb),public.rpc_request_sales_discount(uuid,text),
 public.rpc_review_sales_discount(uuid,boolean,text),public.rpc_discount_approval_queue(text,text,int),public.rpc_request_prebill_discount(uuid,text,numeric,text),public.rpc_review_prebill_discount(uuid,boolean,numeric,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.bank_sales_workspace(p_from DATE DEFAULT NULL,p_to DATE DEFAULT NULL,
 p_status TEXT DEFAULT 'pending',p_search TEXT DEFAULT '',p_channel TEXT DEFAULT '',p_method TEXT DEFAULT '',p_offset INTEGER DEFAULT 0)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_result JSONB;
BEGIN
 PERFORM public.bank_reconciliation_require_authorized_role();
 WITH base AS (
  SELECT o.id,o.bill_no,o.created_at,o.channel_code,o.payment_method,o.total_amount,
   COALESCE(a.amount,0) bank_received,COALESCE(c.amount,0) certified_received,
   COALESCE(s.amount,0)+COALESCE(m.amount,0) evidence_amount,COALESCE(c.cash,0) certified_cash,COALESCE(c.other,0) certified_other,
   s.payment_at,
   CASE WHEN COALESCE(a.amount,0)+COALESCE(c.amount,0)>o.total_amount+0.01 THEN 'overpaid'
    WHEN ((upper(COALESCE(o.bill_no,'')) LIKE 'REQ%' AND o.total_amount<=0.01) OR (o.payment_not_required AND o.total_amount=0))
      AND COALESCE(a.amount,0)+COALESCE(c.amount,0)<=0.01 THEN 'no_payment'
    WHEN COALESCE(a.amount,0)+COALESCE(c.amount,0)>=o.total_amount-0.01 THEN CASE WHEN COALESCE(c.amount,0)>0 THEN 'certified' ELSE 'matched' END
    WHEN COALESCE(a.amount,0)+COALESCE(c.amount,0)>0 THEN 'partial'
    WHEN COALESCE(s.amount,0)+COALESCE(m.amount,0)>0 THEN 'waiting_bank' ELSE 'no_evidence' END reconciliation_state,
   CASE WHEN coverage.payment_count=0 OR coverage.has_unknown THEN 'unknown'
    WHEN coverage.uncovered THEN 'not_uploaded' ELSE 'covered' END statement_coverage
  FROM public.or_orders o
  LEFT JOIN LATERAL (SELECT sum(allocated_amount) amount FROM public.ac_bank_reconciliation_allocations WHERE order_id=o.id) a ON TRUE
  LEFT JOIN LATERAL (SELECT sum(amount) amount,sum(amount) FILTER(WHERE receipt_method='cash') cash,sum(amount) FILTER(WHERE receipt_method<>'cash') other FROM public.ac_order_receipt_certifications WHERE order_id=o.id AND revoked_at IS NULL) c ON TRUE
  LEFT JOIN LATERAL (SELECT sum(verified_amount) amount,max(easyslip_date) payment_at,max(NULLIF(easyslip_receiver_account,'')) receiver_account
    FROM public.ac_verified_slips WHERE order_id=o.id AND COALESCE(is_deleted,false)=false AND verified_amount>0 AND easyslip_date IS NOT NULL) s ON TRUE
  LEFT JOIN LATERAL (SELECT sum(transfer_amount) amount,max(CASE WHEN transfer_date ~ '^\d{4}-\d{2}-\d{2}$' THEN transfer_date::DATE END) payment_on
    FROM public.ac_manual_slip_checks WHERE order_id=o.id AND status='approved'
    AND NOT EXISTS (SELECT 1 FROM public.ac_verified_slips vs WHERE vs.order_id=o.id AND COALESCE(vs.is_deleted,false)=false AND vs.easyslip_date IS NOT NULL AND vs.verified_amount>0)) m ON TRUE
  LEFT JOIN LATERAL (
   SELECT count(*) payment_count,bool_or(p.payment_on IS NULL OR NOT EXISTS(
     SELECT 1 FROM public.bank_settings b WHERE
      (p.receiver_account IS NOT NULL AND right(regexp_replace(p.receiver_account,'\D','','g'),4)=right(regexp_replace(b.account_number,'\D','','g'),4)
       AND (p.bank_code IS NULL OR b.bank_code=p.bank_code))
      OR (p.receiver_account IS NULL AND EXISTS(SELECT 1 FROM public.bank_settings_channels bc WHERE bc.bank_setting_id=b.id AND bc.channel_code=o.channel_code))
    )) has_unknown,
    bool_or(EXISTS(SELECT 1 FROM public.bank_settings b WHERE
      ((p.receiver_account IS NOT NULL AND right(regexp_replace(p.receiver_account,'\D','','g'),4)=right(regexp_replace(b.account_number,'\D','','g'),4)
        AND (p.bank_code IS NULL OR b.bank_code=p.bank_code))
       OR (p.receiver_account IS NULL AND EXISTS(SELECT 1 FROM public.bank_settings_channels bc WHERE bc.bank_setting_id=b.id AND bc.channel_code=o.channel_code)))
      AND NOT EXISTS(SELECT 1 FROM public.ac_bank_statement_imports i WHERE i.bank_setting_id=b.id AND p.payment_on BETWEEN i.period_start AND i.period_end)
    )) uncovered
   FROM (
    SELECT (vs.easyslip_date AT TIME ZONE 'Asia/Bangkok')::DATE payment_on,
      NULLIF(regexp_replace(CASE
        WHEN COALESCE(vs.easyslip_receiver_account,'') ~ '[xX*•]' AND NULLIF(btrim(vs.expected_bank_account),'') IS NOT NULL THEN vs.expected_bank_account
        ELSE COALESCE(NULLIF(btrim(vs.easyslip_receiver_account),''),vs.expected_bank_account,'') END,'\D','','g'),'') receiver_account,
      CASE WHEN (COALESCE(vs.easyslip_receiver_account,'') ~ '[xX*•]' OR NULLIF(btrim(vs.easyslip_receiver_account),'') IS NULL)
        AND NULLIF(btrim(vs.expected_bank_account),'') IS NOT NULL
        THEN COALESCE(NULLIF(btrim(vs.expected_bank_code),''),NULLIF(btrim(vs.easyslip_receiver_bank_id),''))
        ELSE NULLIF(btrim(vs.easyslip_receiver_bank_id),'') END bank_code
    FROM public.ac_verified_slips vs WHERE vs.order_id=o.id AND COALESCE(vs.is_deleted,false)=false AND vs.verified_amount>0 AND vs.easyslip_date IS NOT NULL
    UNION ALL
    SELECT CASE WHEN ms.transfer_date ~ '^\d{4}-\d{2}-\d{2}$' THEN ms.transfer_date::DATE END,NULL::TEXT,NULL::TEXT
    FROM public.ac_manual_slip_checks ms WHERE ms.order_id=o.id AND ms.status='approved'
   ) p
  ) coverage ON TRUE
  WHERE COALESCE(o.status,'') NOT IN ('ยกเลิก','รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ')
   AND COALESCE(o.channel_code,'') NOT IN ('SPTR','FSPTR','TTTR','LZTR','PGTR','WY')
   AND o.created_at >= TIMESTAMPTZ '2026-10-01 00:00:00+07'
   AND (p_from IS NULL OR o.created_at >= p_from::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
   AND (p_to IS NULL OR o.created_at < (p_to+1)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
   AND (p_channel='' OR o.channel_code=p_channel) AND (p_method='' OR COALESCE(o.payment_method,'')=p_method)
   AND (p_search='' OR strpos(lower(o.bill_no),lower(p_search))>0)
 ), filtered AS (SELECT * FROM base WHERE p_status='all' OR reconciliation_state=p_status
   OR p_status='pending' AND reconciliation_state IN ('partial','waiting_bank','no_evidence','overpaid')),
 page AS (SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT 50 OFFSET greatest(p_offset,0))
 SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]'::JSONB),
  'count',(SELECT count(*) FROM filtered),'summary',(SELECT jsonb_build_object('bills',count(*),'sales',COALESCE(sum(total_amount),0),
   'bank',COALESCE(sum(bank_received),0),'certified',COALESCE(sum(certified_received),0),'cash',COALESCE(sum(certified_cash),0),'other_certified',COALESCE(sum(certified_other),0),'outstanding',COALESCE(sum(greatest(total_amount-bank_received-certified_received,0)),0)) FROM base),
  'channels',(SELECT COALESCE(jsonb_agg(channel_code),'[]'::JSONB) FROM (SELECT DISTINCT channel_code FROM public.or_orders WHERE COALESCE(channel_code,'') NOT IN ('SPTR','FSPTR','TTTR','LZTR','PGTR','WY') AND created_at >= TIMESTAMPTZ '2026-10-01 00:00:00+07' AND COALESCE(status,'') NOT IN ('ยกเลิก','รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ') ORDER BY channel_code) channels),
  'states',COALESCE((SELECT jsonb_object_agg(reconciliation_state,n) FROM (SELECT reconciliation_state,count(*) n FROM base GROUP BY reconciliation_state) counts),'{}'::JSONB)) INTO v_result;
 RETURN v_result;
END $$;


COMMIT;
NOTIFY pgrst,'reload schema';
