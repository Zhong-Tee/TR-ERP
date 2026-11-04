-- Daily carrier-file reconciliation for Transport > Delivery check.
BEGIN;

CREATE OR REPLACE FUNCTION public.tr_normalize_delivery_key(p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT upper(
    replace(replace(replace(replace(
      regexp_replace(coalesce(p_value, ''), '[[:space:]]+', '', 'g'),
      chr(8203), ''), chr(8204), ''), chr(8205), ''), chr(65279), '')
  );
$$;

CREATE TABLE IF NOT EXISTS public.tr_delivery_check_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  sheet_name TEXT,
  pickup_date_from DATE NOT NULL,
  pickup_date_to DATE NOT NULL,
  source_row_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  issue_count INTEGER NOT NULL DEFAULT 0,
  consignment_count INTEGER NOT NULL DEFAULT 0,
  system_only_count INTEGER NOT NULL DEFAULT 0,
  warnings JSONB NOT NULL DEFAULT '[]'::JSONB,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'closed')),
  uploaded_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tr_delivery_check_imports_dates CHECK (pickup_date_to >= pickup_date_from),
  CONSTRAINT tr_delivery_check_imports_file_unique UNIQUE (carrier, file_hash)
);

CREATE TABLE IF NOT EXISTS public.tr_delivery_check_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL REFERENCES public.tr_delivery_check_imports(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL DEFAULT 'carrier' CHECK (source_kind IN ('carrier', 'system')),
  source_row_number INTEGER,
  pickup_at TIMESTAMPTZ,
  order_no TEXT,
  order_no_normalized TEXT NOT NULL DEFAULT '',
  tracking_no TEXT,
  tracking_no_normalized TEXT NOT NULL DEFAULT '',
  sender TEXT,
  consignee TEXT,
  consignee_phone TEXT,
  consignee_address TEXT,
  is_consignment BOOLEAN NOT NULL DEFAULT false,
  note TEXT,
  order_id UUID REFERENCES public.or_orders(id) ON DELETE SET NULL,
  match_status TEXT NOT NULL DEFAULT 'unmatched' CHECK (match_status IN (
    'matched', 'tracking_only', 'order_only', 'ambiguous', 'unmatched',
    'consignment', 'system_only', 'invalid', 'manual_match'
  )),
  match_method TEXT,
  match_detail TEXT,
  has_duplicate BOOLEAN NOT NULL DEFAULT false,
  review_status TEXT NOT NULL DEFAULT 'open' CHECK (review_status IN ('open', 'resolved')),
  reviewed_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  raw_data JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tr_delivery_carrier_source_row
  ON public.tr_delivery_check_rows(import_id, source_row_number)
  WHERE source_kind = 'carrier';
CREATE UNIQUE INDEX IF NOT EXISTS uq_tr_delivery_system_order
  ON public.tr_delivery_check_rows(import_id, order_id)
  WHERE source_kind = 'system' AND order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tr_delivery_imports_uploaded
  ON public.tr_delivery_check_imports(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_tr_delivery_rows_import_status
  ON public.tr_delivery_check_rows(import_id, match_status, review_status);
CREATE INDEX IF NOT EXISTS idx_tr_delivery_rows_tracking
  ON public.tr_delivery_check_rows(tracking_no_normalized)
  WHERE tracking_no_normalized <> '';
CREATE INDEX IF NOT EXISTS idx_tr_delivery_rows_order
  ON public.tr_delivery_check_rows(order_id)
  WHERE order_id IS NOT NULL;

ALTER TABLE public.tr_delivery_check_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tr_delivery_check_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY tr_delivery_check_imports_access
  ON public.tr_delivery_check_imports FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid()
      AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid()
      AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff')
  ));

CREATE POLICY tr_delivery_check_rows_access
  ON public.tr_delivery_check_rows FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid()
      AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid()
      AND u.role IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff')
  ));

GRANT SELECT, INSERT, UPDATE ON public.tr_delivery_check_imports TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.tr_delivery_check_rows TO authenticated;

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
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff') THEN
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
      WHERE public.tr_normalize_delivery_key(o.tracking_number) = v_tracking_key;

      IF v_candidate_count = 1 THEN
        SELECT o.id, o.bill_no, o.channel_order_no, o.tracking_number
        INTO v_order
        FROM public.or_orders o
        WHERE public.tr_normalize_delivery_key(o.tracking_number) = v_tracking_key
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
        WHERE v_order_key <> '' AND v_order_key IN (
          public.tr_normalize_delivery_key(o.bill_no),
          public.tr_normalize_delivery_key(o.channel_order_no)
        );

        IF v_candidate_count = 1 THEN
          SELECT o.id, o.bill_no, o.channel_order_no, o.tracking_number
          INTO v_order
          FROM public.or_orders o
          WHERE v_order_key <> '' AND v_order_key IN (
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
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขผลตรวจสอบการส่ง';
  END IF;

  UPDATE public.tr_delivery_check_rows
  SET note = nullif(btrim(coalesce(p_note, '')), ''),
      review_status = CASE WHEN p_resolved THEN 'resolved' ELSE 'open' END,
      reviewed_by = CASE WHEN p_resolved THEN auth.uid() ELSE reviewed_by END,
      reviewed_at = CASE WHEN p_resolved THEN now() ELSE reviewed_at END,
      updated_at = now()
  WHERE id = p_row_id
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการตรวจสอบ'; END IF;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.tr_delivery_check_import(TEXT,TEXT,TEXT,TEXT,DATE,DATE,JSONB,JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tr_delivery_check_import(TEXT,TEXT,TEXT,TEXT,DATE,DATE,JSONB,JSONB) TO authenticated;
REVOKE ALL ON FUNCTION public.tr_delivery_check_review_row(UUID,TEXT,BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tr_delivery_check_review_row(UUID,TEXT,BOOLEAN) TO authenticated;

COMMIT;
