-- ============================================================
-- Migration 108: Internal Production (Processed Products - PP)
-- ============================================================
-- สร้างระบบผลิตภายใน (แปรรูปสินค้า PP)
-- - เพิ่ม PP ใน product_type
-- - ตาราง recipe (BOM): pp_recipes, pp_recipe_includes, pp_recipe_removes
-- - ตารางใบผลิต: pp_production_orders, pp_production_order_items
-- - RPC functions สำหรับสร้าง/ส่งอนุมัติ/อนุมัติ/ปฏิเสธ
-- - fn_calc_pp_producible_qty คำนวณจำนวนที่ผลิตได้
-- ============================================================

BEGIN;

-- ═══════════════════════════════════════════
-- 1. เพิ่ม PP ใน product_type constraint
-- ═══════════════════════════════════════════

ALTER TABLE pr_products DROP CONSTRAINT IF EXISTS chk_product_type;
ALTER TABLE pr_products ADD CONSTRAINT chk_product_type
  CHECK (product_type IN ('FG', 'RM', 'PP'));

-- ═══════════════════════════════════════════
-- 2. ตาราง Recipe (BOM สินค้าแปรรูป)
-- ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pp_recipes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id  UUID NOT NULL REFERENCES pr_products(id),
  created_by  UUID REFERENCES us_users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_pp_recipe_product UNIQUE (product_id)
);

