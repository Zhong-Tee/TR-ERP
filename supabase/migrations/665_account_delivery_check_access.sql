-- Allow Accounting to use every Delivery check action.
-- Preserve the current reconciliation logic and existing role permissions.
-- The import definition retains migration 602's cancelled-order exclusions.
BEGIN;

INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES ('account', 'transport', 'ทวนสอบขนส่ง', true)
ON CONFLICT (role, menu_key) DO UPDATE
SET has_access = EXCLUDED.has_access, menu_name = EXCLUDED.menu_name;

ALTER POLICY tr_delivery_check_imports_access ON public.tr_delivery_check_imports
  USING (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid()
    AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff', 'account')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid()
    AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff', 'account')));

ALTER POLICY tr_delivery_check_rows_access ON public.tr_delivery_check_rows
  USING (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid()
    AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff', 'account')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid()
    AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff', 'account')));

CREATE OR REPLACE FUNCTION public.tr_delivery_check_import(
  p_carrier TEXT,
  p_file_name TEXT,
  p_file_hash TEXT,
  p_sheet_name TEXT,
  p_pickup_date_from DATE,
  p_pickup_date_to DATE,
  p_warnings JSONB,
  p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_import_id UUID;
  v_item JSONB;
  v_order RECORD;
  v_candidate_count INTEGER;
  v_order_no TEXT;
  v_tracking_no TEXT;
  v_order_key TEXT;
  v_tracking_key TEXT;
  v_is_consignment BOOLEAN;
  v_match_status TEXT;
  v_match_method TEXT;
  v_match_detail TEXT;
  v_order_id UUID;
  v_source_count INTEGER := 0;
  v_matched_count INTEGER := 0;
  v_issue_count INTEGER := 0;
  v_consignment_count INTEGER := 0;
  v_system_only_count INTEGER := 0;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์นำเข้าไฟล์ตรวจสอบการส่ง';
  END IF;
  IF nullif(btrim(p_carrier), '') IS NULL THEN
    RAISE EXCEPTION 'กรุณาเลือกบริษัทขนส่ง';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'ไฟล์ไม่มีรายการสำหรับนำเข้า';
  END IF;

  INSERT INTO public.tr_delivery_check_imports (
    carrier, file_name, file_hash, sheet_name, pickup_date_from, pickup_date_to,
    source_row_count, warnings, uploaded_by
  ) VALUES (
    upper(btrim(p_carrier)), p_file_name, p_file_hash, p_sheet_name,
    p_pickup_date_from, p_pickup_date_to, jsonb_array_length(p_rows),
    coalesce(p_warnings, '[]'::JSONB), auth.uid()
  ) RETURNING id INTO v_import_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    v_source_count := v_source_count + 1;
    v_order_no := nullif(btrim(coalesce(v_item->>'order_no', '')), '');
    v_tracking_no := nullif(btrim(coalesce(v_item->>'tracking_no', '')), '');
    v_order_key := public.tr_normalize_delivery_key(v_order_no);
    v_tracking_key := public.tr_normalize_delivery_key(v_tracking_no);
    v_is_consignment := coalesce((v_item->>'is_consignment')::BOOLEAN, false);
    v_match_status := 'unmatched';
    v_match_method := NULL;
    v_match_detail := NULL;
    v_order_id := NULL;

    IF v_is_consignment THEN
      v_match_status := 'consignment';
      v_consignment_count := v_consignment_count + 1;
    ELSIF v_tracking_key = '' THEN
      v_match_status := 'invalid';
      v_match_detail := 'ไม่มี Tracking No.';
      v_issue_count := v_issue_count + 1;
    ELSE
      SELECT count(*)
      INTO v_candidate_count
      FROM public.or_orders o
      WHERE COALESCE(o.status, '') <> 'ยกเลิก'
        AND public.tr_normalize_delivery_key(o.tracking_number) = v_tracking_key;

      IF v_candidate_count = 1 THEN
        SELECT o.id, o.bill_no, o.channel_order_no, o.tracking_number
        INTO v_order
        FROM public.or_orders o
        WHERE COALESCE(o.status, '') <> 'ยกเลิก'
        AND public.tr_normalize_delivery_key(o.tracking_number) = v_tracking_key
        LIMIT 1;
        v_order_id := v_order.id;
        v_match_method := 'tracking_number';
        IF v_order_key <> '' AND v_order_key IN (
          public.tr_normalize_delivery_key(v_order.bill_no),
          public.tr_normalize_delivery_key(v_order.channel_order_no)
        ) THEN
          v_match_status := 'matched';
          v_matched_count := v_matched_count + 1;
        ELSE
          v_match_status := 'tracking_only';
          v_match_detail := 'Tracking ตรง แต่ Order No. ไม่ตรงกับเลขบิลในระบบ';
          v_issue_count := v_issue_count + 1;
        END IF;
      ELSIF v_candidate_count > 1 THEN
        v_match_status := 'ambiguous';
        v_match_detail := 'พบ Tracking ซ้ำในระบบมากกว่า 1 บิล';
        v_issue_count := v_issue_count + 1;
      ELSE
        SELECT count(*)
        INTO v_candidate_count
        FROM public.or_orders o
        WHERE COALESCE(o.status, '') <> 'ยกเลิก'
          AND v_order_key <> '' AND v_order_key IN (
          public.tr_normalize_delivery_key(o.bill_no),
          public.tr_normalize_delivery_key(o.channel_order_no)
        );

        IF v_candidate_count = 1 THEN
          SELECT o.id, o.bill_no, o.channel_order_no, o.tracking_number
          INTO v_order
          FROM public.or_orders o
          WHERE COALESCE(o.status, '') <> 'ยกเลิก'
          AND v_order_key <> '' AND v_order_key IN (
            public.tr_normalize_delivery_key(o.bill_no),
            public.tr_normalize_delivery_key(o.channel_order_no)
          )
          LIMIT 1;
          v_order_id := v_order.id;
          v_match_method := CASE
            WHEN v_order_key = public.tr_normalize_delivery_key(v_order.bill_no) THEN 'bill_no'
            ELSE 'channel_order_no'
          END;
          v_match_status := 'order_only';
          v_match_detail := 'Order No. ตรง แต่ Tracking ไม่ตรงกับระบบ';
          v_issue_count := v_issue_count + 1;
        ELSIF v_candidate_count > 1 THEN
          v_match_status := 'ambiguous';
          v_match_detail := 'พบ Order No. ซ้ำในระบบมากกว่า 1 บิล';
          v_issue_count := v_issue_count + 1;
        ELSE
          v_match_status := 'unmatched';
          v_match_detail := 'ไม่พบเลขพัสดุหรือเลขบิลในระบบ';
          v_issue_count := v_issue_count + 1;
        END IF;
      END IF;
    END IF;

    INSERT INTO public.tr_delivery_check_rows (
      import_id, source_kind, source_row_number, pickup_at,
      order_no, order_no_normalized, tracking_no, tracking_no_normalized,
      sender, consignee, consignee_phone, consignee_address,
      is_consignment, note, order_id, match_status, match_method, match_detail, raw_data
    ) VALUES (
      v_import_id, 'carrier', (v_item->>'source_row_number')::INTEGER,
      nullif(v_item->>'pickup_at', '')::TIMESTAMPTZ,
      v_order_no, v_order_key, v_tracking_no, v_tracking_key,
      nullif(v_item->>'sender', ''), nullif(v_item->>'consignee', ''),
      nullif(v_item->>'consignee_phone', ''), nullif(v_item->>'consignee_address', ''),
      v_is_consignment, nullif(v_item->>'note', ''), v_order_id,
      v_match_status, v_match_method, v_match_detail, coalesce(v_item->'raw_data', '{}'::JSONB)
    );
  END LOOP;

  UPDATE public.tr_delivery_check_rows r
  SET has_duplicate = true,
      match_detail = concat_ws(' / ', r.match_detail, 'Tracking ซ้ำในไฟล์')
  WHERE r.import_id = v_import_id
    AND r.source_kind = 'carrier'
    AND r.tracking_no_normalized <> ''
    AND EXISTS (
      SELECT 1 FROM public.tr_delivery_check_rows duplicate_row
      WHERE duplicate_row.import_id = r.import_id
        AND duplicate_row.source_kind = 'carrier'
        AND duplicate_row.tracking_no_normalized = r.tracking_no_normalized
        AND duplicate_row.id <> r.id
    );

  -- Add bills shipped by the selected carrier during the pickup-file dates but
  -- absent from the carrier file. Consignments never create a missing ERP bill.
  INSERT INTO public.tr_delivery_check_rows (
    import_id, source_kind, pickup_at, order_no, order_no_normalized,
    tracking_no, tracking_no_normalized, sender, consignee,
    consignee_phone, consignee_address, order_id, match_status, match_detail, raw_data
  )
  SELECT
    v_import_id, 'system', o.shipped_time, o.bill_no,
    public.tr_normalize_delivery_key(o.bill_no), o.tracking_number,
    public.tr_normalize_delivery_key(o.tracking_number), o.channel_code,
    coalesce(o.recipient_name, o.customer_name),
    nullif(o.billing_details->>'mobile_phone', ''), o.customer_address,
    o.id, 'system_only', 'ระบบระบุว่าส่งแล้ว แต่ไม่พบในไฟล์ขนส่ง',
    jsonb_build_object('bill_no', o.bill_no, 'channel_code', o.channel_code, 'shipped_time', o.shipped_time)
  FROM public.or_orders o
  LEFT JOIN public.channels c ON c.channel_code = o.channel_code
  WHERE o.status = 'จัดส่งแล้ว'
    AND coalesce(o.fulfillment_method, CASE WHEN coalesce(c.is_self_pickup, false) THEN 'self_pickup' ELSE 'shipping' END) = 'shipping'
    AND upper(coalesce(c.default_carrier, 'OTHER')) = upper(btrim(p_carrier))
    AND (o.shipped_time AT TIME ZONE 'Asia/Bangkok')::DATE BETWEEN p_pickup_date_from AND p_pickup_date_to
    AND NOT EXISTS (
      SELECT 1 FROM public.tr_delivery_check_rows r
      WHERE r.import_id = v_import_id AND r.order_id = o.id
    );

  GET DIAGNOSTICS v_system_only_count = ROW_COUNT;
  SELECT count(*)
  INTO v_issue_count
  FROM public.tr_delivery_check_rows
  WHERE import_id = v_import_id
    AND (match_status NOT IN ('matched', 'manual_match', 'consignment') OR has_duplicate);

  UPDATE public.tr_delivery_check_imports
  SET source_row_count = v_source_count,
      matched_count = v_matched_count,
      issue_count = v_issue_count,
      consignment_count = v_consignment_count,
      system_only_count = v_system_only_count,
      updated_at = now()
  WHERE id = v_import_id;

  RETURN jsonb_build_object(
    'import_id', v_import_id,
    'source_row_count', v_source_count,
    'matched_count', v_matched_count,
    'issue_count', v_issue_count,
    'consignment_count', v_consignment_count,
    'system_only_count', v_system_only_count
  );
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'ไฟล์นี้เคยนำเข้าสำหรับขนส่งรายนี้แล้ว';
END;
$$;

CREATE OR REPLACE FUNCTION public.tr_delivery_check_find_previous_duplicates(
  p_tracking_keys TEXT[]
)
RETURNS TABLE (
  tracking_no_normalized TEXT,
  tracking_no TEXT,
  previous_import_id UUID,
  previous_file_name TEXT,
  previous_carrier TEXT,
  previous_imported_at TIMESTAMPTZ,
  previous_pickup_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตรวจประวัติไฟล์ขนส่ง';
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (row.tracking_no_normalized)
    row.tracking_no_normalized,
    row.tracking_no,
    import.id,
    import.file_name,
    import.carrier,
    import.uploaded_at,
    row.pickup_at
  FROM public.tr_delivery_check_rows row
  JOIN public.tr_delivery_check_imports import ON import.id = row.import_id
  WHERE row.source_kind = 'carrier'
    AND row.tracking_no_normalized = ANY(coalesce(p_tracking_keys, ARRAY[]::TEXT[]))
  ORDER BY row.tracking_no_normalized, import.uploaded_at DESC, row.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.tr_delivery_check_delete_import(p_import_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_import public.tr_delivery_check_imports;
  v_row_count INTEGER;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ลบประวัติการนำเข้า';
  END IF;

  SELECT * INTO v_import FROM public.tr_delivery_check_imports WHERE id = p_import_id;
  IF v_import.id IS NULL THEN RAISE EXCEPTION 'ไม่พบประวัติการนำเข้าที่ต้องการลบ'; END IF;

  SELECT count(*) INTO v_row_count
  FROM public.tr_delivery_check_rows
  WHERE import_id = p_import_id;

  DELETE FROM public.tr_delivery_check_imports WHERE id = p_import_id;

  RETURN jsonb_build_object(
    'deleted_import_id', v_import.id,
    'file_name', v_import.file_name,
    'carrier', v_import.carrier,
    'deleted_row_count', v_row_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.tr_delivery_check_rebuild_system_only(p_import_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_issue_count INTEGER := 0;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ประมวลผลรายการตรวจสอบการส่ง';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tr_delivery_check_imports WHERE id = p_import_id) THEN
    RAISE EXCEPTION 'ไม่พบรอบนำเข้า';
  END IF;

  DELETE FROM public.tr_delivery_check_rows
  WHERE import_id = p_import_id AND source_kind = 'system';

  SELECT count(*) INTO v_issue_count
  FROM public.tr_delivery_check_rows row
  WHERE row.import_id = p_import_id
    AND row.source_kind = 'carrier'
    AND row.review_status = 'open'
    AND (
      row.match_status NOT IN ('matched', 'manual_match', 'consignment')
      OR row.has_duplicate
      OR row.has_previous_import
    );

  UPDATE public.tr_delivery_check_imports
  SET system_only_count = 0,
      issue_count = v_issue_count,
      updated_at = now()
  WHERE id = p_import_id;

  RETURN jsonb_build_object('system_only_count', 0, 'issue_count', v_issue_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.tr_delivery_tracking_workspace(
 p_from DATE DEFAULT NULL,p_to DATE DEFAULT NULL,p_status TEXT DEFAULT 'all',
 p_search TEXT DEFAULT '',p_carrier TEXT DEFAULT '',p_channel TEXT DEFAULT '',
 p_date_basis TEXT DEFAULT 'created',p_offset INTEGER DEFAULT 0)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_result JSONB;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid()
  AND role IN ('superadmin','admin','admin-tr','sales-tr','packing_staff', 'account')) THEN
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

CREATE OR REPLACE FUNCTION public.tr_delivery_check_review_row(
  p_row_id UUID,
  p_note TEXT,
  p_resolved BOOLEAN DEFAULT false
)
RETURNS public.tr_delivery_check_rows
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_row public.tr_delivery_check_rows;
  v_issue_count INTEGER := 0;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขผลตรวจสอบการส่ง';
  END IF;

  UPDATE public.tr_delivery_check_rows
  SET note = nullif(btrim(coalesce(p_note, '')), ''),
      review_status = CASE WHEN p_resolved THEN 'resolved' ELSE review_status END,
      reviewed_by = CASE WHEN p_resolved THEN auth.uid() ELSE reviewed_by END,
      reviewed_at = CASE WHEN p_resolved THEN now() ELSE reviewed_at END,
      updated_at = now()
  WHERE id = p_row_id
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการตรวจสอบ'; END IF;

  SELECT count(*) INTO v_issue_count
  FROM public.tr_delivery_check_rows row
  WHERE row.import_id = v_row.import_id
    AND row.source_kind = 'carrier'
    AND row.review_status = 'open'
    AND (
      row.match_status NOT IN ('matched', 'manual_match', 'consignment')
      OR row.has_duplicate
      OR row.has_previous_import
    );

  UPDATE public.tr_delivery_check_imports
  SET issue_count = v_issue_count,
      updated_at = now()
  WHERE id = v_row.import_id;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.tr_delivery_check_move_to_review(p_row_id UUID, p_note TEXT)
RETURNS public.tr_delivery_check_rows
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_row public.tr_delivery_check_rows;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขผลตรวจสอบการส่ง';
  END IF;
  SELECT * INTO v_row FROM public.tr_delivery_check_rows WHERE id = p_row_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.source_kind <> 'carrier' OR NOT v_row.is_consignment THEN
    RAISE EXCEPTION 'รายการนี้ไม่ใช่รายการฝากส่ง';
  END IF;
  -- Serialize summary refreshes for this import.
  PERFORM 1 FROM public.tr_delivery_check_imports WHERE id = v_row.import_id FOR UPDATE;
  UPDATE public.tr_delivery_check_rows
  SET is_consignment = false, match_status = 'unmatched', match_method = 'manual_review',
      match_detail = 'เจ้าหน้าที่เปลี่ยนจากฝากส่งเป็นต้องตรวจ',
      note = nullif(btrim(coalesce(p_note, '')), ''), review_status = 'open',
      reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
  WHERE id = p_row_id RETURNING * INTO v_row;
  UPDATE public.tr_delivery_check_imports i
  SET consignment_count = (SELECT count(*) FROM public.tr_delivery_check_rows r WHERE r.import_id = i.id AND r.source_kind = 'carrier' AND r.match_status = 'consignment'), updated_at = now()
  WHERE i.id = v_row.import_id;
  PERFORM public.tr_delivery_check_rebuild_system_only(v_row.import_id);
  RETURN v_row;
END;
$$;

COMMIT;
