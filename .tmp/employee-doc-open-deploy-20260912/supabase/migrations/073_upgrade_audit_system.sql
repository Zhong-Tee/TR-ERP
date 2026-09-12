-- ============================================
-- 073: Upgrade Audit System
-- เพิ่มระบบ Audit สต๊อคแบบมืออาชีพ
-- - เพิ่มคอลัมน์ใน inv_audits / inv_audit_items
-- - สร้างตาราง inv_audit_count_logs
-- - อัปเดต RLS policies รองรับ role auditor
-- ============================================

-- ─── 1. ALTER inv_audits ──────────────────────────────────────

-- ประเภทและขอบเขต
ALTER TABLE inv_audits ADD COLUMN IF NOT EXISTS audit_type TEXT DEFAULT 'full';
ALTER TABLE inv_audits ADD COLUMN IF NOT EXISTS scope_filter JSONB;

-- การมอบหมายและ Timeline
ALTER TABLE inv_audits ADD COLUMN IF NOT EXISTS assigned_to UUID[];
ALTER TABLE inv_audits ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ;

-- การรีวิว
ALTER TABLE inv_audits ADD COLUMN IF NOT EXISTS reviewed_by UUID;
ALTER TABLE inv_audits ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- เชื่อมใบปรับสต๊อค
ALTER TABLE inv_audits ADD COLUMN IF NOT EXISTS adjustment_id UUID REFERENCES inv_adjustments(id);

-- KPI จุดจัดเก็บ
ALTER TABLE inv_audits ADD COLUMN IF NOT EXISTS location_accuracy_percent NUMERIC(5, 2);

-- KPI Safety Stock
ALTER TABLE inv_audits ADD COLUMN IF NOT EXISTS safety_stock_accuracy_percent NUMERIC(5, 2);

-- จำนวนรายการที่ผิด
ALTER TABLE inv_audits ADD COLUMN IF NOT EXISTS total_location_mismatches INTEGER DEFAULT 0;
ALTER TABLE inv_audits ADD COLUMN IF NOT EXISTS total_safety_stock_mismatches INTEGER DEFAULT 0;

-- ─── 2. ALTER inv_audit_items ─────────────────────────────────

-- การนับ
ALTER TABLE inv_audit_items ADD COLUMN IF NOT EXISTS counted_by UUID;
ALTER TABLE inv_audit_items ADD COLUMN IF NOT EXISTS counted_at TIMESTAMPTZ;
ALTER TABLE inv_audit_items ADD COLUMN IF NOT EXISTS is_counted BOOLEAN DEFAULT false;

-- ข้อมูล Denormalize สำหรับรายงาน
ALTER TABLE inv_audit_items ADD COLUMN IF NOT EXISTS storage_location TEXT;
ALTER TABLE inv_audit_items ADD COLUMN IF NOT EXISTS product_category TEXT;

-- ตรวจจุดจัดเก็บ
ALTER TABLE inv_audit_items ADD COLUMN IF NOT EXISTS system_location TEXT;
ALTER TABLE inv_audit_items ADD COLUMN IF NOT EXISTS actual_location TEXT;
ALTER TABLE inv_audit_items ADD COLUMN IF NOT EXISTS location_match BOOLEAN;

-- ตรวจ Safety Stock
ALTER TABLE inv_audit_items ADD COLUMN IF NOT EXISTS system_safety_stock NUMERIC(12, 2);
ALTER TABLE inv_audit_items ADD COLUMN IF NOT EXISTS counted_safety_stock NUMERIC(12, 2);
ALTER TABLE inv_audit_items ADD COLUMN IF NOT EXISTS safety_stock_match BOOLEAN;

-- ให้ counted_qty และ variance เป็น nullable สำหรับ items ที่ยังไม่ได้นับ
ALTER TABLE inv_audit_items ALTER COLUMN counted_qty DROP NOT NULL;
ALTER TABLE inv_audit_items ALTER COLUMN variance DROP NOT NULL;
ALTER TABLE inv_audit_items ALTER COLUMN counted_qty SET DEFAULT 0;
ALTER TABLE inv_audit_items ALTER COLUMN variance SET DEFAULT 0;

-- ─── 3. CREATE inv_audit_count_logs ───────────────────────────

CREATE TABLE IF NOT EXISTS inv_audit_count_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  audit_item_id UUID NOT NULL REFERENCES inv_audit_items(id) ON DELETE CASCADE,
  log_type TEXT NOT NULL DEFAULT 'count',
  counted_qty NUMERIC(12, 2),
  actual_location TEXT,
  counted_safety_stock NUMERIC(12, 2),
  counted_by UUID,
  counted_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE inv_audit_count_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view audit count logs"
  ON inv_audit_count_logs FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins and auditors can insert audit count logs"
  ON inv_audit_count_logs FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'admin-tr', 'manager', 'store', 'auditor')
    )
  );

-- ─── 4. UPDATE RLS Policies ───────────────────────────────────
-- อนุญาตเฉพาะ: superadmin, admin, auditor เท่านั้น

-- inv_audits: SELECT
DROP POLICY IF EXISTS "Anyone authenticated can view audits" ON inv_audits;
DROP POLICY IF EXISTS "Auditors can update assigned audits" ON inv_audits;
CREATE POLICY "Anyone authenticated can view audits"
  ON inv_audits FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'auditor', 'account')
    )
  );

-- inv_audits: FOR ALL (INSERT/UPDATE/DELETE) เฉพาะ superadmin, admin, auditor, account
DROP POLICY IF EXISTS "Admins can manage audits" ON inv_audits;
CREATE POLICY "Admins can manage audits"
  ON inv_audits FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'auditor', 'account')
    )
  );

-- inv_audit_items: SELECT
DROP POLICY IF EXISTS "Anyone authenticated can view audit items" ON inv_audit_items;
DROP POLICY IF EXISTS "Auditors can update assigned audit items" ON inv_audit_items;
CREATE POLICY "Anyone authenticated can view audit items"
  ON inv_audit_items FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'auditor', 'account')
    )
  );

-- inv_audit_items: FOR ALL (INSERT/UPDATE/DELETE) เฉพาะ superadmin, admin, auditor, account
DROP POLICY IF EXISTS "Admins can manage audit items" ON inv_audit_items;
CREATE POLICY "Admins can manage audit items"
  ON inv_audit_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'auditor', 'account')
    )
  );
