-- Exclude Ecommerce and customer pickup from carrier pickup tracking.
BEGIN;

CREATE OR REPLACE FUNCTION public.tr_delivery_tracking_workspace(
 p_from DATE DEFAULT NULL,p_to DATE DEFAULT NULL,p_status TEXT DEFAULT 'all',
 p_search TEXT DEFAULT '',p_carrier TEXT DEFAULT '',p_channel TEXT DEFAULT '',
 p_date_basis TEXT DEFAULT 'created',p_offset INTEGER DEFAULT 0)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_result JSONB;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid()
  AND role IN ('superadmin','admin','admin-tr','sales-tr','packing_staff')) THEN
  RAISE EXCEPTION 'ไม่มีสิทธิ์ตรวจสอบการส่ง';
 END IF;
 IF p_date_basis NOT IN ('created','packed') THEN RAISE EXCEPTION 'วันที่กรองไม่ถูกต้อง'; END IF;
 WITH scoped AS (
  SELECT o.id,o.bill_no,o.channel_order_no,o.created_at,o.channel_code,o.tracking_number,
   o.recipient_name,o.customer_name,o.status erp_status,o.shipped_time packed_at,
   COALESCE(o.fulfillment_method='self_pickup',c.is_self_pickup,false) self_pickup
  FROM public.or_orders o LEFT JOIN public.channels c ON c.channel_code=o.channel_code
  WHERE o.created_at >= TIMESTAMPTZ '2026-09-01 00:00:00+07'
   AND COALESCE(o.channel_code,'') NOT IN ('SPTR','FSPTR','TTTR','LZTR','PGTR','WY')
   AND o.fulfillment_method IS DISTINCT FROM 'self_pickup'
   AND NOT COALESCE(c.is_self_pickup,false)
   AND COALESCE(o.status,'') NOT IN ('ยกเลิก','รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ')
   AND (p_from IS NULL OR CASE WHEN p_date_basis='packed' THEN o.shipped_time ELSE o.created_at END >= p_from::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
   AND (p_to IS NULL OR CASE WHEN p_date_basis='packed' THEN o.shipped_time ELSE o.created_at END < (p_to+1)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
   AND (p_channel='' OR o.channel_code=p_channel)
   AND (p_search='' OR strpos(lower(concat_ws(' ',o.bill_no,o.channel_order_no,o.tracking_number,o.recipient_name,o.customer_name)),lower(p_search))>0)
 ), evidence AS (
  SELECT o.*,r.id source_id,r.import_id,r.file_name,r.carrier,r.pickup_at,r.tracking_no carrier_tracking,
   r.order_no carrier_order_no,r.raw_data,r.match_detail,r.match_status,r.has_duplicate,
   r.candidate_count,r.keys_match,r.review_status,
   COALESCE(NULLIF(btrim(r.raw_data->>'สถานะงานรับ'),''),'') pickup_status
  FROM scoped o LEFT JOIN LATERAL (
   SELECT d.*,i.file_name,i.carrier,i.uploaded_at,
    (SELECT count(*) FROM public.or_orders other WHERE
      (d.tracking_no_normalized<>'' AND public.tr_normalize_delivery_key(other.tracking_number)=d.tracking_no_normalized)
      OR (d.order_no_normalized<>'' AND (public.tr_normalize_delivery_key(other.bill_no)=d.order_no_normalized
       OR public.tr_normalize_delivery_key(other.channel_order_no)=d.order_no_normalized))) candidate_count,
    (d.match_status='manual_match' AND d.order_id=o.id OR
     (d.tracking_no_normalized<>'' AND d.tracking_no_normalized=public.tr_normalize_delivery_key(o.tracking_number)
      AND d.order_no_normalized<>'' AND d.order_no_normalized IN
       (public.tr_normalize_delivery_key(o.bill_no),public.tr_normalize_delivery_key(o.channel_order_no))
      AND (d.order_id IS NULL OR d.order_id=o.id))) keys_match
   FROM public.tr_delivery_check_rows d JOIN public.tr_delivery_check_imports i ON i.id=d.import_id
   WHERE d.source_kind='carrier' AND NOT d.is_consignment
    AND (d.order_id=o.id OR (d.tracking_no_normalized<>'' AND d.tracking_no_normalized=public.tr_normalize_delivery_key(o.tracking_number))
     OR (d.order_no_normalized<>'' AND d.order_no_normalized IN
       (public.tr_normalize_delivery_key(o.bill_no),public.tr_normalize_delivery_key(o.channel_order_no))))
   ORDER BY d.pickup_at DESC NULLS LAST,i.uploaded_at DESC,d.source_row_number DESC,d.id LIMIT 1
  ) r ON TRUE
 ), classified AS (
  SELECT e.*,CASE
   WHEN self_pickup THEN 'self_pickup'
   WHEN source_id IS NOT NULL AND (NOT keys_match OR has_duplicate OR (candidate_count<>1 AND match_status<>'manual_match')) THEN 'needs_review'
   WHEN source_id IS NOT NULL AND lower(pickup_status) IN ('รับพัสดุไม่สำเร็จ','รับไม่สำเร็จ','ยกเลิก') THEN 'pickup_issue'
   WHEN source_id IS NOT NULL AND lower(pickup_status) IN ('รับพัสดุแล้ว','รับพัสดุสำเร็จ','รับพัสดุเรียบร้อย','picked up','picked_up') THEN 'received'
   WHEN source_id IS NOT NULL AND pickup_status='ยังไม่ได้รับพัสดุ' THEN 'awaiting_pickup'
   WHEN source_id IS NOT NULL THEN 'carrier_recorded'
   WHEN packed_at IS NULL THEN 'pending_pack'
   WHEN public.tr_normalize_delivery_key(tracking_number)='' THEN 'no_tracking'
   ELSE 'awaiting_carrier' END delivery_state
  FROM evidence e
 ), base AS (SELECT * FROM classified WHERE p_carrier='' OR carrier=p_carrier),
 filtered AS (SELECT * FROM base WHERE p_status='all' OR delivery_state=p_status
  OR (p_status='issues' AND delivery_state IN ('needs_review','pickup_issue','carrier_recorded'))
  OR (p_status='pending' AND delivery_state NOT IN ('received','self_pickup'))),
 page AS (SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT 50 OFFSET greatest(p_offset,0))
 SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(to_jsonb(page)-'raw_data') FROM page),'[]'::JSONB),
  'count',(SELECT count(*) FROM filtered),'summary',jsonb_build_object('bills',(SELECT count(*) FROM base),
   'states',COALESCE((SELECT jsonb_object_agg(delivery_state,n) FROM (SELECT delivery_state,count(*) n FROM base GROUP BY delivery_state) s),'{}'::JSONB)),
  'channels',(SELECT COALESCE(jsonb_agg(channel_code),'[]'::JSONB) FROM (SELECT DISTINCT o.channel_code FROM public.or_orders o LEFT JOIN public.channels ch ON ch.channel_code=o.channel_code
   WHERE COALESCE(o.channel_code,'') NOT IN ('SPTR','FSPTR','TTTR','LZTR','PGTR','WY')
   AND o.fulfillment_method IS DISTINCT FROM 'self_pickup' AND NOT COALESCE(ch.is_self_pickup,false)
   AND o.created_at>=TIMESTAMPTZ '2026-09-01 00:00:00+07' AND COALESCE(o.status,'') NOT IN ('ยกเลิก','รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ') ORDER BY o.channel_code) c),
  'carriers',(SELECT COALESCE(jsonb_agg(carrier),'[]'::JSONB) FROM (SELECT DISTINCT carrier FROM public.tr_delivery_check_imports ORDER BY carrier) c)) INTO v_result;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.tr_delivery_tracking_workspace(DATE,DATE,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.tr_delivery_tracking_workspace(DATE,DATE,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) TO authenticated;
COMMIT;
