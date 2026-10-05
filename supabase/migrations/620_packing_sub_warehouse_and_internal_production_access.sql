-- Give packing_staff the same operational capabilities as production in these two menus.
BEGIN;

INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES
  ('packing_staff', 'warehouse', 'คลัง', true),
  ('packing_staff', 'warehouse-sub', 'คลังย่อย', true),
  ('packing_staff', 'warehouse-production', 'ผลิตภายใน', true)
ON CONFLICT (role, menu_key) DO UPDATE SET
  menu_name = EXCLUDED.menu_name,
  has_access = EXCLUDED.has_access,
  updated_at = now();

-- Recipe writes and approval remain restricted to their existing roles.
DROP POLICY IF EXISTS "pp_recipes read" ON public.pp_recipes;
CREATE POLICY "pp_recipes read" ON public.pp_recipes FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.us_users
  WHERE id = auth.uid() AND is_active IS TRUE
    AND role IN ('superadmin', 'admin', 'store', 'production', 'packing_staff', 'account')
));

DROP POLICY IF EXISTS "pp_recipe_includes read" ON public.pp_recipe_includes;
CREATE POLICY "pp_recipe_includes read" ON public.pp_recipe_includes FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.us_users WHERE id = auth.uid() AND is_active IS TRUE
    AND role IN ('superadmin', 'admin', 'store', 'production', 'packing_staff', 'account')
));

DROP POLICY IF EXISTS "pp_recipe_removes read" ON public.pp_recipe_removes;
CREATE POLICY "pp_recipe_removes read" ON public.pp_recipe_removes FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.us_users WHERE id = auth.uid() AND is_active IS TRUE
    AND role IN ('superadmin', 'admin', 'store', 'production', 'packing_staff', 'account')
));

DROP POLICY IF EXISTS "pp_production_orders read" ON public.pp_production_orders;
CREATE POLICY "pp_production_orders read" ON public.pp_production_orders FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.us_users WHERE id = auth.uid() AND is_active IS TRUE
    AND role IN ('superadmin', 'admin', 'store', 'production', 'packing_staff', 'account')
));

DROP POLICY IF EXISTS "pp_production_order_items read" ON public.pp_production_order_items;
CREATE POLICY "pp_production_order_items read" ON public.pp_production_order_items FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.us_users WHERE id = auth.uid() AND is_active IS TRUE
    AND role IN ('superadmin', 'admin', 'store', 'production', 'packing_staff', 'account')
));

