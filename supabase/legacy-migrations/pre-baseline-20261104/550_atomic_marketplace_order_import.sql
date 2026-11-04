BEGIN;

-- Import a marketplace workbook in one transaction.  The function deliberately
-- checks duplicates below RLS because importers such as sales-tr cannot see
-- orders that have already moved to another assignee or workflow status.
CREATE OR REPLACE FUNCTION public.import_marketplace_orders(
  p_config_id UUID,
  p_file_name TEXT,
  p_row_count INTEGER,
  p_known_duplicate_count INTEGER,
  p_orders JSONB
)
RETURNS TABLE(
  batch_id UUID,
  imported_count INTEGER,
  duplicate_count INTEGER,
  imported_order_keys JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch_id UUID;
  v_order JSONB;
  v_order_id UUID;
  v_channel_code TEXT;
  v_order_no TEXT;
  v_imported_count INTEGER := 0;
  v_duplicate_count INTEGER := GREATEST(COALESCE(p_known_duplicate_count, 0), 0);
  v_imported_order_keys JSONB := '[]'::JSONB;
BEGIN
  IF auth.uid() IS NULL OR NOT public.mp_can_manage_new_orders() THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'คุณไม่มีสิทธิ์นำเข้างาน Marketplace';
  END IF;

  IF p_config_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.mp_channel_configs config
    WHERE config.id = p_config_id
      AND config.is_active = TRUE
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'ไม่พบช่องทางนำเข้าที่เปิดใช้งาน กรุณาเลือกช่องทางใหม่';
  END IF;

  IF NULLIF(BTRIM(COALESCE(p_file_name, '')), '') IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'ไม่พบชื่อไฟล์ที่ต้องการนำเข้า';
  END IF;

  IF p_orders IS NULL
     OR jsonb_typeof(p_orders) <> 'array'
     OR jsonb_array_length(p_orders) < 1
     OR jsonb_array_length(p_orders) > 10000
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'ไฟล์ต้องมีออเดอร์สำหรับนำเข้า 1 ถึง 10,000 รายการ';
  END IF;

  INSERT INTO public.mp_import_batches (
    config_id,
    file_name,
    row_count,
    order_count,
    duplicate_count,
    uploaded_by
  ) VALUES (
    p_config_id,
    BTRIM(p_file_name),
    GREATEST(COALESCE(p_row_count, 0), 0),
    0,
    v_duplicate_count,
    auth.uid()
  )
  RETURNING id INTO v_batch_id;

  FOR v_order IN
    SELECT value FROM jsonb_array_elements(p_orders)
  LOOP
    v_channel_code := BTRIM(COALESCE(v_order->>'channel_code', ''));
    v_order_no := BTRIM(COALESCE(v_order->>'marketplace_order_no', ''));

    IF v_channel_code = '' OR v_order_no = '' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'พบออเดอร์ที่ไม่มีช่องทางขายหรือเลขคำสั่งซื้อ';
    END IF;

    v_order_id := NULL;
    INSERT INTO public.mp_orders (
      batch_id,
      config_id,
      channel_code,
      shipping_option,
      urgency_label,
      urgency_color,
      requires_express_receipt_number,
      marketplace_order_no,
      platform_status,
      buyer_username,
      order_date,
      payment_time,
      recipient_name,
      phone,
      address,
      province,
      district,
      postal_code,
      buyer_note,
      tracking_no,
      shipping_fee,
      order_total,
      raw_snapshot,
      ship_due_at,
      overdue_at,
      status
    ) VALUES (
      v_batch_id,
      p_config_id,
      v_channel_code,
      NULLIF(v_order->>'shipping_option', ''),
      NULLIF(v_order->>'urgency_label', ''),
      NULLIF(v_order->>'urgency_color', ''),
      COALESCE((v_order->>'requires_express_receipt_number')::BOOLEAN, FALSE),
      v_order_no,
      NULLIF(v_order->>'platform_status', ''),
      NULLIF(v_order->>'buyer_username', ''),
      NULLIF(v_order->>'order_date', '')::TIMESTAMPTZ,
      NULLIF(v_order->>'payment_time', '')::TIMESTAMPTZ,
      NULLIF(v_order->>'recipient_name', ''),
      NULLIF(v_order->>'phone', ''),
      NULLIF(v_order->>'address', ''),
      NULLIF(v_order->>'province', ''),
      NULLIF(v_order->>'district', ''),
      NULLIF(v_order->>'postal_code', ''),
      NULLIF(v_order->>'buyer_note', ''),
      NULLIF(v_order->>'tracking_no', ''),
      NULLIF(v_order->>'shipping_fee', '')::NUMERIC,
      NULLIF(v_order->>'order_total', '')::NUMERIC,
      COALESCE(v_order->'raw_snapshot', '{}'::JSONB),
      NULLIF(v_order->>'ship_due_at', '')::TIMESTAMPTZ,
      NULLIF(v_order->>'overdue_at', '')::TIMESTAMPTZ,
      'new'
    )
    ON CONFLICT (channel_code, marketplace_order_no) DO NOTHING
    RETURNING id INTO v_order_id;

    IF v_order_id IS NULL THEN
      v_duplicate_count := v_duplicate_count + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.mp_order_items (
      mp_order_id,
      line_index,
      product_name_raw,
      sku_ref,
      variation,
      qty,
      unit_price,
      line_total,
      raw_snapshot,
      product_id
    )
    SELECT
      v_order_id,
      item.line_index,
      item.product_name_raw,
      item.sku_ref,
      item.variation,
      GREATEST(COALESCE(item.qty, 1), 1),
      item.unit_price,
      item.line_total,
      COALESCE(item.raw_snapshot, '{}'::JSONB),
      item.product_id
    FROM jsonb_to_recordset(COALESCE(v_order->'items', '[]'::JSONB)) AS item(
      line_index INTEGER,
      product_name_raw TEXT,
      sku_ref TEXT,
      variation TEXT,
      qty NUMERIC,
      unit_price NUMERIC,
      line_total NUMERIC,
      raw_snapshot JSONB,
      product_id UUID
    );

    v_imported_count := v_imported_count + 1;
    v_imported_order_keys := v_imported_order_keys || jsonb_build_array(
      jsonb_build_object(
        'channel_code', v_channel_code,
        'marketplace_order_no', v_order_no
      )
    );
  END LOOP;

  UPDATE public.mp_import_batches
  SET order_count = v_imported_count,
      duplicate_count = v_duplicate_count
  WHERE id = v_batch_id;

  RETURN QUERY
  SELECT
    v_batch_id,
    v_imported_count,
    v_duplicate_count,
    v_imported_order_keys;
END;
$$;

REVOKE ALL ON FUNCTION public.import_marketplace_orders(UUID, TEXT, INTEGER, INTEGER, JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_marketplace_orders(UUID, TEXT, INTEGER, INTEGER, JSONB)
  TO authenticated;

COMMENT ON FUNCTION public.import_marketplace_orders(UUID, TEXT, INTEGER, INTEGER, JSONB) IS
  'Atomically imports marketplace orders and skips channel/order-number conflicts below RLS.';

NOTIFY pgrst, 'reload schema';

COMMIT;
