-- Allow a Marketplace order/tracking number to be reused only after the
-- previous ERP bill (or the Marketplace work itself) has been cancelled.
BEGIN;

ALTER TABLE public.mp_orders
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS import_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS supersedes_mp_order_id UUID REFERENCES public.mp_orders(id) ON DELETE SET NULL;

ALTER TABLE public.mp_orders
  DROP CONSTRAINT IF EXISTS mp_orders_channel_code_marketplace_order_no_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mp_orders_current_channel_order
  ON public.mp_orders (channel_code, marketplace_order_no)
  WHERE is_current;

CREATE INDEX IF NOT EXISTS idx_mp_orders_supersedes
  ON public.mp_orders (supersedes_mp_order_id)
  WHERE supersedes_mp_order_id IS NOT NULL;

-- Keep Marketplace workflow state aligned when an already-opened ERP bill is
-- cancelled. Historical work remains linked to the cancelled ERP bill.
UPDATE public.mp_orders mp
SET status = 'cancelled',
    cancel_note = COALESCE(mp.cancel_note, 'บิล ERP ที่เชื่อมโยงถูกยกเลิก'),
    cancelled_at = COALESCE(mp.cancelled_at, erp.updated_at, now())
FROM public.or_orders erp
WHERE mp.billed_order_id = erp.id
  AND mp.is_current
  AND mp.status = 'done'
  AND erp.status = 'ยกเลิก';

CREATE OR REPLACE FUNCTION public.sync_cancelled_erp_bill_to_marketplace()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'ยกเลิก' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE public.mp_orders
    SET status = 'cancelled',
        cancel_note = COALESCE(cancel_note, 'บิล ERP ที่เชื่อมโยงถูกยกเลิก'),
        cancelled_at = COALESCE(cancelled_at, now()),
        cancelled_by = COALESCE(cancelled_by, auth.uid())
    WHERE billed_order_id = NEW.id
      AND is_current
      AND status = 'done';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_cancelled_erp_bill_to_marketplace ON public.or_orders;
CREATE TRIGGER trg_sync_cancelled_erp_bill_to_marketplace
AFTER UPDATE OF status ON public.or_orders
FOR EACH ROW
EXECUTE FUNCTION public.sync_cancelled_erp_bill_to_marketplace();

-- Cancelled bills no longer reserve their old tracking number. Preserve the
-- historical value on the cancelled row for audit purposes.
CREATE OR REPLACE FUNCTION public.guard_unique_order_tracking_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_tracking TEXT;
  v_tracking_key TEXT;
BEGIN
  v_tracking := NULLIF(btrim(NEW.tracking_number), '');
  NEW.tracking_number := v_tracking;
  v_tracking_key := upper(regexp_replace(COALESCE(v_tracking, ''), '[[:space:]]+', '', 'g'));

  IF TG_OP = 'UPDATE'
     AND upper(regexp_replace(COALESCE(NULLIF(btrim(OLD.tracking_number), ''), ''), '[[:space:]]+', '', 'g')) = v_tracking_key THEN
    RETURN NEW;
  END IF;

  IF v_tracking IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.or_orders other
    WHERE other.id IS DISTINCT FROM NEW.id
      AND COALESCE(other.status, '') <> 'ยกเลิก'
      AND upper(regexp_replace(COALESCE(other.tracking_number, ''), '[[:space:]]+', '', 'g')) = v_tracking_key
  ) THEN
    RAISE EXCEPTION 'เลขพัสดุ % ซ้ำกับบิลอื่นที่ยังใช้งานในระบบ', v_tracking;
  END IF;

  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS public.import_marketplace_orders(UUID, TEXT, INTEGER, INTEGER, JSONB);

