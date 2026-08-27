-- Fast, observable parcel-tracking import for Plan -> Work order management.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_or_orders_tracking_number_normalized
  ON public.or_orders (upper(btrim(tracking_number)))
  WHERE NULLIF(btrim(tracking_number), '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_or_orders_work_order_bill_no
  ON public.or_orders (work_order_name, bill_no);

CREATE OR REPLACE FUNCTION public.rpc_plan_import_tracking_batch(
  p_work_order_name TEXT,
  p_rows JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_row RECORD;
  v_bill_no TEXT;
  v_tracking TEXT;
  v_tracking_normalized TEXT;
  v_order public.or_orders;
  v_match_count INTEGER;
  v_processed INTEGER := 0;
  v_updated INTEGER := 0;
  v_unchanged INTEGER := 0;
  v_duplicate INTEGER := 0;
  v_not_found INTEGER := 0;
  v_outside_work_order INTEGER := 0;
  v_invalid INTEGER := 0;
  v_failed INTEGER := 0;
  v_results JSONB := '[]'::JSONB;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role NOT IN ('superadmin', 'admin', 'production', 'packing_staff') THEN
    RAISE EXCEPTION 'Not authorized to import parcel tracking numbers';
  END IF;

  p_work_order_name := NULLIF(btrim(COALESCE(p_work_order_name, '')), '');
  IF p_work_order_name IS NULL THEN
    RAISE EXCEPTION 'Work order name is required';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Rows must be a JSON array';
  END IF;
  IF jsonb_array_length(p_rows) > 100 THEN
    RAISE EXCEPTION 'A tracking import batch cannot exceed 100 rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_rows) AS item
    WHERE NULLIF(btrim(COALESCE(item->>'bill_no', '')), '') IS NOT NULL
      AND NULLIF(btrim(COALESCE(item->>'tracking_number', '')), '') IS NOT NULL
    GROUP BY upper(btrim(item->>'bill_no'))
    HAVING count(DISTINCT upper(btrim(item->>'tracking_number'))) > 1
  ) THEN
    RAISE EXCEPTION 'One or more order numbers have multiple tracking numbers in the same import batch';
  END IF;

  FOR v_row IN
    SELECT value AS data, ordinality::INTEGER AS row_no
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY
  LOOP
    v_processed := v_processed + 1;
    v_bill_no := NULLIF(btrim(COALESCE(v_row.data->>'bill_no', '')), '');
    v_tracking := NULLIF(btrim(COALESCE(v_row.data->>'tracking_number', '')), '');
    v_tracking_normalized := upper(v_tracking);

    IF v_bill_no IS NULL OR v_tracking IS NULL THEN
      v_invalid := v_invalid + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_no', v_row.row_no,
        'bill_no', COALESCE(v_bill_no, ''),
        'tracking_number', COALESCE(v_tracking, ''),
        'status', 'invalid',
        'message', 'เลขออเดอร์หรือเลขพัสดุว่าง'
      ));
      CONTINUE;
    END IF;

    SELECT count(*)::INTEGER INTO v_match_count
    FROM public.or_orders
    WHERE work_order_name = p_work_order_name
      AND bill_no = v_bill_no;

    IF v_match_count = 0 THEN
      IF EXISTS (SELECT 1 FROM public.or_orders WHERE bill_no = v_bill_no) THEN
        v_outside_work_order := v_outside_work_order + 1;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'row_no', v_row.row_no,
          'bill_no', v_bill_no,
          'tracking_number', v_tracking,
          'status', 'outside_work_order',
          'message', 'พบบิล แต่ไม่ได้อยู่ในใบงานที่เลือก'
        ));
      ELSE
        v_not_found := v_not_found + 1;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'row_no', v_row.row_no,
          'bill_no', v_bill_no,
          'tracking_number', v_tracking,
          'status', 'not_found',
          'message', 'ไม่พบเลขออเดอร์'
        ));
      END IF;
      CONTINUE;
    ELSIF v_match_count > 1 THEN
      v_invalid := v_invalid + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_no', v_row.row_no,
        'bill_no', v_bill_no,
        'tracking_number', v_tracking,
        'status', 'invalid',
        'message', 'พบเลขออเดอร์ซ้ำในใบงานเดียวกัน'
      ));
      CONTINUE;
    END IF;

    SELECT * INTO v_order
    FROM public.or_orders
    WHERE work_order_name = p_work_order_name
      AND bill_no = v_bill_no
    FOR UPDATE;

    IF upper(COALESCE(NULLIF(btrim(v_order.tracking_number), ''), '')) = v_tracking_normalized THEN
      v_unchanged := v_unchanged + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_no', v_row.row_no,
        'bill_no', v_bill_no,
        'tracking_number', v_tracking,
        'status', 'unchanged',
        'message', 'เลขพัสดุตรงกับข้อมูลเดิม'
      ));
      CONTINUE;
    END IF;

    -- Serialize the same normalized tracking number across concurrent imports.
    PERFORM pg_advisory_xact_lock(hashtextextended('TRACK:' || v_tracking_normalized, 0));

    IF EXISTS (
      SELECT 1 FROM public.or_orders other
      WHERE other.id IS DISTINCT FROM v_order.id
        AND upper(btrim(other.tracking_number)) = v_tracking_normalized
    ) THEN
      v_duplicate := v_duplicate + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_no', v_row.row_no,
        'bill_no', v_bill_no,
        'tracking_number', v_tracking,
        'status', 'duplicate',
        'message', 'เลขพัสดุซ้ำกับบิลอื่นในระบบ'
      ));
      CONTINUE;
    END IF;

    BEGIN
      UPDATE public.or_orders
      SET tracking_number = v_tracking
      WHERE id = v_order.id;

      v_updated := v_updated + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_no', v_row.row_no,
        'bill_no', v_bill_no,
        'tracking_number', v_tracking,
        'status', 'updated',
        'message', 'บันทึกสำเร็จ'
      ));
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_no', v_row.row_no,
        'bill_no', v_bill_no,
        'tracking_number', v_tracking,
        'status', 'error',
        'message', SQLERRM
      ));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'processed', v_processed,
    'updated', v_updated,
    'unchanged', v_unchanged,
    'duplicate', v_duplicate,
    'not_found', v_not_found,
    'outside_work_order', v_outside_work_order,
    'invalid', v_invalid,
    'failed', v_failed,
    'results', v_results
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_plan_import_tracking_batch(TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_plan_import_tracking_batch(TEXT, JSONB) TO authenticated;

COMMIT;
