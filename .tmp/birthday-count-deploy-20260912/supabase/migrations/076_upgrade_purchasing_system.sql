-- ============================================
-- 076: Upgrade Purchasing System (PR / PO / GR / Sample)
-- ============================================

-- 1.1 ขยายตาราง inv_pr  (เพิ่มฟิลด์ปฏิเสธ)
ALTER TABLE inv_pr ADD COLUMN IF NOT EXISTS rejected_by UUID;
ALTER TABLE inv_pr ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE inv_pr ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- 1.2 ขยายตาราง inv_pr_items
ALTER TABLE inv_pr_items ADD COLUMN IF NOT EXISTS last_purchase_price NUMERIC(12,2);
ALTER TABLE inv_pr_items ADD COLUMN IF NOT EXISTS estimated_price NUMERIC(12,2);
ALTER TABLE inv_pr_items ADD COLUMN IF NOT EXISTS unit TEXT;

-- 1.3 ขยายตาราง inv_po (supplier + ค่าขนส่งต่างประเทศ)
ALTER TABLE inv_po ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES pr_sellers(id);
ALTER TABLE inv_po ADD COLUMN IF NOT EXISTS supplier_name TEXT;
ALTER TABLE inv_po ADD COLUMN IF NOT EXISTS intl_shipping_method TEXT;
ALTER TABLE inv_po ADD COLUMN IF NOT EXISTS intl_shipping_weight NUMERIC(12,3);
ALTER TABLE inv_po ADD COLUMN IF NOT EXISTS intl_shipping_cbm NUMERIC(12,4);
ALTER TABLE inv_po ADD COLUMN IF NOT EXISTS intl_shipping_cost NUMERIC(14,2);
ALTER TABLE inv_po ADD COLUMN IF NOT EXISTS intl_shipping_currency TEXT DEFAULT 'CNY';
ALTER TABLE inv_po ADD COLUMN IF NOT EXISTS intl_exchange_rate NUMERIC(12,4);
ALTER TABLE inv_po ADD COLUMN IF NOT EXISTS intl_shipping_cost_thb NUMERIC(14,2);
ALTER TABLE inv_po ADD COLUMN IF NOT EXISTS total_amount NUMERIC(14,2);
ALTER TABLE inv_po ADD COLUMN IF NOT EXISTS grand_total NUMERIC(14,2);

-- 1.4 ขยายตาราง inv_po_items
ALTER TABLE inv_po_items ADD COLUMN IF NOT EXISTS subtotal NUMERIC(14,2);
ALTER TABLE inv_po_items ADD COLUMN IF NOT EXISTS unit TEXT;

-- 1.5 ขยายตาราง inv_gr (ค่าขนส่งในประเทศ)
ALTER TABLE inv_gr ADD COLUMN IF NOT EXISTS dom_shipping_company TEXT;
ALTER TABLE inv_gr ADD COLUMN IF NOT EXISTS dom_shipping_cost NUMERIC(14,2);
ALTER TABLE inv_gr ADD COLUMN IF NOT EXISTS dom_cost_per_piece NUMERIC(12,4);
ALTER TABLE inv_gr ADD COLUMN IF NOT EXISTS shortage_note TEXT;

-- 1.6 ขยายตาราง inv_gr_items
ALTER TABLE inv_gr_items ADD COLUMN IF NOT EXISTS qty_ordered NUMERIC(12,2);
ALTER TABLE inv_gr_items ADD COLUMN IF NOT EXISTS qty_shortage NUMERIC(12,2);
ALTER TABLE inv_gr_items ADD COLUMN IF NOT EXISTS shortage_note TEXT;

-- ============================================
-- 1.7 ตารางใหม่: inv_samples
-- ============================================
CREATE TABLE IF NOT EXISTS inv_samples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_no TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'received',
  received_by UUID,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  supplier_name TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 1.8 ตารางใหม่: inv_sample_items
CREATE TABLE IF NOT EXISTS inv_sample_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id UUID NOT NULL REFERENCES inv_samples(id) ON DELETE CASCADE,
  product_id UUID REFERENCES pr_products(id),
  product_name_manual TEXT,
  qty NUMERIC(12,2) NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE inv_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_sample_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can view samples"
  ON inv_samples FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Purchase roles can manage samples"
  ON inv_samples FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'account')
    )
  );

CREATE POLICY "Anyone authenticated can view sample items"
  ON inv_sample_items FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Purchase roles can manage sample items"
  ON inv_sample_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store', 'account')
    )
  );

DROP TRIGGER IF EXISTS update_inv_samples_updated_at ON inv_samples;
CREATE TRIGGER update_inv_samples_updated_at
  BEFORE UPDATE ON inv_samples
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 1.9  อัปเดต RLS: เพิ่ม account ให้จัดการ PR/PO/GR ได้
-- ============================================
DROP POLICY IF EXISTS "Admins can manage PR" ON inv_pr;
CREATE POLICY "Purchase roles can manage PR"
  ON inv_pr FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'admin-tr', 'store', 'account', 'manager')
    )
  );