CREATE FUNCTION public.import_marketplace_orders(
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
  reimported_count INTEGER,
  tracking_conflict_count INTEGER,
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
  v_existing public.mp_orders%ROWTYPE;
  v_channel_code TEXT;
  v_order_no TEXT;
  v_order_key TEXT;
  v_tracking TEXT;
  v_tracking_key TEXT;
  v_imported_count INTEGER := 0;
  v_duplicate_count INTEGER := GREATEST(COALESCE(p_known_duplicate_count, 0), 0);
  v_reimported_count INTEGER := 0;
  v_tracking_conflict_count INTEGER := 0;
  v_imported_order_keys JSONB := '[]'::JSONB;
  v_version INTEGER;
  v_supersedes UUID;
BEGIN
  IF auth.uid() IS NULL OR NOT public.mp_can_manage_new_orders() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'คุณไม่มีสิทธิ์นำเข้างาน Marketplace';
  END IF;

  IF p_config_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.mp_channel_configs config
    WHERE config.id = p_config_id AND config.is_active = TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ไม่พบช่องทางนำเข้าที่เปิดใช้งาน กรุณาเลือกช่องทางใหม่';
  END IF;

  IF NULLIF(BTRIM(COALESCE(p_file_name, '')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ไม่พบชื่อไฟล์ที่ต้องการนำเข้า';
  END IF;

  IF p_orders IS NULL OR jsonb_typeof(p_orders) <> 'array'
     OR jsonb_array_length(p_orders) < 1 OR jsonb_array_length(p_orders) > 10000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ไฟล์ต้องมีออเดอร์สำหรับนำเข้า 1 ถึง 10,000 รายการ';
  END IF;

  INSERT INTO public.mp_import_batches (
    config_id, file_name, row_count, order_count, duplicate_count, uploaded_by
  ) VALUES (
    p_config_id, BTRIM(p_file_name), GREATEST(COALESCE(p_row_count, 0), 0), 0,
    v_duplicate_count, auth.uid()
  ) RETURNING id INTO v_batch_id;

  FOR v_order IN SELECT value FROM jsonb_array_elements(p_orders)
  LOOP
    v_channel_code := BTRIM(COALESCE(v_order->>'channel_code', ''));
    v_order_no := BTRIM(COALESCE(v_order->>'marketplace_order_no', ''));
    v_order_key := lower(v_order_no);
    v_tracking := NULLIF(BTRIM(COALESCE(v_order->>'tracking_no', '')), '');
    IF v_tracking = '-' THEN v_tracking := NULL; END IF;
    v_tracking_key := upper(regexp_replace(COALESCE(v_tracking, ''), '[[:space:]]+', '', 'g'));

    IF v_channel_code = '' OR v_order_no = '' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'พบออเดอร์ที่ไม่มีช่องทางขายหรือเลขคำสั่งซื้อ';
    END IF;

    -- Serialize each logical Marketplace order across concurrent imports.
    PERFORM pg_advisory_xact_lock(hashtextextended('MP:' || v_channel_code || ':' || v_order_key, 0));

    -- Legacy uniqueness was case-sensitive. Check every normalized current row
    -- so an old case-variant cannot be bypassed by selecting a cancelled one.
    IF EXISTS (
      SELECT 1
      FROM public.mp_orders current_order
      WHERE current_order.channel_code = v_channel_code
        AND lower(btrim(current_order.marketplace_order_no)) = v_order_key
        AND current_order.is_current
        AND current_order.status <> 'cancelled'
        AND NOT EXISTS (
          SELECT 1 FROM public.or_orders billed
          WHERE billed.id = current_order.billed_order_id AND billed.status = 'ยกเลิก'
        )
    ) THEN
      v_duplicate_count := v_duplicate_count + 1;
      CONTINUE;
    END IF;

    SELECT * INTO v_existing
    FROM public.mp_orders current_order
    WHERE current_order.channel_code = v_channel_code
      AND lower(btrim(current_order.marketplace_order_no)) = v_order_key
      AND current_order.is_current
    ORDER BY current_order.created_at DESC, current_order.id DESC
    LIMIT 1
    FOR UPDATE;

    v_supersedes := NULL;
    v_version := 1;
    IF v_existing.id IS NOT NULL THEN
      v_supersedes := v_existing.id;
      v_version := GREATEST(COALESCE(v_existing.import_version, 1), 1) + 1;
    END IF;

    IF v_tracking_key <> '' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('TRACK:' || v_tracking_key, 0));
      IF EXISTS (
        SELECT 1 FROM public.or_orders active_bill
        WHERE COALESCE(active_bill.status, '') <> 'ยกเลิก'
          AND upper(regexp_replace(COALESCE(active_bill.tracking_number, ''), '[[:space:]]+', '', 'g')) = v_tracking_key
      ) OR EXISTS (
        SELECT 1 FROM public.mp_orders active_work
        WHERE active_work.is_current
          AND active_work.status <> 'cancelled'
          AND upper(regexp_replace(COALESCE(active_work.tracking_no, ''), '[[:space:]]+', '', 'g')) = v_tracking_key
      ) THEN
        v_tracking_conflict_count := v_tracking_conflict_count + 1;
        CONTINUE;
      END IF;
    END IF;

    IF v_supersedes IS NOT NULL THEN
      UPDATE public.mp_orders
      SET is_current = FALSE
      WHERE channel_code = v_channel_code
        AND lower(btrim(marketplace_order_no)) = v_order_key
        AND is_current;
      v_reimported_count := v_reimported_count + 1;
    END IF;

    INSERT INTO public.mp_orders (
      batch_id, config_id, channel_code, shipping_option, urgency_label, urgency_color,
      requires_express_receipt_number, marketplace_order_no, platform_status, buyer_username,
      order_date, payment_time, recipient_name, phone, address, province, district, postal_code,
      buyer_note, tracking_no, shipping_fee, order_total, raw_snapshot, ship_due_at, overdue_at,
      status, is_current, import_version, supersedes_mp_order_id
    ) VALUES (
      v_batch_id, p_config_id, v_channel_code, NULLIF(v_order->>'shipping_option', ''),
      NULLIF(v_order->>'urgency_label', ''), NULLIF(v_order->>'urgency_color', ''),
      COALESCE((v_order->>'requires_express_receipt_number')::BOOLEAN, FALSE), v_order_no,
      NULLIF(v_order->>'platform_status', ''), NULLIF(v_order->>'buyer_username', ''),
      NULLIF(v_order->>'order_date', '')::TIMESTAMPTZ, NULLIF(v_order->>'payment_time', '')::TIMESTAMPTZ,
      NULLIF(v_order->>'recipient_name', ''), NULLIF(v_order->>'phone', ''), NULLIF(v_order->>'address', ''),
      NULLIF(v_order->>'province', ''), NULLIF(v_order->>'district', ''), NULLIF(v_order->>'postal_code', ''),
      NULLIF(v_order->>'buyer_note', ''), v_tracking, NULLIF(v_order->>'shipping_fee', '')::NUMERIC,
      NULLIF(v_order->>'order_total', '')::NUMERIC, COALESCE(v_order->'raw_snapshot', '{}'::JSONB),
      NULLIF(v_order->>'ship_due_at', '')::TIMESTAMPTZ, NULLIF(v_order->>'overdue_at', '')::TIMESTAMPTZ,
      'new', TRUE, v_version, v_supersedes
    ) RETURNING id INTO v_order_id;

    INSERT INTO public.mp_order_items (
      mp_order_id, line_index, product_name_raw, sku_ref, variation, qty, unit_price,
      line_total, raw_snapshot, product_id
    )
    SELECT v_order_id, item.line_index, item.product_name_raw, item.sku_ref, item.variation,
      GREATEST(COALESCE(item.qty, 1), 1), item.unit_price, item.line_total,
      COALESCE(item.raw_snapshot, '{}'::JSONB), item.product_id
    FROM jsonb_to_recordset(COALESCE(v_order->'items', '[]'::JSONB)) AS item(
      line_index INTEGER, product_name_raw TEXT, sku_ref TEXT, variation TEXT, qty NUMERIC,
      unit_price NUMERIC, line_total NUMERIC, raw_snapshot JSONB, product_id UUID
    );

    v_imported_count := v_imported_count + 1;
    v_imported_order_keys := v_imported_order_keys || jsonb_build_array(jsonb_build_object(
      'channel_code', v_channel_code, 'marketplace_order_no', v_order_no
    ));
  END LOOP;

  UPDATE public.mp_import_batches
  SET order_count = v_imported_count, duplicate_count = v_duplicate_count
  WHERE id = v_batch_id;

  RETURN QUERY SELECT v_batch_id, v_imported_count, v_duplicate_count,
    v_reimported_count, v_tracking_conflict_count, v_imported_order_keys;
END;
$$;

REVOKE ALL ON FUNCTION public.import_marketplace_orders(UUID, TEXT, INTEGER, INTEGER, JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_marketplace_orders(UUID, TEXT, INTEGER, INTEGER, JSONB)
  TO authenticated;

COMMENT ON FUNCTION public.import_marketplace_orders(UUID, TEXT, INTEGER, INTEGER, JSONB) IS
  'Atomically imports Marketplace orders, versions cancelled reimports, and rejects active tracking conflicts below RLS.';

NOTIFY pgrst, 'reload schema';

COMMIT;
