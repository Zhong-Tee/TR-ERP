-- ============================================================
-- Migration 075: Product Type FG/RM + Fix WMS Requisition RLS
-- ============================================================

BEGIN;

-- ===== ส่วน A: Product Type FG/RM =====

-- Migrate ข้อมูลเดิม (FINISHPRODUCT, NULL, ว่าง) ให้เป็น FG
UPDATE pr_products SET product_type = 'FG'
  WHERE product_type IS NULL
     OR product_type = ''
     OR product_type = 'FINISHPRODUCT';

-- ค่าอื่นๆ ที่ไม่ใช่ FG/RM ให้เป็น FG ด้วย
UPDATE pr_products SET product_type = 'FG'
  WHERE product_type NOT IN ('FG', 'RM');

-- ตั้ง DEFAULT และ NOT NULL
ALTER TABLE pr_products ALTER COLUMN product_type SET DEFAULT 'FG';
ALTER TABLE pr_products ALTER COLUMN product_type SET NOT NULL;

-- เพิ่ม CHECK constraint
ALTER TABLE pr_products ADD CONSTRAINT chk_product_type CHECK (product_type IN ('FG', 'RM'));


-- ===== ส่วน B: แก้ RLS Policy - เพิ่ม production_mb + admin =====

-- ─── wms_requisition_topics ───────────────────────────────
DROP POLICY IF EXISTS "WMS requisition topics read" ON wms_requisition_topics;
DROP POLICY IF EXISTS "WMS requisition topics write" ON wms_requisition_topics;

CREATE POLICY "WMS requisition topics read"
  ON wms_requisition_topics FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','store','production','manager','production_mb')
    )
  );

CREATE POLICY "WMS requisition topics write"
  ON wms_requisition_topics FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','store')
    )
  );

-- ─── wms_requisitions ─────────────────────────────────────
DROP POLICY IF EXISTS "WMS requisitions read" ON wms_requisitions;
DROP POLICY IF EXISTS "WMS requisitions write" ON wms_requisitions;

CREATE POLICY "WMS requisitions read"
  ON wms_requisitions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','store','production','manager','production_mb')
    )
  );

CREATE POLICY "WMS requisitions write"
  ON wms_requisitions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','store','production','manager','production_mb')
    )
  );

-- ─── wms_requisition_items ────────────────────────────────
DROP POLICY IF EXISTS "WMS requisition items read" ON wms_requisition_items;
DROP POLICY IF EXISTS "WMS requisition items write" ON wms_requisition_items;

CREATE POLICY "WMS requisition items read"
  ON wms_requisition_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','store','production','manager','production_mb')
    )
  );

CREATE POLICY "WMS requisition items write"
  ON wms_requisition_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','store','production','manager','production_mb')
    )
  );

COMMIT;