CREATE TABLE IF NOT EXISTS pp_recipe_includes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipe_id   UUID NOT NULL REFERENCES pp_recipes(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES pr_products(id),
  qty         NUMERIC(12,2) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pp_recipe_removes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipe_id   UUID NOT NULL REFERENCES pp_recipes(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES pr_products(id),
  qty         NUMERIC(12,2) NOT NULL,
  unit_cost   NUMERIC(14,4) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pp_recipe_includes_recipe ON pp_recipe_includes(recipe_id);
CREATE INDEX IF NOT EXISTS idx_pp_recipe_removes_recipe ON pp_recipe_removes(recipe_id);

-- ═══════════════════════════════════════════
-- 3. ตารางใบผลิตภายใน (Production Orders)
-- ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pp_production_orders (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  doc_no           TEXT UNIQUE NOT NULL,
  title            TEXT,
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','pending','approved','rejected')),
  note             TEXT,
  created_by       UUID REFERENCES us_users(id),
  approved_by      UUID REFERENCES us_users(id),
  approved_at      TIMESTAMPTZ,
  rejected_by      UUID REFERENCES us_users(id),
  rejected_at      TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pp_production_order_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID NOT NULL REFERENCES pp_production_orders(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES pr_products(id),
  qty         NUMERIC(12,2) NOT NULL,
  unit_cost   NUMERIC(14,4),
  total_cost  NUMERIC(14,2),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pp_order_items_order ON pp_production_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_pp_orders_status ON pp_production_orders(status);

-- ═══════════════════════════════════════════
-- 4. เลขที่เอกสาร PP sequential (daily reset)
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_generate_pp_doc_no()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_today TEXT;
  v_seq   INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pp_doc_no_gen'));

  v_today := to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD');

  SELECT COALESCE(MAX(CAST(SPLIT_PART(doc_no, '-', 3) AS INTEGER)), 0) + 1
  INTO v_seq
  FROM pp_production_orders
  WHERE doc_no LIKE 'PP-' || v_today || '-___';

  RETURN 'PP-' || v_today || '-' || lpad(v_seq::text, 3, '0');
END;
$$;

-- ═══════════════════════════════════════════
-- 5. RPC: สร้างใบผลิตภายใน
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_create_production_order(
  p_title   TEXT,
  p_note    TEXT,
  p_items   JSONB,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order_id UUID;
  v_doc_no   TEXT;
  v_item     JSONB;
BEGIN
  v_doc_no := rpc_generate_pp_doc_no();

  INSERT INTO pp_production_orders (doc_no, title, status, note, created_by)
  VALUES (v_doc_no, p_title, 'open', p_note, p_user_id)
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

-- ═══════════════════════════════════════════
-- 6. RPC: ส่งอนุมัติ (open → pending)
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_submit_production_order(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM pp_production_orders WHERE id = p_order_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบใบผลิต'; END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'ใบผลิตไม่อยู่ในสถานะเปิด (status: %)', v_status;
  END IF;

  UPDATE pp_production_orders SET status = 'pending' WHERE id = p_order_id;
END;
$$;

-- ═══════════════════════════════════════════
-- 7. RPC: อนุมัติใบผลิต + ทำ stock changes
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_approve_production_order(
  p_order_id UUID,
  p_user_id  UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_status          TEXT;
  v_role            TEXT;
  v_oi              RECORD;
  v_recipe_id       UUID;
  v_inc             RECORD;
  v_rem             RECORD;
  v_movement_id     UUID;
  v_include_cost    NUMERIC;
  v_remove_cost     NUMERIC;
  v_pp_unit_cost    NUMERIC;
  v_on_hand         NUMERIC;
  v_needed          NUMERIC;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = p_user_id;
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin') THEN
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

    -- === Include items: ตัดสต๊อค FIFO ===
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
              'ตัดสต๊อคสำหรับผลิตภายใน', p_user_id)
      RETURNING id INTO v_movement_id;

      v_include_cost := v_include_cost + fn_consume_stock_fifo(v_inc.product_id, v_needed, v_movement_id);
      PERFORM fn_recalc_product_landed_cost(v_inc.product_id);
    END LOOP;

    -- === Remove items: รับเข้าสต๊อค ===
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
              'รับเข้าจากแยกสินค้าแปรรูป', p_user_id,
              v_rem.unit_cost, v_rem.qty * v_oi.qty * v_rem.unit_cost);

      INSERT INTO inv_stock_lots (product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id)
      VALUES (v_rem.product_id, v_rem.qty * v_oi.qty, v_rem.qty * v_oi.qty, v_rem.unit_cost,
              'pp_production_orders', p_order_id);

      PERFORM fn_recalc_product_landed_cost(v_rem.product_id);
    END LOOP;

    -- === PP product: รับเข้าสต๊อค ===
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
            'รับเข้าจากผลิตภายใน', p_user_id,
            v_pp_unit_cost, v_pp_unit_cost * v_oi.qty);

    INSERT INTO inv_stock_lots (product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id)
    VALUES (v_oi.product_id, v_oi.qty, v_oi.qty, v_pp_unit_cost,
            'pp_production_orders', p_order_id);

    PERFORM fn_recalc_product_landed_cost(v_oi.product_id);
  END LOOP;

  UPDATE pp_production_orders
  SET status      = 'approved',
      approved_by = p_user_id,
      approved_at = NOW()
  WHERE id = p_order_id;
END;
$$;

-- ═══════════════════════════════════════════
-- 8. RPC: ปฏิเสธใบผลิต
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION rpc_reject_production_order(
  p_order_id UUID,
  p_user_id  UUID,
  p_reason   TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_status TEXT;
  v_role   TEXT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = p_user_id;
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ปฏิเสธ (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT status INTO v_status FROM pp_production_orders WHERE id = p_order_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบใบผลิต'; END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'ใบผลิตไม่อยู่ในสถานะรออนุมัติ (status: %)', v_status;
  END IF;

  UPDATE pp_production_orders
  SET status           = 'rejected',
      rejected_by      = p_user_id,
      rejected_at      = NOW(),
      rejection_reason = p_reason
  WHERE id = p_order_id;
END;
$$;

-- ═══════════════════════════════════════════
-- 9. fn_calc_pp_producible_qty
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_calc_pp_producible_qty(p_product_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_recipe_id UUID;
  v_min_qty   NUMERIC := NULL;
  v_inc       RECORD;
  v_on_hand   NUMERIC;
  v_possible  NUMERIC;
BEGIN
  SELECT id INTO v_recipe_id FROM pp_recipes WHERE product_id = p_product_id;
  IF v_recipe_id IS NULL THEN RETURN 0; END IF;

  FOR v_inc IN
    SELECT ri.product_id, ri.qty
    FROM pp_recipe_includes ri
    WHERE ri.recipe_id = v_recipe_id AND ri.qty > 0
  LOOP
    SELECT COALESCE(sb.on_hand, 0) INTO v_on_hand
    FROM inv_stock_balances sb
    WHERE sb.product_id = v_inc.product_id;

    v_on_hand := COALESCE(v_on_hand, 0);
    v_possible := FLOOR(v_on_hand / v_inc.qty);

    IF v_min_qty IS NULL OR v_possible < v_min_qty THEN
      v_min_qty := v_possible;
    END IF;
  END LOOP;

  RETURN COALESCE(v_min_qty, 0);
END;
$$;

-- ═══════════════════════════════════════════
-- 10. RLS Policies
-- ═══════════════════════════════════════════

ALTER TABLE pp_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pp_recipe_includes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pp_recipe_removes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pp_production_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE pp_production_order_items ENABLE ROW LEVEL SECURITY;

-- pp_recipes
CREATE POLICY "pp_recipes read" ON pp_recipes FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store')
  ));
CREATE POLICY "pp_recipes write" ON pp_recipes FOR ALL
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store')
  ));

-- pp_recipe_includes
CREATE POLICY "pp_recipe_includes read" ON pp_recipe_includes FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store')
  ));
CREATE POLICY "pp_recipe_includes write" ON pp_recipe_includes FOR ALL
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store')
  ));

-- pp_recipe_removes
CREATE POLICY "pp_recipe_removes read" ON pp_recipe_removes FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store')
  ));
CREATE POLICY "pp_recipe_removes write" ON pp_recipe_removes FOR ALL
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store')
  ));

-- pp_production_orders
CREATE POLICY "pp_production_orders read" ON pp_production_orders FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store')
  ));
CREATE POLICY "pp_production_orders write" ON pp_production_orders FOR ALL
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store')
  ));

-- pp_production_order_items
CREATE POLICY "pp_production_order_items read" ON pp_production_order_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store')
  ));
CREATE POLICY "pp_production_order_items write" ON pp_production_order_items FOR ALL
  USING (EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store')
  ));

COMMIT;
