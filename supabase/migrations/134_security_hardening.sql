-- =============================================================================
-- 134: Security Hardening — ปิดช่องโหว่ความปลอดภัยทั้งระบบ
-- PHASES 0-3: Critical fixes + Auth helpers + RPC hardening + Loose RLS fix
-- IDEMPOTENT: safe to re-run
-- =============================================================================

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 0-A: CRITICAL — ป้องกัน us_users role escalation
-- ปัญหา: user ธรรมดา UPDATE role ตัวเองเป็น superadmin ได้
-- แก้: แยก policy เป็น self-update (ห้ามแก้ role) กับ admin-update
-- ═══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Admins can update users" ON us_users;
DROP POLICY IF EXISTS "Users self update non-role" ON us_users;
DROP POLICY IF EXISTS "Admins update any user" ON us_users;

CREATE POLICY "Users self update non-role"
  ON us_users FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    AND role IS NOT DISTINCT FROM (SELECT u.role FROM us_users u WHERE u.id = auth.uid())
  );

CREATE POLICY "Admins update any user"
  ON us_users FOR UPDATE
  USING (
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin-tr'])
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 0-B: CRITICAL — แก้ hr_warnings / hr_certificates จาก USING(true)
-- ปัญหา: ใครก็ได้ (รวม anon) อ่าน/แก้/ลบ ใบเตือนและใบรับรองได้
-- แก้: ใช้ hr_is_admin() + employee self-access เหมือน HR tables อื่น
-- ═══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "hr_warnings_all" ON hr_warnings;
DROP POLICY IF EXISTS "hr_warnings_select" ON hr_warnings;
DROP POLICY IF EXISTS "hr_warnings_insert" ON hr_warnings;
DROP POLICY IF EXISTS "hr_warnings_update" ON hr_warnings;
DROP POLICY IF EXISTS "hr_warnings_delete" ON hr_warnings;

CREATE POLICY "hr_warnings_select" ON hr_warnings
  FOR SELECT TO authenticated
  USING (hr_is_admin() OR employee_id = hr_my_employee_id());

CREATE POLICY "hr_warnings_insert" ON hr_warnings
  FOR INSERT TO authenticated
  WITH CHECK (hr_is_admin());

CREATE POLICY "hr_warnings_update" ON hr_warnings
  FOR UPDATE TO authenticated
  USING (hr_is_admin());

CREATE POLICY "hr_warnings_delete" ON hr_warnings
  FOR DELETE TO authenticated
  USING (hr_is_admin());

DROP POLICY IF EXISTS "hr_certificates_all" ON hr_certificates;
DROP POLICY IF EXISTS "hr_certificates_select" ON hr_certificates;
DROP POLICY IF EXISTS "hr_certificates_insert" ON hr_certificates;
DROP POLICY IF EXISTS "hr_certificates_update" ON hr_certificates;
DROP POLICY IF EXISTS "hr_certificates_delete" ON hr_certificates;

CREATE POLICY "hr_certificates_select" ON hr_certificates
  FOR SELECT TO authenticated
  USING (hr_is_admin() OR employee_id = hr_my_employee_id());

CREATE POLICY "hr_certificates_insert" ON hr_certificates
  FOR INSERT TO authenticated
  WITH CHECK (hr_is_admin());

CREATE POLICY "hr_certificates_update" ON hr_certificates
  FOR UPDATE TO authenticated
  USING (hr_is_admin());

CREATE POLICY "hr_certificates_delete" ON hr_certificates
  FOR DELETE TO authenticated
  USING (hr_is_admin());

-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 0-C: CRITICAL — แก้ RPC ที่ปลอมตัวตนผู้อนุมัติได้
-- ปัญหา: ฟังก์ชันรับ p_user_id จาก client ไม่เช็ค auth.uid()
-- แก้: ใช้ auth.uid() + เพิ่ม role check
-- ═══════════════════════════════════════════════════════════════════════════════

-- rpc_approve_pr: เพิ่ม role check + ใช้ auth.uid()
CREATE OR REPLACE FUNCTION rpc_approve_pr(p_pr_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_uid  UUID := auth.uid();
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติ PR (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  UPDATE inv_pr
  SET status = 'approved', approved_by = v_uid, approved_at = NOW()
  WHERE id = p_pr_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'PR ไม่อยู่ในสถานะรออนุมัติ'; END IF;
END;
$$;

-- rpc_reject_pr: เพิ่ม role check + ใช้ auth.uid()
CREATE OR REPLACE FUNCTION rpc_reject_pr(p_pr_id UUID, p_user_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_uid  UUID := auth.uid();
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ปฏิเสธ PR (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  UPDATE inv_pr
  SET status = 'rejected', rejected_by = v_uid, rejected_at = NOW(), rejection_reason = p_reason
  WHERE id = p_pr_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'PR ไม่อยู่ในสถานะรออนุมัติ'; END IF;
END;
$$;

-- rpc_mark_po_ordered: เพิ่ม role check + ใช้ auth.uid()
CREATE OR REPLACE FUNCTION rpc_mark_po_ordered(p_po_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_uid  UUID := auth.uid();
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์สั่งซื้อ PO (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  UPDATE inv_po
  SET status = 'ordered', ordered_by = v_uid, ordered_at = NOW()
  WHERE id = p_po_id AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'PO ไม่อยู่ในสถานะเปิด'; END IF;
END;
$$;

-- rpc_approve_production_order: แก้ให้ใช้ auth.uid() แทน p_user_id สำหรับ role check
CREATE OR REPLACE FUNCTION rpc_approve_production_order(
  p_order_id UUID,
  p_user_id  UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status          TEXT;
  v_role            TEXT;
  v_uid             UUID := auth.uid();
  v_oi              RECORD;
  v_inc             RECORD;
  v_rem             RECORD;
  v_recipe_id       UUID;
  v_needed          NUMERIC;
  v_on_hand         NUMERIC;
  v_include_cost    NUMERIC;
  v_remove_cost     NUMERIC;
  v_pp_unit_cost    NUMERIC;
  v_movement_id     UUID;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','admin-tr') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติ (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT status INTO v_status FROM pp_production_orders WHERE id = p_order_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบใบผลิต'; END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'ใบผลิตไม่อยู่ในสถานะรออนุมัติ (status: %)', v_status;
  END IF;

  FOR v_oi IN
    SELECT id, product_id, qty FROM pp_production_order_items WHERE order_id = p_order_id
  LOOP
    SELECT id INTO v_recipe_id FROM pp_recipes WHERE product_id = v_oi.product_id;
    IF v_recipe_id IS NULL THEN
      RAISE EXCEPTION 'ไม่พบสูตรแปรรูปสำหรับสินค้า %', v_oi.product_id;
    END IF;

    v_include_cost := 0;
    v_remove_cost  := 0;

    FOR v_inc IN
      SELECT ri.product_id, ri.qty
      FROM pp_recipe_includes ri
      WHERE ri.recipe_id = v_recipe_id
    LOOP
      v_needed := v_inc.qty * v_oi.qty;

      SELECT COALESCE(on_hand, 0) INTO v_on_hand
      FROM inv_stock_balances WHERE product_id = v_inc.product_id;
      IF COALESCE(v_on_hand, 0) < v_needed THEN
        RAISE EXCEPTION 'สต๊อคไม่เพียงพอสำหรับสินค้า % (ต้องการ %, คงเหลือ %)',
          v_inc.product_id, v_needed, COALESCE(v_on_hand, 0);
      END IF;

      UPDATE inv_stock_balances
      SET on_hand = on_hand - v_needed, updated_at = NOW()
      WHERE product_id = v_inc.product_id;

      INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note, created_by)
      VALUES (v_inc.product_id, 'pp_consume', -v_needed, 'pp_production_orders', p_order_id,
              'ตัดสต๊อคสำหรับผลิตภายใน', v_uid)
      RETURNING id INTO v_movement_id;

      v_include_cost := v_include_cost + fn_consume_stock_fifo(v_inc.product_id, v_needed, v_movement_id);
      PERFORM fn_recalc_product_landed_cost(v_inc.product_id);
    END LOOP;

    FOR v_rem IN
      SELECT rr.product_id, rr.qty, rr.unit_cost
      FROM pp_recipe_removes rr
      WHERE rr.recipe_id = v_recipe_id
    LOOP
      v_remove_cost := v_remove_cost + (v_rem.qty * v_oi.qty * v_rem.unit_cost);

      INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES (v_rem.product_id, v_rem.qty * v_oi.qty, 0, 0)
      ON CONFLICT (product_id) DO UPDATE
        SET on_hand = inv_stock_balances.on_hand + (v_rem.qty * v_oi.qty), updated_at = NOW();

      INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note, created_by,
                                       unit_cost, total_cost)
      VALUES (v_rem.product_id, 'pp_remove', v_rem.qty * v_oi.qty, 'pp_production_orders', p_order_id,
              'รับเข้าจากแยกสินค้าแปรรูป', v_uid,
              v_rem.unit_cost, v_rem.qty * v_oi.qty * v_rem.unit_cost);

      INSERT INTO inv_stock_lots (product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id)
      VALUES (v_rem.product_id, v_rem.qty * v_oi.qty, v_rem.qty * v_oi.qty, v_rem.unit_cost,
              'pp_production_orders', p_order_id);

      PERFORM fn_recalc_product_landed_cost(v_rem.product_id);
    END LOOP;

    v_pp_unit_cost := CASE
      WHEN v_oi.qty > 0 THEN (v_include_cost - v_remove_cost) / v_oi.qty
      ELSE 0
    END;

    UPDATE pp_production_order_items
    SET unit_cost  = v_pp_unit_cost,
        total_cost = v_pp_unit_cost * v_oi.qty
    WHERE id = v_oi.id;

    INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_oi.product_id, v_oi.qty, 0, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET on_hand = inv_stock_balances.on_hand + v_oi.qty, updated_at = NOW();

    INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note, created_by,
                                     unit_cost, total_cost)
    VALUES (v_oi.product_id, 'pp_produce', v_oi.qty, 'pp_production_orders', p_order_id,
            'รับเข้าจากผลิตภายใน', v_uid,
            v_pp_unit_cost, v_pp_unit_cost * v_oi.qty);

    INSERT INTO inv_stock_lots (product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id)
    VALUES (v_oi.product_id, v_oi.qty, v_oi.qty, v_pp_unit_cost,
            'pp_production_orders', p_order_id);

    PERFORM fn_recalc_product_landed_cost(v_oi.product_id);
  END LOOP;

  UPDATE pp_production_orders
  SET status      = 'approved',
      approved_by = v_uid,
      approved_at = NOW()
  WHERE id = p_order_id;
END;
$$;

-- rpc_reject_production_order: แก้ให้ใช้ auth.uid()
CREATE OR REPLACE FUNCTION rpc_reject_production_order(
  p_order_id UUID,
  p_user_id  UUID,
  p_reason   TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_role   TEXT;
  v_uid    UUID := auth.uid();
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','admin-tr') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ปฏิเสธ (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT status INTO v_status FROM pp_production_orders WHERE id = p_order_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบใบผลิต'; END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'ใบผลิตไม่อยู่ในสถานะรออนุมัติ (status: %)', v_status;
  END IF;

  UPDATE pp_production_orders
  SET status           = 'rejected',
      rejected_by      = v_uid,
      rejected_at      = NOW(),
      rejection_reason = p_reason
  WHERE id = p_order_id;
END;
$$;

-- rpc_approve_amendment: แก้ให้ใช้ auth.uid() สำหรับ role check
CREATE OR REPLACE FUNCTION rpc_approve_amendment(
  p_amendment_id UUID,
  p_approver_id  UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role      TEXT;
  v_uid       UUID := auth.uid();
  v_amendment RECORD;
  v_result    JSONB;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติ — ต้องเป็น superadmin หรือ admin เท่านั้น (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT * INTO v_amendment FROM or_order_amendments WHERE id = p_amendment_id;
  IF v_amendment.id IS NULL THEN RAISE EXCEPTION 'ไม่พบใบขอยกเลิก'; END IF;
  IF v_amendment.status <> 'pending' THEN
    RAISE EXCEPTION 'ใบขอยกเลิกนี้ไม่อยู่ในสถานะรออนุมัติ (status: %)', v_amendment.status;
  END IF;

  UPDATE or_order_amendments
  SET approved_by = v_uid, approved_at = NOW(), status = 'approved'
  WHERE id = p_amendment_id;

  v_result := rpc_execute_bill_cancellation(p_amendment_id);

  RETURN v_result;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 1: เพิ่ม Auth Check ใน RPC functions ที่ไม่มีการเช็ค role
-- ═══════════════════════════════════════════════════════════════════════════════

-- bulk_adjust_stock: เพิ่ม role check
CREATE OR REPLACE FUNCTION bulk_adjust_stock(items JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  item JSONB;
  v_product_id UUID;
  v_qty_delta NUMERIC(12,2);
  v_movement_type TEXT;
  v_ref_type TEXT;
  v_ref_id UUID;
  v_note TEXT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ปรับสต๊อค (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    v_product_id   := (item->>'product_id')::UUID;
    v_qty_delta    := (item->>'qty_delta')::NUMERIC;
    v_movement_type := item->>'movement_type';
    v_ref_type     := item->>'ref_type';
    v_ref_id       := CASE WHEN item->>'ref_id' IS NOT NULL THEN (item->>'ref_id')::UUID ELSE NULL END;
    v_note         := item->>'note';

    INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_product_id, v_qty_delta, 0, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET on_hand = inv_stock_balances.on_hand + v_qty_delta;

    INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note)
    VALUES (v_product_id, v_movement_type, v_qty_delta, v_ref_type, v_ref_id, v_note);
  END LOOP;
END;
$$;

-- bulk_update_safety_stock: เพิ่ม role check
CREATE OR REPLACE FUNCTION bulk_update_safety_stock(items JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  item JSONB;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ safety stock (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    UPDATE inv_stock_balances
    SET safety_stock = (item->>'safety_stock')::NUMERIC
    WHERE product_id = (item->>'product_id')::UUID;
  END LOOP;
END;
$$;

-- bulk_update_order_point: เพิ่ม role check
CREATE OR REPLACE FUNCTION bulk_update_order_point(items JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  item JSONB;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ order point (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    UPDATE pr_products
    SET order_point = item->>'order_point'
    WHERE id = (item->>'product_id')::UUID;
  END LOOP;
END;
$$;

-- rpc_bulk_import_products_with_stock: เพิ่ม role check
CREATE OR REPLACE FUNCTION rpc_bulk_import_products_with_stock(items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role          TEXT;
  item           JSONB;
  v_product_id   UUID;
  v_product_code TEXT;
  v_initial_stock NUMERIC;
  v_safety_stock  NUMERIC;
  v_unit_cost     NUMERIC;
  v_on_hand       NUMERIC;
  v_imported      INT := 0;
  v_skipped       INT := 0;
  v_errors        JSONB := '[]'::JSONB;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ import สินค้า (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    v_product_code := item->>'product_code';

    IF EXISTS (SELECT 1 FROM pr_products WHERE product_code = v_product_code) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_initial_stock := COALESCE((item->>'initial_stock')::NUMERIC, 0);
    v_safety_stock  := COALESCE((item->>'safety_stock')::NUMERIC, 0);
    v_unit_cost     := COALESCE((item->>'unit_cost')::NUMERIC, 0);

    IF v_safety_stock > v_initial_stock THEN
      v_safety_stock := v_initial_stock;
    END IF;

    v_on_hand := v_initial_stock - v_safety_stock;

    BEGIN
      INSERT INTO pr_products (
        product_code, product_name, product_category, product_type,
        seller_name, product_name_cn, order_point,
        rubber_code, storage_location,
        unit_cost, landed_cost, safety_stock, is_active
      )
      VALUES (
        v_product_code,
        item->>'product_name',
        NULLIF(item->>'product_category', ''),
        COALESCE(NULLIF(item->>'product_type', ''), 'FG'),
        NULLIF(item->>'seller_name', ''),
        NULLIF(item->>'product_name_cn', ''),
        NULLIF(item->>'order_point', ''),
        NULLIF(item->>'rubber_code', ''),
        NULLIF(item->>'storage_location', ''),
        v_unit_cost,
        CASE WHEN v_unit_cost > 0 THEN v_unit_cost ELSE 0 END,
        v_safety_stock,
        TRUE
      )
      RETURNING id INTO v_product_id;

      IF v_initial_stock > 0 THEN
        INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
        VALUES (v_product_id, v_on_hand, 0, v_safety_stock);

        IF v_on_hand > 0 THEN
          INSERT INTO inv_stock_lots (
            product_id, qty_initial, qty_remaining, unit_cost,
            ref_type, ref_id, is_safety_stock
          )
          VALUES (
            v_product_id, v_on_hand, v_on_hand, v_unit_cost,
            'initial_import', NULL, FALSE
          );

          INSERT INTO inv_stock_movements (
            product_id, movement_type, qty, ref_type, note,
            unit_cost, total_cost
          )
          VALUES (
            v_product_id, 'adjust', v_on_hand, 'initial_import',
            'นำเข้าสต๊อคเริ่มต้น',
            v_unit_cost, v_on_hand * v_unit_cost
          );
        END IF;

        IF v_safety_stock > 0 THEN
          INSERT INTO inv_stock_lots (
            product_id, qty_initial, qty_remaining, unit_cost,
            ref_type, ref_id, is_safety_stock
          )
          VALUES (
            v_product_id, v_safety_stock, v_safety_stock, v_unit_cost,
            'initial_import', NULL, TRUE
          );

          INSERT INTO inv_stock_movements (
            product_id, movement_type, qty, ref_type, note,
            unit_cost, total_cost
          )
          VALUES (
            v_product_id, 'adjust', v_safety_stock, 'initial_import',
            'นำเข้า safety stock เริ่มต้น',
            v_unit_cost, v_safety_stock * v_unit_cost
          );
        END IF;

        PERFORM fn_recalc_product_landed_cost(v_product_id);
      END IF;

      v_imported := v_imported + 1;

    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_object(
        'product_code', v_product_code,
        'error', SQLERRM
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'imported', v_imported,
    'skipped', v_skipped,
    'errors', v_errors
  );
END;
$$;

-- rpc_update_pr: เพิ่ม role check
CREATE OR REPLACE FUNCTION rpc_update_pr(
  p_pr_id UUID,
  p_items JSONB,
  p_note TEXT DEFAULT NULL,
  p_pr_type TEXT DEFAULT NULL,
  p_supplier_id UUID DEFAULT NULL,
  p_supplier_name TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_item JSONB;
  v_last_price NUMERIC(12,2);
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไข PR (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM inv_pr WHERE id = p_pr_id AND status = 'pending') THEN
    RAISE EXCEPTION 'PR ไม่อยู่ในสถานะรออนุมัติ ไม่สามารถแก้ไขได้';
  END IF;

  UPDATE inv_pr
  SET note = COALESCE(p_note, note),
      pr_type = COALESCE(p_pr_type, pr_type),
      supplier_id = p_supplier_id,
      supplier_name = p_supplier_name,
      updated_at = NOW()
  WHERE id = p_pr_id;

  DELETE FROM inv_pr_items WHERE pr_id = p_pr_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT last_price INTO v_last_price
    FROM v_product_last_price
    WHERE product_id = (v_item->>'product_id')::UUID;

    INSERT INTO inv_pr_items (pr_id, product_id, qty, unit, estimated_price, last_purchase_price, note)
    VALUES (
      p_pr_id,
      (v_item->>'product_id')::UUID,
      (v_item->>'qty')::NUMERIC,
      v_item->>'unit',
      (v_item->>'estimated_price')::NUMERIC,
      COALESCE(v_last_price, NULL),
      v_item->>'note'
    );
  END LOOP;
END;
$$;

-- rpc_update_po: เพิ่ม role check
CREATE OR REPLACE FUNCTION rpc_update_po(
  p_po_id UUID,
  p_note TEXT DEFAULT NULL,
  p_expected_arrival_date DATE DEFAULT NULL,
  p_items JSONB DEFAULT '[]'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_item JSONB;
  v_total NUMERIC := 0;
  v_subtotal NUMERIC;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไข PO (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM inv_po WHERE id = p_po_id AND status = 'open') THEN
    RAISE EXCEPTION 'PO ไม่อยู่ในสถานะเปิด ไม่สามารถแก้ไขได้';
  END IF;

  UPDATE inv_po
  SET note = p_note,
      expected_arrival_date = p_expected_arrival_date,
      updated_at = NOW()
  WHERE id = p_po_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_subtotal := COALESCE((v_item->>'unit_price')::NUMERIC, 0) * COALESCE((v_item->>'qty')::NUMERIC, 0);
    v_total := v_total + v_subtotal;

    UPDATE inv_po_items
    SET unit_price = (v_item->>'unit_price')::NUMERIC,
        qty = COALESCE((v_item->>'qty')::NUMERIC, qty),
        note = v_item->>'note',
        subtotal = v_subtotal
    WHERE id = (v_item->>'item_id')::UUID AND po_id = p_po_id;
  END LOOP;

  UPDATE inv_po SET total_amount = v_total WHERE id = p_po_id;

  RETURN jsonb_build_object('total_amount', v_total);
END;
$$;

-- rpc_save_bill_edit_with_revision: เพิ่ม role check
CREATE OR REPLACE FUNCTION rpc_save_bill_edit_with_revision(
  p_order_id     UUID,
  p_order_data   JSONB,
  p_items        JSONB,
  p_user_name    TEXT,
  p_edit_changes JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role          TEXT;
  v_order         RECORD;
  v_snapshot_order JSONB;
  v_snapshot_items JSONB;
  v_new_rev       INT;
  v_bill_no       TEXT;
  v_item          JSONB;
  v_idx           INT := 0;
  v_item_uid      TEXT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'admin-pump', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขบิล (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT * INTO v_order FROM or_orders WHERE id = p_order_id;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'ไม่พบออเดอร์'; END IF;

  SELECT row_to_json(o)::jsonb INTO v_snapshot_order
  FROM or_orders o WHERE o.id = p_order_id;

  SELECT COALESCE(jsonb_agg(row_to_json(oi)::jsonb), '[]'::jsonb)
  INTO v_snapshot_items
  FROM or_order_items oi WHERE oi.order_id = p_order_id;

  UPDATE or_orders SET
    customer_name    = COALESCE(p_order_data->>'customer_name', customer_name),
    customer_address = COALESCE(p_order_data->>'customer_address', customer_address),
    channel_code     = COALESCE(p_order_data->>'channel_code', channel_code),
    total_amount     = COALESCE((p_order_data->>'total_amount')::numeric, total_amount),
    price            = COALESCE((p_order_data->>'price')::numeric, price),
    shipping_cost    = COALESCE((p_order_data->>'shipping_cost')::numeric, shipping_cost),
    discount         = COALESCE((p_order_data->>'discount')::numeric, discount),
    payment_method   = COALESCE(p_order_data->>'payment_method', payment_method),
    payment_date     = COALESCE(p_order_data->>'payment_date', payment_date),
    payment_time     = COALESCE(p_order_data->>'payment_time', payment_time),
    promotion        = COALESCE(p_order_data->>'promotion', promotion),
    tracking_number  = COALESCE(p_order_data->>'tracking_number', tracking_number),
    recipient_name   = COALESCE(p_order_data->>'recipient_name', recipient_name),
    channel_order_no = COALESCE(p_order_data->>'channel_order_no', channel_order_no),
    confirm_note     = COALESCE(p_order_data->>'confirm_note', confirm_note),
    status           = COALESCE(p_order_data->>'status', status),
    billing_details  = CASE
      WHEN p_order_data ? 'billing_details' THEN (p_order_data->'billing_details')
      ELSE billing_details
    END,
    updated_at       = NOW()
  WHERE id = p_order_id;

  v_bill_no := COALESCE(v_order.bill_no, '');

  IF p_items IS NOT NULL AND jsonb_array_length(p_items) > 0 THEN
    DELETE FROM or_order_items WHERE order_id = p_order_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_idx := v_idx + 1;
      v_item_uid := CASE WHEN v_bill_no <> '' THEN v_bill_no || '-' || v_idx
                         ELSE 'EDIT-' || v_idx END;

      INSERT INTO or_order_items (
        order_id, item_uid, product_id, product_name, quantity,
        unit_price, ink_color, product_type, cartoon_pattern,
        line_pattern, font, line_1, line_2, line_3,
        no_name_line, is_free, notes, file_attachment
      ) VALUES (
        p_order_id,
        v_item_uid,
        CASE WHEN v_item->>'product_id' IS NOT NULL AND v_item->>'product_id' <> ''
             THEN (v_item->>'product_id')::uuid ELSE NULL END,
        COALESCE(v_item->>'product_name', ''),
        COALESCE((v_item->>'quantity')::int, 1),
        COALESCE((v_item->>'unit_price')::numeric, 0),
        v_item->>'ink_color',
        COALESCE(v_item->>'product_type', 'ชั้น1'),
        v_item->>'cartoon_pattern',
        v_item->>'line_pattern',
        v_item->>'font',
        v_item->>'line_1',
        v_item->>'line_2',
        v_item->>'line_3',
        COALESCE((v_item->>'no_name_line')::boolean, false),
        COALESCE((v_item->>'is_free')::boolean, false),
        v_item->>'notes',
        v_item->>'file_attachment'
      );
    END LOOP;
  END IF;

  v_new_rev := COALESCE(v_order.revision_no, 0) + 1;

  INSERT INTO or_order_revisions (
    order_id, revision_no, change_source, change_source_id,
    snapshot_order, snapshot_items, created_by
  ) VALUES (
    p_order_id, v_new_rev, 'direct_edit', NULL,
    v_snapshot_order, v_snapshot_items, p_user_name
  );

  UPDATE or_orders SET revision_no = v_new_rev WHERE id = p_order_id;

  INSERT INTO ac_bill_edit_logs (
    order_id, bill_no, edited_by,
    changes, items_snapshot_before, items_snapshot_after
  ) VALUES (
    p_order_id, v_bill_no, p_user_name,
    p_edit_changes, v_snapshot_items,
    (SELECT COALESCE(jsonb_agg(row_to_json(oi)::jsonb), '[]'::jsonb)
     FROM or_order_items oi WHERE oi.order_id = p_order_id)
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

-- rpc_execute_bill_cancellation: เพิ่ม role check
CREATE OR REPLACE FUNCTION rpc_execute_bill_cancellation(p_amendment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role         TEXT;
  v_amendment    RECORD;
  v_order        RECORD;
  v_wms          RECORD;
  v_cancelled_wms INT := 0;
  v_snapshot_order JSONB;
  v_new_rev      INT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยกเลิกบิล (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT * INTO v_amendment FROM or_order_amendments WHERE id = p_amendment_id;
  IF v_amendment.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขอยกเลิก'; END IF;

  SELECT * INTO v_order FROM or_orders WHERE id = v_amendment.order_id;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'ไม่พบออเดอร์'; END IF;

  SELECT row_to_json(o)::jsonb INTO v_snapshot_order
  FROM or_orders o WHERE o.id = v_amendment.order_id;

  IF v_order.work_order_name IS NOT NULL AND v_order.work_order_name <> '' THEN
    FOR v_wms IN
      SELECT id, assigned_to
      FROM wms_orders
      WHERE order_id = v_order.work_order_name
        AND status NOT IN ('cancelled')
    LOOP
      UPDATE wms_orders SET status = 'cancelled' WHERE id = v_wms.id;
      v_cancelled_wms := v_cancelled_wms + 1;

      IF v_wms.assigned_to IS NOT NULL THEN
        INSERT INTO wms_notifications (type, order_id, picker_id, status, is_read)
        VALUES ('ยกเลิกบิล', v_order.work_order_name, v_wms.assigned_to, 'unread', false);
      END IF;
    END LOOP;
  END IF;

  UPDATE or_orders
  SET status = 'ยกเลิก', updated_at = NOW()
  WHERE id = v_amendment.order_id;

  v_new_rev := COALESCE(v_order.revision_no, 0) + 1;

  INSERT INTO or_order_revisions (
    order_id, revision_no, change_source, change_source_id,
    snapshot_order, snapshot_items, created_by
  ) VALUES (
    v_amendment.order_id, v_new_rev, 'amendment', p_amendment_id,
    v_snapshot_order,
    (SELECT COALESCE(jsonb_agg(row_to_json(oi)::jsonb), '[]'::jsonb)
     FROM or_order_items oi WHERE oi.order_id = v_amendment.order_id),
    (SELECT COALESCE(username, email) FROM us_users WHERE id = v_amendment.approved_by)
  );

  UPDATE or_orders SET revision_no = v_new_rev WHERE id = v_amendment.order_id;

  UPDATE or_order_amendments
  SET status = 'executed', executed_at = NOW()
  WHERE id = p_amendment_id;

  RETURN jsonb_build_object(
    'success', true,
    'amendment_no', v_amendment.amendment_no,
    'bill_no', v_order.bill_no,
    'cancelled_wms_count', v_cancelled_wms,
    'revision_no', v_new_rev
  );
END;
$$;

-- rpc_update_sample_test: เพิ่ม role check + ใช้ auth.uid()
CREATE OR REPLACE FUNCTION rpc_update_sample_test(
  p_sample_id UUID,
  p_status TEXT,
  p_user_id UUID DEFAULT NULL,
  p_test_note TEXT DEFAULT NULL,
  p_rejection_reason TEXT DEFAULT NULL,
  p_item_results JSONB DEFAULT '[]'::JSONB
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_uid  UUID := auth.uid();
  v_item JSONB;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ทดสอบ Sample (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  IF p_status NOT IN ('testing', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'สถานะไม่ถูกต้อง: %', p_status;
  END IF;

  UPDATE inv_samples
  SET status = p_status,
      tested_by = CASE WHEN p_status IN ('approved', 'rejected') THEN v_uid ELSE tested_by END,
      tested_at = CASE WHEN p_status IN ('approved', 'rejected') THEN NOW() ELSE tested_at END,
      test_result = CASE WHEN p_status = 'approved' THEN 'passed' WHEN p_status = 'rejected' THEN 'failed' ELSE test_result END,
      test_note = COALESCE(p_test_note, test_note),
      rejection_reason = CASE WHEN p_status = 'rejected' THEN p_rejection_reason ELSE rejection_reason END
  WHERE id = p_sample_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบ Sample'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_item_results)
  LOOP
    UPDATE inv_sample_items
    SET item_test_result = v_item->>'result',
        item_test_note = v_item->>'note'
    WHERE id = (v_item->>'item_id')::UUID AND sample_id = p_sample_id;
  END LOOP;
END;
$$;

-- rpc_convert_sample_to_product: เพิ่ม role check + ใช้ auth.uid()
CREATE OR REPLACE FUNCTION rpc_convert_sample_to_product(
  p_sample_id UUID,
  p_item_id UUID,
  p_product_code TEXT,
  p_product_name TEXT,
  p_product_name_cn TEXT DEFAULT NULL,
  p_product_type TEXT DEFAULT 'FG',
  p_product_category TEXT DEFAULT NULL,
  p_seller_name TEXT DEFAULT NULL,
  p_unit_cost NUMERIC DEFAULT NULL,
  p_user_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_product_id UUID;
  v_all_converted BOOLEAN;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แปลง Sample เป็นสินค้า (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  INSERT INTO pr_products (product_code, product_name, product_name_cn, product_type, product_category, seller_name, unit_cost, is_active)
  VALUES (p_product_code, p_product_name, p_product_name_cn, p_product_type, p_product_category, p_seller_name, p_unit_cost, true)
  RETURNING id INTO v_product_id;

  UPDATE inv_sample_items
  SET converted_product_id = v_product_id
  WHERE id = p_item_id AND sample_id = p_sample_id;

  SELECT bool_and(converted_product_id IS NOT NULL)
  INTO v_all_converted
  FROM inv_sample_items
  WHERE sample_id = p_sample_id;

  IF v_all_converted THEN
    UPDATE inv_samples SET status = 'converted' WHERE id = p_sample_id;
  END IF;

  RETURN v_product_id;
END;
$$;

-- batch_upsert_attendance: เพิ่ม role check (HR admin only)
-- อ่านจาก 114 แล้วเพิ่ม auth check ที่ต้น function
DO $$
BEGIN
  EXECUTE '
    CREATE OR REPLACE FUNCTION batch_upsert_attendance(
      p_upload JSONB, p_summaries JSONB, p_dailies JSONB
    ) RETURNS UUID AS $fn$
    DECLARE
      v_role TEXT;
      v_upload_id UUID;
      v_summary JSONB;
      v_daily JSONB;
      v_employee_id UUID;
    BEGIN
      SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
      IF v_role IS NULL OR v_role NOT IN (''superadmin'', ''admin'', ''admin-tr'', ''hr'') THEN
        RAISE EXCEPTION ''ไม่มีสิทธิ์อัปโหลดข้อมูลเข้างาน (role: %)'', COALESCE(v_role, ''unknown'');
      END IF;

      INSERT INTO hr_attendance_uploads (
        file_name, upload_date, period_start, period_end,
        total_employees, source, uploaded_by
      )
      VALUES (
        p_upload->>''file_name'',
        COALESCE((p_upload->>''upload_date'')::DATE, CURRENT_DATE),
        (p_upload->>''period_start'')::DATE,
        (p_upload->>''period_end'')::DATE,
        COALESCE((p_upload->>''total_employees'')::INT, 0),
        COALESCE(p_upload->>''source'', ''manual''),
        CASE WHEN p_upload->>''uploaded_by'' IS NOT NULL
             THEN (p_upload->>''uploaded_by'')::UUID ELSE auth.uid() END
      )
      RETURNING id INTO v_upload_id;

      FOR v_summary IN SELECT * FROM jsonb_array_elements(p_summaries)
      LOOP
        v_employee_id := (v_summary->>''employee_id'')::UUID;

        INSERT INTO hr_attendance_summary (
          upload_id, employee_id, total_days, present_days, absent_days,
          late_days, leave_days, ot_hours, period_start, period_end
        )
        VALUES (
          v_upload_id, v_employee_id,
          COALESCE((v_summary->>''total_days'')::INT, 0),
          COALESCE((v_summary->>''present_days'')::INT, 0),
          COALESCE((v_summary->>''absent_days'')::INT, 0),
          COALESCE((v_summary->>''late_days'')::INT, 0),
          COALESCE((v_summary->>''leave_days'')::INT, 0),
          COALESCE((v_summary->>''ot_hours'')::NUMERIC, 0),
          (v_summary->>''period_start'')::DATE,
          (v_summary->>''period_end'')::DATE
        )
        ON CONFLICT (upload_id, employee_id) DO UPDATE SET
          total_days   = EXCLUDED.total_days,
          present_days = EXCLUDED.present_days,
          absent_days  = EXCLUDED.absent_days,
          late_days    = EXCLUDED.late_days,
          leave_days   = EXCLUDED.leave_days,
          ot_hours     = EXCLUDED.ot_hours,
          period_start = EXCLUDED.period_start,
          period_end   = EXCLUDED.period_end;
      END LOOP;

      FOR v_daily IN SELECT * FROM jsonb_array_elements(p_dailies)
      LOOP
        v_employee_id := (v_daily->>''employee_id'')::UUID;

        INSERT INTO hr_attendance_daily (
          upload_id, employee_id, work_date, check_in, check_out,
          status, ot_hours, note
        )
        VALUES (
          v_upload_id, v_employee_id,
          (v_daily->>''work_date'')::DATE,
          CASE WHEN v_daily->>''check_in'' IS NOT NULL
               THEN (v_daily->>''check_in'')::TIMESTAMPTZ ELSE NULL END,
          CASE WHEN v_daily->>''check_out'' IS NOT NULL
               THEN (v_daily->>''check_out'')::TIMESTAMPTZ ELSE NULL END,
          COALESCE(v_daily->>''status'', ''present''),
          COALESCE((v_daily->>''ot_hours'')::NUMERIC, 0),
          v_daily->>''note''
        )
        ON CONFLICT (employee_id, work_date) DO UPDATE SET
          upload_id = EXCLUDED.upload_id,
          check_in  = EXCLUDED.check_in,
          check_out = EXCLUDED.check_out,
          status    = EXCLUDED.status,
          ot_hours  = EXCLUDED.ot_hours,
          note      = EXCLUDED.note;
      END LOOP;

      RETURN v_upload_id;
    END;
    $fn$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
  ';
END;
$$;

-- rpc_record_cancellation_waste: เพิ่ม role check + ใช้ auth.uid()
CREATE OR REPLACE FUNCTION rpc_record_cancellation_waste(
  p_wms_order_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role        TEXT;
  v_uid         UUID := auth.uid();
  v_movement    RECORD;
  v_product_id  UUID;
  v_qty         NUMERIC;
  v_avg_cost    NUMERIC;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์บันทึกของเสีย (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT sm.id, sm.product_id, ABS(sm.qty) AS qty, sm.unit_cost
  INTO v_movement
  FROM inv_stock_movements sm
  WHERE sm.ref_type = 'wms_orders'
    AND sm.ref_id = p_wms_order_id
    AND sm.movement_type = 'pick'
  ORDER BY sm.created_at DESC
  LIMIT 1;

  IF v_movement.id IS NULL THEN
    UPDATE wms_orders SET stock_action = 'waste' WHERE id = p_wms_order_id;
    RETURN jsonb_build_object('success', true, 'note', 'ไม่มี pick movement — mark เป็นของเสียเท่านั้น');
  END IF;

  v_product_id := v_movement.product_id;
  v_qty := v_movement.qty;
  v_avg_cost := COALESCE(v_movement.unit_cost, 0);

  INSERT INTO inv_stock_movements (
    product_id, movement_type, qty, ref_type, ref_id, note,
    unit_cost, total_cost, created_by
  ) VALUES (
    v_product_id, 'waste', 0,
    'wms_orders', p_wms_order_id,
    'ของเสียจากบิลที่ยกเลิก (สต๊อกตัดไปแล้ว)',
    v_avg_cost, 0,
    v_uid
  );

  UPDATE wms_orders SET stock_action = 'waste' WHERE id = p_wms_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'product_id', v_product_id,
    'qty', v_qty,
    'action', 'waste'
  );
END;
$$;

-- rpc_create_production_order: เพิ่ม role check + ใช้ auth.uid()
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
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'store', 'production') THEN
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

-- rpc_submit_production_order: เพิ่ม role check
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
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'store', 'production') THEN
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

-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 2: Helper Functions กลาง + Composite Index
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_us_users_id_role ON us_users(id, role);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 3: แก้ RLS policies ที่หลวมเกินไป
-- ═══════════════════════════════════════════════════════════════════════════════

-- plan_settings: จำกัด write ให้เฉพาะ role ที่เกี่ยวข้อง
DROP POLICY IF EXISTS "Authenticated users can insert plan_settings" ON plan_settings;
DROP POLICY IF EXISTS "Authenticated users can update plan_settings" ON plan_settings;
DROP POLICY IF EXISTS "plan_settings_write" ON plan_settings;

CREATE POLICY "plan_settings_write"
  ON plan_settings FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump', 'production'))
  );

-- plan_jobs: จำกัด write + delete
DROP POLICY IF EXISTS "Authenticated users can insert plan_jobs" ON plan_jobs;
DROP POLICY IF EXISTS "Authenticated users can update plan_jobs" ON plan_jobs;
DROP POLICY IF EXISTS "Authenticated users can delete plan_jobs" ON plan_jobs;
DROP POLICY IF EXISTS "plan_jobs_write" ON plan_jobs;

CREATE POLICY "plan_jobs_write"
  ON plan_jobs FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump', 'production'))
  );

-- qc_skip_logs: จำกัด write
DROP POLICY IF EXISTS "Allow all for authenticated" ON qc_skip_logs;
DROP POLICY IF EXISTS "qc_skip_logs_select" ON qc_skip_logs;
DROP POLICY IF EXISTS "qc_skip_logs_write" ON qc_skip_logs;

CREATE POLICY "qc_skip_logs_select"
  ON qc_skip_logs FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "qc_skip_logs_write"
  ON qc_skip_logs FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin_qc', 'qc_staff'))
  );

-- roll_material_categories: จำกัด write
DROP POLICY IF EXISTS "rmc_insert" ON roll_material_categories;
DROP POLICY IF EXISTS "rmc_update" ON roll_material_categories;
DROP POLICY IF EXISTS "rmc_delete" ON roll_material_categories;
DROP POLICY IF EXISTS "rmc_write" ON roll_material_categories;

CREATE POLICY "rmc_write"
  ON roll_material_categories FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'production'))
  );

-- roll_material_configs: จำกัด write
DROP POLICY IF EXISTS "rmcfg_insert" ON roll_material_configs;
DROP POLICY IF EXISTS "rmcfg_update" ON roll_material_configs;
DROP POLICY IF EXISTS "rmcfg_delete" ON roll_material_configs;
DROP POLICY IF EXISTS "rmcfg_write" ON roll_material_configs;

CREATE POLICY "rmcfg_write"
  ON roll_material_configs FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'production'))
  );

-- roll_usage_logs: จำกัด write
DROP POLICY IF EXISTS "rul_insert" ON roll_usage_logs;
DROP POLICY IF EXISTS "rul_delete" ON roll_usage_logs;
DROP POLICY IF EXISTS "rul_write" ON roll_usage_logs;

CREATE POLICY "rul_write"
  ON roll_usage_logs FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'production'))
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 3-B: เพิ่ม SET search_path ให้ helper functions ที่สำคัญ
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hr_is_admin() RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM us_users
    WHERE id = auth.uid()
      AND role IN ('superadmin','admin','admin-tr','hr')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public;

CREATE OR REPLACE FUNCTION hr_my_employee_id() RETURNS UUID AS $$
  SELECT id FROM hr_employees WHERE user_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public;

CREATE OR REPLACE FUNCTION check_user_role(user_id UUID, allowed_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_role TEXT;
BEGIN
  SELECT role INTO user_role
  FROM us_users
  WHERE id = user_id;

  RETURN user_role = ANY(allowed_roles);
END;
$$;

COMMIT;