DROP POLICY IF EXISTS "Admins can manage PR items" ON inv_pr_items;
CREATE POLICY "Purchase roles can manage PR items"
  ON inv_pr_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'admin-tr', 'store', 'account', 'manager')
    )
  );

DROP POLICY IF EXISTS "Admins can manage PO" ON inv_po;
CREATE POLICY "Purchase roles can manage PO"
  ON inv_po FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'admin-tr', 'store', 'account', 'manager')
    )
  );

DROP POLICY IF EXISTS "Admins can manage PO items" ON inv_po_items;
CREATE POLICY "Purchase roles can manage PO items"
  ON inv_po_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'admin-tr', 'store', 'account', 'manager')
    )
  );

DROP POLICY IF EXISTS "Admins can manage GR" ON inv_gr;
CREATE POLICY "Purchase roles can manage GR"
  ON inv_gr FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'admin-tr', 'store', 'account', 'manager')
    )
  );

DROP POLICY IF EXISTS "Admins can manage GR items" ON inv_gr_items;
CREATE POLICY "Purchase roles can manage GR items"
  ON inv_gr_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'admin-tr', 'store', 'account', 'manager')
    )
  );

-- ============================================
-- 1.10 Database View: v_product_last_price
-- ============================================
CREATE OR REPLACE VIEW v_product_last_price AS
SELECT DISTINCT ON (poi.product_id)
  poi.product_id,
  poi.unit_price AS last_price,
  po.ordered_at AS last_ordered_at
FROM inv_po_items poi
JOIN inv_po po ON po.id = poi.po_id
WHERE po.status IN ('ordered', 'received', 'partial')
  AND poi.unit_price IS NOT NULL
ORDER BY poi.product_id, po.ordered_at DESC;

