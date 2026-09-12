-- Machinery purchase requests: safe product catalogue + PR handoff.

BEGIN;

CREATE TABLE IF NOT EXISTS public.pr_machinery_purchase_products (
  product_id uuid PRIMARY KEY REFERENCES public.pr_products(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES public.us_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pr_machinery_purchase_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users view machinery purchase products" ON public.pr_machinery_purchase_products;
CREATE POLICY "Authenticated users view machinery purchase products"
  ON public.pr_machinery_purchase_products FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Admins manage machinery purchase products" ON public.pr_machinery_purchase_products;
CREATE POLICY "Admins manage machinery purchase products"
  ON public.pr_machinery_purchase_products FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin')));

CREATE OR REPLACE FUNCTION public.get_machinery_purchase_products(p_include_disabled boolean DEFAULT false)
RETURNS TABLE (
  product_id uuid,
  product_code text,
  product_name text,
  product_category text,
  unit_name text,
  storage_location text,
  on_hand numeric,
  enabled boolean
)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT p.id, p.product_code, p.product_name, p.product_category, p.unit_name,
         p.storage_location, COALESCE(b.on_hand, 0), COALESCE(mp.enabled, false)
  FROM pr_products p
  LEFT JOIN pr_machinery_purchase_products mp ON mp.product_id = p.id
  LEFT JOIN inv_stock_balances b ON b.product_id = p.id
  WHERE p.is_active = true
    AND (p_include_disabled OR COALESCE(mp.enabled, false))
  ORDER BY p.product_code;
$$;

CREATE OR REPLACE FUNCTION public.set_machinery_purchase_product(p_product_id uuid, p_enabled boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin')) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตั้งค่ารายการสินค้า';
  END IF;
  INSERT INTO pr_machinery_purchase_products(product_id, enabled, updated_by, updated_at)
  VALUES (p_product_id, p_enabled, auth.uid(), now())
  ON CONFLICT (product_id) DO UPDATE
    SET enabled = EXCLUDED.enabled, updated_by = auth.uid(), updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_create_machinery_pr(p_items jsonb, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_role text;
  v_pr_id uuid;
  v_pr_no text;
  v_item jsonb;
  v_last_price numeric(12,2);
  v_today text;
  v_seq int;
  v_product_id uuid;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'production', 'production_mb', 'manager', 'technician') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์สร้างคำขอซื้อ Machinery';
  END IF;
  IF jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'กรุณาเลือกรายการสินค้า';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('pr_no_gen'));
  v_today := to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD');
  SELECT COALESCE(MAX(CAST(split_part(pr_no, '-', 3) AS integer)), 0) + 1 INTO v_seq
  FROM inv_pr WHERE pr_no LIKE 'PR-' || v_today || '-___';
  v_pr_no := 'PR-' || v_today || '-' || lpad(v_seq::text, 3, '0');

  INSERT INTO inv_pr(pr_no, status, requested_by, requested_at, note, pr_type)
  VALUES(v_pr_no, 'pending', auth.uid(), now(), p_note, 'machinery') RETURNING id INTO v_pr_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM pr_machinery_purchase_products WHERE product_id = v_product_id AND enabled) THEN
      RAISE EXCEPTION 'สินค้านี้ไม่ได้เปิดให้ขอซื้อใน Machinery';
    END IF;
    SELECT last_price INTO v_last_price FROM v_product_last_price WHERE product_id = v_product_id;
    INSERT INTO inv_pr_items(pr_id, product_id, qty, unit, estimated_price, last_purchase_price, note)
    VALUES(v_pr_id, v_product_id, (v_item->>'qty')::numeric, v_item->>'unit', v_last_price, v_last_price, v_item->>'note');
  END LOOP;
  RETURN jsonb_build_object('id', v_pr_id, 'pr_no', v_pr_no);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_machinery_purchase_products(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_machinery_purchase_product(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_machinery_pr(jsonb, text) TO authenticated;

COMMIT;