CREATE OR REPLACE FUNCTION rpc_create_production_order(
  p_title   TEXT,
  p_note    TEXT,
  p_items   JSONB,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     TEXT;
  v_uid      UUID := auth.uid();
  v_order_id UUID;
  v_doc_no   TEXT;
  v_item     JSONB;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'store', 'production', 'packing_staff') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์สร้างใบผลิต (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  v_doc_no := rpc_generate_pp_doc_no();

  INSERT INTO pp_production_orders (doc_no, title, status, note, created_by)
  VALUES (v_doc_no, p_title, 'open', p_note, v_uid)
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO pp_production_order_items (order_id, product_id, qty)
    VALUES (
      v_order_id,
      (v_item->>'product_id')::UUID,
      (v_item->>'qty')::NUMERIC
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_order_id, 'doc_no', v_doc_no);
END;
$$;

CREATE OR REPLACE FUNCTION rpc_submit_production_order(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   TEXT;
  v_status TEXT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'store', 'production', 'packing_staff') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ส่งอนุมัติใบผลิต (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT status INTO v_status FROM pp_production_orders WHERE id = p_order_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบใบผลิต'; END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'ใบผลิตไม่อยู่ในสถานะเปิด (status: %)', v_status;
  END IF;

  UPDATE pp_production_orders SET status = 'pending' WHERE id = p_order_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_pp_production_create_roles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE v_role text;
BEGIN
  SELECT role INTO v_role FROM public.us_users
  WHERE id = auth.uid() AND is_active IS TRUE;
  IF v_role IS NULL OR v_role NOT IN ('production', 'packing_staff', 'store', 'admin', 'superadmin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์สร้างใบแปรรูป';
  END IF;
  NEW.created_by := auth.uid();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_pp_production_status_roles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE v_role text;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
  SELECT role INTO v_role FROM public.us_users
  WHERE id = auth.uid() AND is_active IS TRUE;

  IF NEW.status = 'pending' AND (v_role IS NULL OR v_role NOT IN ('production', 'packing_staff', 'store', 'admin', 'superadmin')) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ส่งใบแปรรูปเพื่ออนุมัติ';
  ELSIF NEW.status IN ('approved', 'rejected') AND (v_role IS NULL OR v_role NOT IN ('store', 'admin', 'superadmin')) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติหรือปฏิเสธใบแปรรูป';
  ELSIF NEW.status IN ('processing', 'completed') AND (v_role IS NULL OR v_role NOT IN ('production', 'packing_staff', 'admin', 'superadmin')) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดำเนินการแปรรูป';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_start_production_order(p_order_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID := auth.uid(); v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid AND is_active IS TRUE;
  IF v_role IS NULL OR v_role NOT IN ('production', 'packing_staff', 'admin', 'superadmin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์เริ่มแปรรูป';
  END IF;
  UPDATE pp_production_orders SET status = 'processing', started_by = v_uid, started_at = now()
  WHERE id = p_order_id AND status = 'approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'ใบแปรรูปไม่ได้อยู่ในสถานะรอแปรรูป'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_complete_production_order(p_order_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid(); v_role TEXT; v_status TEXT;
  v_oi RECORD; v_inc RECORD; v_rem RECORD; v_recipe_id UUID; v_max_stock NUMERIC;
  v_needed NUMERIC; v_on_hand NUMERIC; v_include_cost NUMERIC;
  v_remove_cost NUMERIC; v_pp_unit_cost NUMERIC; v_movement_id UUID;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid AND is_active IS TRUE;
  IF v_role IS NULL OR v_role NOT IN ('production', 'packing_staff', 'admin', 'superadmin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยืนยันแปรรูปสำเร็จ';
  END IF;

  SELECT status INTO v_status FROM pp_production_orders WHERE id = p_order_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบใบแปรรูป'; END IF;
  IF v_status <> 'processing' THEN RAISE EXCEPTION 'ต้องกดกำลังทำก่อนยืนยันแปรรูปสำเร็จ'; END IF;

  FOR v_oi IN SELECT id, product_id, qty FROM pp_production_order_items WHERE order_id = p_order_id LOOP
    SELECT id, max_stock INTO v_recipe_id, v_max_stock FROM pp_recipes WHERE product_id = v_oi.product_id;
    IF v_recipe_id IS NULL THEN RAISE EXCEPTION 'ไม่พบสูตรแปรรูปสำหรับสินค้า %', v_oi.product_id; END IF;

    SELECT COALESCE(on_hand, 0) INTO v_on_hand FROM inv_stock_balances
      WHERE product_id = v_oi.product_id FOR UPDATE;
    IF v_max_stock IS NOT NULL AND COALESCE(v_on_hand, 0) + v_oi.qty > v_max_stock THEN
      RAISE EXCEPTION 'จำนวนสินค้า PP หลังแปรรูปจะเกิน Max ที่กำหนด';
    END IF;

    v_include_cost := 0; v_remove_cost := 0;
    FOR v_inc IN SELECT product_id, qty FROM pp_recipe_includes WHERE recipe_id = v_recipe_id LOOP
      v_needed := v_inc.qty * v_oi.qty;
      SELECT COALESCE(on_hand, 0) INTO v_on_hand FROM inv_stock_balances
        WHERE product_id = v_inc.product_id FOR UPDATE;
      IF COALESCE(v_on_hand, 0) < v_needed THEN
        RAISE EXCEPTION 'สต๊อควัตถุดิบ % ไม่เพียงพอ (ต้องการ %, คงเหลือ %)', v_inc.product_id, v_needed, COALESCE(v_on_hand, 0);
      END IF;
      UPDATE inv_stock_balances SET on_hand = on_hand - v_needed, updated_at = now()
        WHERE product_id = v_inc.product_id;
      INSERT INTO inv_stock_movements(product_id, movement_type, qty, ref_type, ref_id, note, created_by)
      VALUES(v_inc.product_id, 'pp_consume', -v_needed, 'pp_production_orders', p_order_id, 'ตัดสต๊อคเมื่อแปรรูปสำเร็จ', v_uid)
      RETURNING id INTO v_movement_id;
      v_include_cost := v_include_cost + fn_consume_stock_fifo(v_inc.product_id, v_needed, v_movement_id);
      PERFORM fn_recalc_product_landed_cost(v_inc.product_id);
    END LOOP;

    FOR v_rem IN SELECT product_id, qty, unit_cost FROM pp_recipe_removes WHERE recipe_id = v_recipe_id LOOP
      v_remove_cost := v_remove_cost + (v_rem.qty * v_oi.qty * v_rem.unit_cost);
      INSERT INTO inv_stock_balances(product_id, on_hand, reserved, safety_stock)
      VALUES(v_rem.product_id, v_rem.qty * v_oi.qty, 0, 0)
      ON CONFLICT(product_id) DO UPDATE SET on_hand = inv_stock_balances.on_hand + EXCLUDED.on_hand, updated_at = now();
      INSERT INTO inv_stock_movements(product_id, movement_type, qty, ref_type, ref_id, note, created_by, unit_cost, total_cost)
      VALUES(v_rem.product_id, 'pp_remove', v_rem.qty * v_oi.qty, 'pp_production_orders', p_order_id,
        'รับสินค้าแยกออกเมื่อแปรรูปสำเร็จ', v_uid, v_rem.unit_cost, v_rem.qty * v_oi.qty * v_rem.unit_cost);
      INSERT INTO inv_stock_lots(product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id)
      VALUES(v_rem.product_id, v_rem.qty * v_oi.qty, v_rem.qty * v_oi.qty, v_rem.unit_cost, 'pp_production_orders', p_order_id);
      PERFORM fn_recalc_product_landed_cost(v_rem.product_id);
    END LOOP;

    v_pp_unit_cost := CASE WHEN v_oi.qty > 0 THEN (v_include_cost - v_remove_cost) / v_oi.qty ELSE 0 END;
    UPDATE pp_production_order_items SET unit_cost = v_pp_unit_cost, total_cost = v_pp_unit_cost * v_oi.qty WHERE id = v_oi.id;
    INSERT INTO inv_stock_balances(product_id, on_hand, reserved, safety_stock)
    VALUES(v_oi.product_id, v_oi.qty, 0, 0)
    ON CONFLICT(product_id) DO UPDATE SET on_hand = inv_stock_balances.on_hand + EXCLUDED.on_hand, updated_at = now();
    INSERT INTO inv_stock_movements(product_id, movement_type, qty, ref_type, ref_id, note, created_by, unit_cost, total_cost)
    VALUES(v_oi.product_id, 'pp_produce', v_oi.qty, 'pp_production_orders', p_order_id,
      'รับเข้าเมื่อแปรรูปสำเร็จ', v_uid, v_pp_unit_cost, v_pp_unit_cost * v_oi.qty);
    INSERT INTO inv_stock_lots(product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id)
    VALUES(v_oi.product_id, v_oi.qty, v_oi.qty, v_pp_unit_cost, 'pp_production_orders', p_order_id);
    PERFORM fn_recalc_product_landed_cost(v_oi.product_id);
  END LOOP;

  UPDATE pp_production_orders SET status = 'completed', completed_by = v_uid, completed_at = now()
  WHERE id = p_order_id;
END;
$$;

COMMIT;
