-- ============================================
-- GR item images (max 5 images per GR item)
-- ============================================

CREATE TABLE IF NOT EXISTS inv_gr_item_images (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gr_item_id UUID NOT NULL REFERENCES inv_gr_items(id) ON DELETE CASCADE,
  storage_bucket TEXT NOT NULL DEFAULT 'gr-item-images',
  storage_path TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inv_gr_item_images_item_sort
  ON inv_gr_item_images(gr_item_id, sort_order, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_gr_item_images_item_path
  ON inv_gr_item_images(gr_item_id, storage_path);

ALTER TABLE inv_gr_item_images ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone authenticated can view GR item images" ON inv_gr_item_images;
CREATE POLICY "Anyone authenticated can view GR item images"
  ON inv_gr_item_images FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Purchase roles can manage GR item images" ON inv_gr_item_images;
CREATE POLICY "Purchase roles can manage GR item images"
  ON inv_gr_item_images FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'admin-tr', 'store', 'account', 'manager')
    )
  );

-- ============================================
-- Storage bucket + policies for GR item images
-- ============================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('gr-item-images', 'gr-item-images', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Authenticated can read gr-item-images" ON storage.objects;
CREATE POLICY "Authenticated can read gr-item-images"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'gr-item-images');

DROP POLICY IF EXISTS "Authenticated can insert gr-item-images" ON storage.objects;
CREATE POLICY "Authenticated can insert gr-item-images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'gr-item-images');

DROP POLICY IF EXISTS "Authenticated can update gr-item-images" ON storage.objects;
CREATE POLICY "Authenticated can update gr-item-images"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'gr-item-images') WITH CHECK (bucket_id = 'gr-item-images');

DROP POLICY IF EXISTS "Authenticated can delete gr-item-images" ON storage.objects;
CREATE POLICY "Authenticated can delete gr-item-images"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'gr-item-images');

-- ============================================
-- Rewrite rpc_receive_gr to support item images
-- ============================================

