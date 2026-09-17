-- Physical storage locations inside the main warehouse.
-- Location transfers never change inv_stock_balances or inv_stock_lots.

BEGIN;

CREATE TABLE IF NOT EXISTS public.wh_storage_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  name TEXT,
  location_type TEXT NOT NULL DEFAULT 'reserve'
    CHECK (location_type IN ('picking', 'reserve', 'hold', 'unallocated')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES public.us_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_storage_locations_code_ci
  ON public.wh_storage_locations (LOWER(BTRIM(code)));

CREATE TABLE IF NOT EXISTS public.wh_location_stock (
  product_id UUID NOT NULL REFERENCES public.pr_products(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES public.wh_storage_locations(id) ON DELETE RESTRICT,
  qty NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_wh_location_stock_location_product
  ON public.wh_location_stock(location_id, product_id);

CREATE SEQUENCE IF NOT EXISTS public.wh_stock_transfer_no_seq;

CREATE TABLE IF NOT EXISTS public.wh_stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no TEXT NOT NULL UNIQUE,
  from_location_id UUID NOT NULL REFERENCES public.wh_storage_locations(id),
  to_location_id UUID NOT NULL REFERENCES public.wh_storage_locations(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  note TEXT,
  created_by UUID NOT NULL REFERENCES public.us_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  posted_by UUID REFERENCES public.us_users(id),
  posted_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES public.us_users(id),
  cancelled_at TIMESTAMPTZ,
  cancel_note TEXT,
  CHECK (from_location_id <> to_location_id)
);

CREATE INDEX IF NOT EXISTS idx_wh_stock_transfers_created
  ON public.wh_stock_transfers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wh_stock_transfers_locations
  ON public.wh_stock_transfers(from_location_id, to_location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.wh_stock_transfer_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES public.wh_stock_transfers(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.pr_products(id) ON DELETE RESTRICT,
  qty NUMERIC(14,2) NOT NULL CHECK (qty > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (transfer_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_wh_stock_transfer_items_product
  ON public.wh_stock_transfer_items(product_id, transfer_id);

ALTER TABLE public.wh_storage_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_location_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_stock_transfer_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Warehouse locations readable" ON public.wh_storage_locations;
CREATE POLICY "Warehouse locations readable" ON public.wh_storage_locations
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Warehouse location stock readable" ON public.wh_location_stock;
CREATE POLICY "Warehouse location stock readable" ON public.wh_location_stock
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Warehouse transfers readable" ON public.wh_stock_transfers;
CREATE POLICY "Warehouse transfers readable" ON public.wh_stock_transfers
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Warehouse transfer items readable" ON public.wh_stock_transfer_items;
CREATE POLICY "Warehouse transfer items readable" ON public.wh_stock_transfer_items
  FOR SELECT TO authenticated USING (true);

REVOKE INSERT, UPDATE, DELETE ON public.wh_storage_locations FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.wh_location_stock FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.wh_stock_transfers FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.wh_stock_transfer_items FROM authenticated;

CREATE OR REPLACE FUNCTION public.can_manage_warehouse_locations()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'sales-tr', 'store')
  );
$$;

CREATE OR REPLACE FUNCTION public.rpc_upsert_storage_location(
  p_id UUID,
  p_code TEXT,
  p_name TEXT DEFAULT NULL,
  p_location_type TEXT DEFAULT 'reserve',
  p_is_active BOOLEAN DEFAULT true
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT public.can_manage_warehouse_locations() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์จัดการจุดจัดเก็บ';
  END IF;
  IF NULLIF(BTRIM(p_code), '') IS NULL THEN
    RAISE EXCEPTION 'กรุณาระบุรหัสจุดจัดเก็บ';
  END IF;
  IF p_location_type NOT IN ('picking', 'reserve', 'hold', 'unallocated') THEN
    RAISE EXCEPTION 'ประเภทจุดจัดเก็บไม่ถูกต้อง';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.wh_storage_locations(code, name, location_type, is_active, created_by)
    VALUES (UPPER(BTRIM(p_code)), NULLIF(BTRIM(p_name), ''), p_location_type, p_is_active, auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.wh_storage_locations
    SET code = UPPER(BTRIM(p_code)), name = NULLIF(BTRIM(p_name), ''),
        location_type = p_location_type, is_active = p_is_active, updated_at = NOW()
    WHERE id = p_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'ไม่พบจุดจัดเก็บ'; END IF;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_next_stock_transfer_no()
RETURNS TEXT
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT 'TRF-' || TO_CHAR(CURRENT_DATE, 'YYYYMMDD') || '-' ||
         LPAD(NEXTVAL('public.wh_stock_transfer_no_seq')::TEXT, 5, '0');
$$;

CREATE OR REPLACE FUNCTION public.fn_apply_location_stock_delta(
  p_product_id UUID,
  p_qty_delta NUMERIC
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_remaining NUMERIC := ABS(COALESCE(p_qty_delta, 0));
  v_location_id UUID;
  v_take NUMERIC;
  v_row RECORD;
BEGIN
  IF COALESCE(p_qty_delta, 0) = 0 THEN RETURN; END IF;

  SELECT id INTO v_location_id
  FROM public.wh_storage_locations
  WHERE is_active
  ORDER BY CASE location_type WHEN 'picking' THEN 0 WHEN 'unallocated' THEN 1 ELSE 2 END,
           sort_order, code
  LIMIT 1;

  IF v_location_id IS NULL THEN
    INSERT INTO public.wh_storage_locations(code, name, location_type, sort_order)
    VALUES ('MAIN', 'จุดจัดเก็บหลัก', 'picking', 0)
    ON CONFLICT ((LOWER(BTRIM(code)))) DO UPDATE SET is_active = true
    RETURNING id INTO v_location_id;
  END IF;

  IF p_qty_delta > 0 THEN
    INSERT INTO public.wh_location_stock(product_id, location_id, qty)
    VALUES (p_product_id, v_location_id, p_qty_delta)
    ON CONFLICT (product_id, location_id) DO UPDATE
      SET qty = public.wh_location_stock.qty + EXCLUDED.qty, updated_at = NOW();
    RETURN;
  END IF;

  FOR v_row IN
    SELECT stock.location_id, stock.qty
    FROM public.wh_location_stock stock
    JOIN public.wh_storage_locations location ON location.id = stock.location_id
    WHERE stock.product_id = p_product_id AND stock.qty > 0
    ORDER BY CASE location.location_type WHEN 'picking' THEN 0 WHEN 'unallocated' THEN 1 ELSE 2 END,
             location.sort_order, location.code
    FOR UPDATE OF stock
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_remaining, v_row.qty);
    UPDATE public.wh_location_stock
    SET qty = qty - v_take, updated_at = NOW()
    WHERE product_id = p_product_id AND location_id = v_row.location_id;
    v_remaining := v_remaining - v_take;
  END LOOP;

  -- Legacy or exceptional movement may exceed the location ledger. Keep the
  -- operational transaction working; reconciliation will expose the gap.
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_sync_location_stock_from_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.fn_apply_location_stock_delta(NEW.product_id, NEW.qty);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_location_stock_from_movement ON public.inv_stock_movements;
CREATE TRIGGER sync_location_stock_from_movement
AFTER INSERT ON public.inv_stock_movements
FOR EACH ROW EXECUTE FUNCTION public.trg_sync_location_stock_from_movement();

CREATE OR REPLACE FUNCTION public.rpc_create_stock_transfer(
  p_from_location_id UUID,
  p_to_location_id UUID,
  p_items JSONB,
  p_note TEXT DEFAULT NULL,
  p_post BOOLEAN DEFAULT true
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_transfer_id UUID;
  v_item JSONB;
  v_product_id UUID;
  v_qty NUMERIC;
BEGIN
  IF NOT public.can_manage_warehouse_locations() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์สร้างใบย้ายตำแหน่ง';
  END IF;
  IF p_from_location_id IS NULL OR p_to_location_id IS NULL OR p_from_location_id = p_to_location_id THEN
    RAISE EXCEPTION 'ต้นทางและปลายทางต้องไม่ซ้ำกัน';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'กรุณาเพิ่มสินค้าอย่างน้อย 1 รายการ';
  END IF;

  INSERT INTO public.wh_stock_transfers(
    transfer_no, from_location_id, to_location_id, status, note, created_by
  ) VALUES (
    public.fn_next_stock_transfer_no(), p_from_location_id, p_to_location_id,
    CASE WHEN p_post THEN 'posted' ELSE 'draft' END,
    NULLIF(BTRIM(p_note), ''), auth.uid()
  ) RETURNING id INTO v_transfer_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_qty := (v_item->>'qty')::NUMERIC;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'จำนวนย้ายต้องมากกว่า 0'; END IF;

    INSERT INTO public.wh_stock_transfer_items(transfer_id, product_id, qty)
    VALUES (v_transfer_id, v_product_id, v_qty);

    IF p_post THEN
      UPDATE public.wh_location_stock
      SET qty = qty - v_qty, updated_at = NOW()
      WHERE product_id = v_product_id AND location_id = p_from_location_id AND qty >= v_qty;
      IF NOT FOUND THEN RAISE EXCEPTION 'สินค้าในจุดต้นทางมีไม่เพียงพอ'; END IF;

      INSERT INTO public.wh_location_stock(product_id, location_id, qty)
      VALUES (v_product_id, p_to_location_id, v_qty)
      ON CONFLICT (product_id, location_id) DO UPDATE
        SET qty = public.wh_location_stock.qty + EXCLUDED.qty, updated_at = NOW();
    END IF;
  END LOOP;

  IF p_post THEN
    UPDATE public.wh_stock_transfers
    SET posted_by = auth.uid(), posted_at = NOW()
    WHERE id = v_transfer_id;
  END IF;
  RETURN v_transfer_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_post_stock_transfer(p_transfer_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_transfer public.wh_stock_transfers%ROWTYPE; v_item RECORD;
BEGIN
  IF NOT public.can_manage_warehouse_locations() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ยืนยันใบย้าย'; END IF;
  SELECT * INTO v_transfer FROM public.wh_stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_transfer.id IS NULL THEN RAISE EXCEPTION 'ไม่พบใบย้าย'; END IF;
  IF v_transfer.status <> 'draft' THEN RAISE EXCEPTION 'ยืนยันได้เฉพาะใบสถานะร่าง'; END IF;

  FOR v_item IN SELECT * FROM public.wh_stock_transfer_items WHERE transfer_id = p_transfer_id
  LOOP
    UPDATE public.wh_location_stock SET qty = qty - v_item.qty, updated_at = NOW()
    WHERE product_id = v_item.product_id AND location_id = v_transfer.from_location_id AND qty >= v_item.qty;
    IF NOT FOUND THEN RAISE EXCEPTION 'สินค้าในจุดต้นทางมีไม่เพียงพอ'; END IF;
    INSERT INTO public.wh_location_stock(product_id, location_id, qty)
    VALUES (v_item.product_id, v_transfer.to_location_id, v_item.qty)
    ON CONFLICT (product_id, location_id) DO UPDATE
      SET qty = public.wh_location_stock.qty + EXCLUDED.qty, updated_at = NOW();
  END LOOP;
  UPDATE public.wh_stock_transfers SET status='posted', posted_by=auth.uid(), posted_at=NOW()
  WHERE id=p_transfer_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cancel_stock_transfer(p_transfer_id UUID, p_note TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_transfer public.wh_stock_transfers%ROWTYPE; v_item RECORD;
BEGIN
  IF NOT public.can_manage_warehouse_locations() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ยกเลิกใบย้าย'; END IF;
  SELECT * INTO v_transfer FROM public.wh_stock_transfers WHERE id=p_transfer_id FOR UPDATE;
  IF v_transfer.id IS NULL OR v_transfer.status='cancelled' THEN RAISE EXCEPTION 'ไม่พบใบย้ายหรือใบถูกยกเลิกแล้ว'; END IF;
  IF v_transfer.status='posted' THEN
    FOR v_item IN SELECT * FROM public.wh_stock_transfer_items WHERE transfer_id=p_transfer_id LOOP
      UPDATE public.wh_location_stock SET qty=qty-v_item.qty, updated_at=NOW()
      WHERE product_id=v_item.product_id AND location_id=v_transfer.to_location_id AND qty>=v_item.qty;
      IF NOT FOUND THEN RAISE EXCEPTION 'ยกเลิกไม่ได้: สินค้าที่ปลายทางคงเหลือไม่พอ'; END IF;
      INSERT INTO public.wh_location_stock(product_id, location_id, qty)
      VALUES (v_item.product_id, v_transfer.from_location_id, v_item.qty)
      ON CONFLICT (product_id, location_id) DO UPDATE SET qty=public.wh_location_stock.qty+EXCLUDED.qty, updated_at=NOW();
    END LOOP;
  END IF;
  UPDATE public.wh_stock_transfers SET status='cancelled', cancelled_by=auth.uid(), cancelled_at=NOW(), cancel_note=NULLIF(BTRIM(p_note),'')
  WHERE id=p_transfer_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_product_location_summary(p_product_id UUID)
RETURNS TABLE(location_id UUID, code TEXT, name TEXT, location_type TEXT, qty NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public, pg_temp
AS $$
  SELECT location.id, location.code, location.name, location.location_type, COALESCE(stock.qty,0)
  FROM public.wh_storage_locations location
  LEFT JOIN public.wh_location_stock stock ON stock.location_id=location.id AND stock.product_id=p_product_id
  WHERE location.is_active AND COALESCE(stock.qty,0) <> 0
  ORDER BY CASE location.location_type WHEN 'picking' THEN 0 WHEN 'reserve' THEN 1 WHEN 'hold' THEN 2 ELSE 3 END,
           location.sort_order, location.code;
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_product_transfer_history(p_product_id UUID, p_limit INTEGER DEFAULT 5)
RETURNS TABLE(id UUID, transfer_no TEXT, created_at TIMESTAMPTZ, posted_at TIMESTAMPTZ,
  from_code TEXT, to_code TEXT, qty NUMERIC, status TEXT, created_by_name TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public, pg_temp
AS $$
  SELECT transfer.id, transfer.transfer_no, transfer.created_at, transfer.posted_at,
         source.code, destination.code, item.qty, transfer.status,
         COALESCE(NULLIF(BTRIM(author.username),''), author.email, transfer.created_by::TEXT)
  FROM public.wh_stock_transfer_items item
  JOIN public.wh_stock_transfers transfer ON transfer.id=item.transfer_id
  JOIN public.wh_storage_locations source ON source.id=transfer.from_location_id
  JOIN public.wh_storage_locations destination ON destination.id=transfer.to_location_id
  LEFT JOIN public.us_users author ON author.id=transfer.created_by
  WHERE item.product_id=p_product_id AND transfer.status='posted'
  ORDER BY COALESCE(transfer.posted_at, transfer.created_at) DESC, transfer.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit,5),1),100);
$$;

-- Seed the current physical stock into each product's existing storage_location.
INSERT INTO public.wh_storage_locations(code, name, location_type, sort_order)
VALUES ('MAIN', 'จุดหยิบหลัก', 'picking', 0)
ON CONFLICT ((LOWER(BTRIM(code)))) DO NOTHING;

INSERT INTO public.wh_storage_locations(code, name, location_type, sort_order)
SELECT DISTINCT UPPER(BTRIM(product.storage_location)), BTRIM(product.storage_location), 'reserve', 100
FROM public.pr_products product
WHERE NULLIF(BTRIM(product.storage_location), '') IS NOT NULL
ON CONFLICT ((LOWER(BTRIM(code)))) DO NOTHING;

INSERT INTO public.wh_location_stock(product_id, location_id, qty)
SELECT balance.product_id,
       COALESCE(product_location.id, main_location.id),
       GREATEST(COALESCE(balance.on_hand,0) + COALESCE(balance.safety_stock,0), 0)
FROM public.inv_stock_balances balance
JOIN public.pr_products product ON product.id=balance.product_id
CROSS JOIN LATERAL (
  SELECT id FROM public.wh_storage_locations WHERE LOWER(BTRIM(code))='main' LIMIT 1
) main_location
LEFT JOIN public.wh_storage_locations product_location
  ON LOWER(BTRIM(product_location.code))=LOWER(BTRIM(product.storage_location))
WHERE COALESCE(balance.on_hand,0) + COALESCE(balance.safety_stock,0) > 0
ON CONFLICT (product_id, location_id) DO NOTHING;

GRANT SELECT ON public.wh_storage_locations, public.wh_location_stock,
  public.wh_stock_transfers, public.wh_stock_transfer_items TO authenticated;
REVOKE ALL ON FUNCTION public.can_manage_warehouse_locations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_next_stock_transfer_no() FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.fn_apply_location_stock_delta(UUID,NUMERIC) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.trg_sync_location_stock_from_movement() FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.rpc_upsert_storage_location(UUID,TEXT,TEXT,TEXT,BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_create_stock_transfer(UUID,UUID,JSONB,TEXT,BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_post_stock_transfer(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cancel_stock_transfer(UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_get_product_location_summary(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_get_product_transfer_history(UUID,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_warehouse_locations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_storage_location(UUID,TEXT,TEXT,TEXT,BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_stock_transfer(UUID,UUID,JSONB,TEXT,BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_post_stock_transfer(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_stock_transfer(UUID,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_product_location_summary(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_product_transfer_history(UUID,INTEGER) TO authenticated;

COMMIT;
