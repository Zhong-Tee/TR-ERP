-- Separate approval from physical processing. Stock changes only on completion.

BEGIN;

ALTER TABLE public.pp_production_orders
  DROP CONSTRAINT IF EXISTS pp_production_orders_status_check;
ALTER TABLE public.pp_production_orders
  ADD CONSTRAINT pp_production_orders_status_check
  CHECK (status IN ('open', 'pending', 'approved', 'processing', 'completed', 'rejected'));

ALTER TABLE public.pp_production_orders
  ADD COLUMN IF NOT EXISTS started_by UUID REFERENCES public.us_users(id),
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_by UUID REFERENCES public.us_users(id),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.guard_pp_production_create_roles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE v_role text;
BEGIN
  SELECT role INTO v_role FROM public.us_users
  WHERE id = auth.uid() AND is_active IS TRUE;
  IF v_role IS NULL OR v_role NOT IN ('production', 'store', 'admin', 'superadmin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์สร้างใบแปรรูป';
  END IF;
  NEW.created_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_pp_production_create_roles ON public.pp_production_orders;
CREATE TRIGGER trg_guard_pp_production_create_roles
  BEFORE INSERT ON public.pp_production_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_pp_production_create_roles();

CREATE OR REPLACE FUNCTION public.guard_pp_production_status_roles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE v_role text;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
  SELECT role INTO v_role FROM public.us_users
  WHERE id = auth.uid() AND is_active IS TRUE;

  IF NEW.status = 'pending' AND (v_role IS NULL OR v_role NOT IN ('production', 'store', 'admin', 'superadmin')) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ส่งใบแปรรูปเพื่ออนุมัติ';
  ELSIF NEW.status IN ('approved', 'rejected') AND (v_role IS NULL OR v_role NOT IN ('store', 'admin', 'superadmin')) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติหรือปฏิเสธใบแปรรูป';
  ELSIF NEW.status IN ('processing', 'completed') AND (v_role IS NULL OR v_role NOT IN ('production', 'admin', 'superadmin')) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดำเนินการแปรรูป';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_pp_production_status_roles ON public.pp_production_orders;
CREATE TRIGGER trg_guard_pp_production_status_roles
  BEFORE UPDATE OF status ON public.pp_production_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_pp_production_status_roles();

CREATE OR REPLACE FUNCTION public.rpc_approve_production_order(p_order_id UUID, p_user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_status TEXT;
  v_over RECORD;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid AND is_active IS TRUE;
  IF v_role IS NULL OR v_role NOT IN ('store', 'admin', 'superadmin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติใบแปรรูป';
  END IF;

  SELECT status INTO v_status FROM pp_production_orders WHERE id = p_order_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบใบแปรรูป'; END IF;
  IF v_status <> 'pending' THEN RAISE EXCEPTION 'ใบแปรรูปไม่ได้อยู่ในสถานะรออนุมัติ'; END IF;

  SELECT p.product_code, COALESCE(b.on_hand, 0) AS on_hand, oi.qty, r.max_stock
  INTO v_over
  FROM pp_production_order_items oi
  JOIN pp_recipes r ON r.product_id = oi.product_id
  JOIN pr_products p ON p.id = oi.product_id
  LEFT JOIN inv_stock_balances b ON b.product_id = oi.product_id
  WHERE oi.order_id = p_order_id AND r.max_stock IS NOT NULL
    AND COALESCE(b.on_hand, 0) + oi.qty > r.max_stock
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'สินค้า % คงเหลือ % + ผลิต % จะเกิน Max %',
      v_over.product_code, v_over.on_hand, v_over.qty, v_over.max_stock;
  END IF;

  UPDATE pp_production_orders SET
    status = 'approved', approved_by = v_uid, approved_at = now()
  WHERE id = p_order_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_reject_production_order(p_order_id UUID, p_user_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID := auth.uid(); v_role TEXT; v_status TEXT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid AND is_active IS TRUE;
  IF v_role IS NULL OR v_role NOT IN ('store', 'admin', 'superadmin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ปฏิเสธใบแปรรูป';
  END IF;
  SELECT status INTO v_status FROM pp_production_orders WHERE id = p_order_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบใบแปรรูป'; END IF;
  IF v_status <> 'pending' THEN RAISE EXCEPTION 'ใบแปรรูปไม่ได้อยู่ในสถานะรออนุมัติ'; END IF;
  UPDATE pp_production_orders SET status = 'rejected', rejected_by = v_uid,
    rejected_at = now(), rejection_reason = p_reason WHERE id = p_order_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_start_production_order(p_order_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID := auth.uid(); v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid AND is_active IS TRUE;
  IF v_role IS NULL OR v_role NOT IN ('production', 'admin', 'superadmin') THEN
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
  IF v_role IS NULL OR v_role NOT IN ('production', 'admin', 'superadmin') THEN
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

CREATE OR REPLACE FUNCTION public.guard_pp_production_max_stock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_over record;
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'completed' THEN
    SELECT p.product_code, COALESCE(b.on_hand, 0) AS on_hand, r.max_stock INTO v_over
    FROM public.pp_production_order_items oi
    JOIN public.pp_recipes r ON r.product_id = oi.product_id
    JOIN public.pr_products p ON p.id = oi.product_id
    LEFT JOIN public.inv_stock_balances b ON b.product_id = oi.product_id
    WHERE oi.order_id = NEW.id AND r.max_stock IS NOT NULL AND COALESCE(b.on_hand, 0) > r.max_stock LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'สินค้า % คงเหลือ % เกิน Max %', v_over.product_code, v_over.on_hand, v_over.max_stock; END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
