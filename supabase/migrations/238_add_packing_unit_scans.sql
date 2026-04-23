-- ============================================
-- Packing unit scans (per-piece) for /packing
-- Supports scanning BillNo-Seq (unit_uid) like QC
-- ============================================

CREATE TABLE IF NOT EXISTS pk_packing_unit_scans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  unit_uid TEXT NOT NULL,
  scanned_by UUID REFERENCES us_users(id),
  scanned_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'scanned',
  UNIQUE(order_id, unit_uid)
);

CREATE INDEX IF NOT EXISTS idx_pk_packing_unit_scans_order_id
  ON pk_packing_unit_scans(order_id);

CREATE INDEX IF NOT EXISTS idx_pk_packing_unit_scans_unit_uid
  ON pk_packing_unit_scans(unit_uid);

ALTER TABLE pk_packing_unit_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Packing staff can manage unit scans" ON pk_packing_unit_scans;
CREATE POLICY "Packing staff can manage unit scans"
  ON pk_packing_unit_scans FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'packing_staff')
    )
  );

DROP POLICY IF EXISTS "Authenticated users can read unit scans" ON pk_packing_unit_scans;
CREATE POLICY "Authenticated users can read unit scans"
  ON pk_packing_unit_scans FOR SELECT
  USING (auth.role() = 'authenticated');