CREATE OR REPLACE FUNCTION rpc_receive_gr(
  p_po_id   UUID,
  p_items   JSONB,
  p_shipping JSONB DEFAULT '{}'::JSONB,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_gr_id          UUID;
  v_gr_no          TEXT;
  v_item           JSONB;
  v_gr_item_id     UUID;
  v_images         JSONB;
  v_image          JSONB;
  v_image_count    INT;
  v_storage_path   TEXT;
  v_storage_bucket TEXT;
  v_size_bytes     BIGINT;
  v_sort_order     INT;
  v_has_shortage   BOOLEAN := FALSE;
  v_total_received NUMERIC := 0;
  v_dom_cost       NUMERIC(14,2);
  v_dom_cpp        NUMERIC(12,4);
  v_qty_recv       NUMERIC;
  v_qty_ord        NUMERIC;
  v_qty_short      NUMERIC;
  v_today          TEXT;
  v_seq            INT;
  v_all_fulfilled  BOOLEAN;
  v_intl_thb       NUMERIC;
  v_total_po_qty   NUMERIC;
  v_intl_cpp       NUMERIC;
  v_lot_rec        RECORD;
  v_lot_cost       NUMERIC;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inv_po WHERE id = p_po_id AND status IN ('ordered', 'partial')) THEN
    RAISE EXCEPTION 'PO ไม่อยู่ในสถานะที่รับสินค้าได้';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('gr_no_gen'));

  v_today := to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD');

  SELECT COALESCE(MAX(CAST(SPLIT_PART(gr_no, '-', 3) AS INTEGER)), 0) + 1
  INTO v_seq
  FROM inv_gr
  WHERE gr_no LIKE 'GR-' || v_today || '-___';

  v_gr_no := 'GR-' || v_today || '-' || lpad(v_seq::text, 3, '0');

  INSERT INTO inv_gr (
    gr_no, po_id, status, received_by, received_at, note,
    dom_shipping_company, dom_shipping_cost, shortage_note
  )
  VALUES (
    v_gr_no, p_po_id, 'received', p_user_id, NOW(), p_shipping->>'note',
    p_shipping->>'dom_shipping_company',
    (p_shipping->>'dom_shipping_cost')::NUMERIC,
    p_shipping->>'shortage_note'
  )
  RETURNING id INTO v_gr_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty_recv  := (v_item->>'qty_received')::NUMERIC;
    v_qty_ord   := (v_item->>'qty_ordered')::NUMERIC;
    v_qty_short := GREATEST(v_qty_ord - v_qty_recv, 0);

    IF v_qty_short > 0 THEN
      v_has_shortage := TRUE;
    END IF;

    v_total_received := v_total_received + v_qty_recv;

    INSERT INTO inv_gr_items (gr_id, product_id, qty_received, qty_ordered, qty_shortage, shortage_note)
    VALUES (
      v_gr_id,
      (v_item->>'product_id')::UUID,
      v_qty_recv, v_qty_ord, v_qty_short,
      v_item->>'shortage_note'
    )
    RETURNING id INTO v_gr_item_id;

    v_images := COALESCE(v_item->'images', '[]'::JSONB);
    IF jsonb_typeof(v_images) <> 'array' THEN
      RAISE EXCEPTION 'images ต้องเป็น array (product_id=%)', (v_item->>'product_id');
    END IF;
    IF jsonb_array_length(v_images) > 5 THEN
      RAISE EXCEPTION 'แนบรูปได้ไม่เกิน 5 รูปต่อรายการสินค้า (product_id=%)', (v_item->>'product_id');
    END IF;

    v_image_count := 0;
    FOR v_image IN SELECT * FROM jsonb_array_elements(v_images)
    LOOP
      v_image_count := v_image_count + 1;
      v_storage_path := NULLIF(TRIM(v_image->>'storage_path'), '');
      IF v_storage_path IS NULL THEN
        RAISE EXCEPTION 'storage_path ห้ามว่าง (product_id=%)', (v_item->>'product_id');
      END IF;

      v_storage_bucket := COALESCE(NULLIF(TRIM(v_image->>'storage_bucket'), ''), 'gr-item-images');
      v_sort_order := COALESCE(NULLIF(v_image->>'sort_order', '')::INT, v_image_count);
      v_size_bytes := NULLIF(v_image->>'size_bytes', '')::BIGINT;

      INSERT INTO inv_gr_item_images (
        gr_item_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, sort_order
      )
      VALUES (
        v_gr_item_id,
        v_storage_bucket,
        v_storage_path,
        NULLIF(TRIM(v_image->>'file_name'), ''),
        NULLIF(TRIM(v_image->>'mime_type'), ''),
        v_size_bytes,
        v_sort_order
      );
    END LOOP;

    UPDATE inv_po_items
    SET qty_received_total = qty_received_total + v_qty_recv
    WHERE po_id = p_po_id AND product_id = (v_item->>'product_id')::UUID;

    IF v_qty_recv > 0 THEN
      INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES ((v_item->>'product_id')::UUID, v_qty_recv, 0, 0)
      ON CONFLICT (product_id) DO UPDATE SET
        on_hand = inv_stock_balances.on_hand + v_qty_recv,
        updated_at = NOW();

      INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note, created_by)
      VALUES (
        (v_item->>'product_id')::UUID,
        'gr', v_qty_recv, 'inv_gr', v_gr_id,
        'รับเข้าจาก GR ' || v_gr_no, p_user_id
      );
    END IF;
  END LOOP;

  v_dom_cost := (p_shipping->>'dom_shipping_cost')::NUMERIC;
  v_dom_cpp  := CASE
    WHEN v_dom_cost IS NOT NULL AND v_dom_cost > 0 AND v_total_received > 0
    THEN v_dom_cost / v_total_received ELSE 0 END;

  IF v_dom_cost IS NOT NULL AND v_dom_cost > 0 AND v_total_received > 0 THEN
    UPDATE inv_gr SET dom_cost_per_piece = v_dom_cpp WHERE id = v_gr_id;
  END IF;

  SELECT COALESCE(intl_shipping_cost_thb, 0) INTO v_intl_thb FROM inv_po WHERE id = p_po_id;
  SELECT COALESCE(SUM(qty), 0) INTO v_total_po_qty FROM inv_po_items WHERE po_id = p_po_id;
  v_intl_cpp := CASE WHEN v_total_po_qty > 0 THEN v_intl_thb / v_total_po_qty ELSE 0 END;

  FOR v_lot_rec IN
    SELECT sm.id AS movement_id, sm.product_id, sm.qty AS qty_recv,
           COALESCE(poi.unit_price, 0) AS unit_price
    FROM inv_stock_movements sm
    JOIN inv_po_items poi ON poi.po_id = p_po_id AND poi.product_id = sm.product_id
    WHERE sm.ref_type = 'inv_gr' AND sm.ref_id = v_gr_id
      AND sm.movement_type = 'gr' AND sm.qty > 0
  LOOP
    v_lot_cost := v_lot_rec.unit_price + v_intl_cpp + v_dom_cpp;

    INSERT INTO inv_stock_lots (product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id)
    VALUES (v_lot_rec.product_id, v_lot_rec.qty_recv, v_lot_rec.qty_recv, v_lot_cost, 'inv_gr', v_gr_id);

    UPDATE inv_stock_movements
    SET unit_cost  = v_lot_cost,
        total_cost = v_lot_rec.qty_recv * v_lot_cost
    WHERE id = v_lot_rec.movement_id;

    PERFORM fn_recalc_product_landed_cost(v_lot_rec.product_id);
  END LOOP;

  IF v_has_shortage THEN
    UPDATE inv_gr SET status = 'partial' WHERE id = v_gr_id;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM inv_po_items
    WHERE po_id = p_po_id
      AND (qty_received_total + COALESCE(resolution_qty, 0)) < qty
  ) INTO v_all_fulfilled;

  IF v_all_fulfilled THEN
    UPDATE inv_po SET status = 'received' WHERE id = p_po_id;
  ELSE
    UPDATE inv_po SET status = 'partial' WHERE id = p_po_id;
  END IF;

  RETURN jsonb_build_object(
    'id', v_gr_id,
    'gr_no', v_gr_no,
    'status', CASE WHEN v_has_shortage THEN 'partial' ELSE 'received' END,
    'total_received', v_total_received
  );
END;
$$;