-- ============================================
-- 1.11 RPC: rpc_create_pr
-- ============================================
CREATE OR REPLACE FUNCTION rpc_create_pr(
  p_items JSONB,
  p_note TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pr_id UUID;
  v_pr_no TEXT;
  v_item JSONB;
  v_last_price NUMERIC(12,2);
BEGIN
  v_pr_no := 'PR-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(floor(random()*9000+1000)::text, 4, '0');

  INSERT INTO inv_pr (pr_no, status, requested_by, requested_at, note)
  VALUES (v_pr_no, 'pending', p_user_id, NOW(), p_note)
  RETURNING id INTO v_pr_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT last_price INTO v_last_price
    FROM v_product_last_price
    WHERE product_id = (v_item->>'product_id')::UUID;

    INSERT INTO inv_pr_items (pr_id, product_id, qty, unit, estimated_price, last_purchase_price, note)
    VALUES (
      v_pr_id,
      (v_item->>'product_id')::UUID,
      (v_item->>'qty')::NUMERIC,
      v_item->>'unit',
      (v_item->>'estimated_price')::NUMERIC,
      COALESCE(v_last_price, NULL),
      v_item->>'note'
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_pr_id, 'pr_no', v_pr_no);
END;
$$;

-- ============================================
-- 1.12 RPC: rpc_convert_pr_to_po
-- ============================================
CREATE OR REPLACE FUNCTION rpc_convert_pr_to_po(
  p_pr_id UUID,
  p_supplier_id UUID DEFAULT NULL,
  p_supplier_name TEXT DEFAULT NULL,
  p_prices JSONB DEFAULT '[]'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_po_id UUID;
  v_po_no TEXT;
  v_total NUMERIC(14,2) := 0;
  v_pr_item RECORD;
  v_price NUMERIC(12,2);
  v_subtotal NUMERIC(14,2);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inv_pr WHERE id = p_pr_id AND status = 'approved') THEN
    RAISE EXCEPTION 'PR ไม่อยู่ในสถานะอนุมัติ';
  END IF;

  IF EXISTS (SELECT 1 FROM inv_po WHERE pr_id = p_pr_id) THEN
    RAISE EXCEPTION 'PR นี้ถูกแปลงเป็น PO แล้ว';
  END IF;

  v_po_no := 'PO-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(floor(random()*9000+1000)::text, 4, '0');

  INSERT INTO inv_po (po_no, pr_id, status, supplier_id, supplier_name, note)
  VALUES (v_po_no, p_pr_id, 'open', p_supplier_id, p_supplier_name, NULL)
  RETURNING id INTO v_po_id;

  FOR v_pr_item IN
    SELECT pri.product_id, pri.qty, pri.unit, pri.estimated_price
    FROM inv_pr_items pri
    WHERE pri.pr_id = p_pr_id
  LOOP
    v_price := NULL;
    SELECT (elem->>'unit_price')::NUMERIC INTO v_price
    FROM jsonb_array_elements(p_prices) elem
    WHERE (elem->>'product_id')::UUID = v_pr_item.product_id
    LIMIT 1;

    IF v_price IS NULL THEN
      v_price := v_pr_item.estimated_price;
    END IF;
    IF v_price IS NULL THEN
      SELECT last_price INTO v_price FROM v_product_last_price WHERE product_id = v_pr_item.product_id;
    END IF;

    v_subtotal := COALESCE(v_price, 0) * v_pr_item.qty;
    v_total := v_total + v_subtotal;

    INSERT INTO inv_po_items (po_id, product_id, qty, unit_price, subtotal, unit)
    VALUES (v_po_id, v_pr_item.product_id, v_pr_item.qty, v_price, v_subtotal, v_pr_item.unit);
  END LOOP;

  UPDATE inv_po SET total_amount = v_total, grand_total = v_total WHERE id = v_po_id;

  RETURN jsonb_build_object('id', v_po_id, 'po_no', v_po_no, 'total_amount', v_total);
END;
$$;

-- ============================================
-- 1.13 RPC: rpc_receive_gr
-- ============================================
CREATE OR REPLACE FUNCTION rpc_receive_gr(
  p_po_id UUID,
  p_items JSONB,
  p_shipping JSONB DEFAULT '{}'::JSONB,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_gr_id UUID;
  v_gr_no TEXT;
  v_item JSONB;
  v_has_shortage BOOLEAN := FALSE;
  v_total_received NUMERIC := 0;
  v_dom_cost NUMERIC(14,2);
  v_dom_cpp NUMERIC(12,4);
  v_qty_recv NUMERIC;
  v_qty_ord NUMERIC;
  v_qty_short NUMERIC;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inv_po WHERE id = p_po_id AND status IN ('ordered')) THEN
    RAISE EXCEPTION 'PO ไม่อยู่ในสถานะที่รับสินค้าได้';
  END IF;

  v_gr_no := 'GR-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(floor(random()*9000+1000)::text, 4, '0');

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
    v_qty_recv := (v_item->>'qty_received')::NUMERIC;
    v_qty_ord  := (v_item->>'qty_ordered')::NUMERIC;
    v_qty_short := GREATEST(v_qty_ord - v_qty_recv, 0);

    IF v_qty_short > 0 THEN
      v_has_shortage := TRUE;
    END IF;

    v_total_received := v_total_received + v_qty_recv;

    INSERT INTO inv_gr_items (gr_id, product_id, qty_received, qty_ordered, qty_shortage, shortage_note)
    VALUES (
      v_gr_id,
      (v_item->>'product_id')::UUID,
      v_qty_recv,
      v_qty_ord,
      v_qty_short,
      v_item->>'shortage_note'
    );

    -- อัปเดต stock balance
    IF v_qty_recv > 0 THEN
      INSERT INTO inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES ((v_item->>'product_id')::UUID, v_qty_recv, 0, 0)
      ON CONFLICT (product_id) DO UPDATE SET
        on_hand = inv_stock_balances.on_hand + v_qty_recv,
        updated_at = NOW();

      INSERT INTO inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note, created_by)
      VALUES (
        (v_item->>'product_id')::UUID,
        'gr',
        v_qty_recv,
        'inv_gr',
        v_gr_id,
        'รับเข้าจาก GR ' || v_gr_no,
        p_user_id
      );
    END IF;
  END LOOP;

  -- คำนวณค่าขนส่งต่อชิ้น
  v_dom_cost := (p_shipping->>'dom_shipping_cost')::NUMERIC;
  IF v_dom_cost IS NOT NULL AND v_dom_cost > 0 AND v_total_received > 0 THEN
    v_dom_cpp := v_dom_cost / v_total_received;
    UPDATE inv_gr SET dom_cost_per_piece = v_dom_cpp WHERE id = v_gr_id;
  END IF;

  -- ตั้งสถานะ GR
  IF v_has_shortage THEN
    UPDATE inv_gr SET status = 'partial' WHERE id = v_gr_id;
  END IF;

  -- อัปเดตสถานะ PO
  UPDATE inv_po SET status = CASE WHEN v_has_shortage THEN 'partial' ELSE 'received' END WHERE id = p_po_id;

  RETURN jsonb_build_object(
    'id', v_gr_id,
    'gr_no', v_gr_no,
    'status', CASE WHEN v_has_shortage THEN 'partial' ELSE 'received' END,
    'total_received', v_total_received
  );
END;
$$;

-- ============================================
-- 1.14 RPC: rpc_create_sample
-- ============================================
CREATE OR REPLACE FUNCTION rpc_create_sample(
  p_items JSONB,
  p_supplier_name TEXT DEFAULT NULL,
  p_note TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_sample_id UUID;
  v_sample_no TEXT;
  v_item JSONB;
BEGIN
  v_sample_no := 'SMP-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(floor(random()*9000+1000)::text, 4, '0');

  INSERT INTO inv_samples (sample_no, status, received_by, received_at, supplier_name, note)
  VALUES (v_sample_no, 'received', p_user_id, NOW(), p_supplier_name, p_note)
  RETURNING id INTO v_sample_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO inv_sample_items (sample_id, product_id, product_name_manual, qty, note)
    VALUES (
      v_sample_id,
      CASE WHEN v_item->>'product_id' IS NOT NULL AND v_item->>'product_id' != ''
        THEN (v_item->>'product_id')::UUID ELSE NULL END,
      v_item->>'product_name_manual',
      (v_item->>'qty')::NUMERIC,
      v_item->>'note'
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_sample_id, 'sample_no', v_sample_no);
END;
$$;
