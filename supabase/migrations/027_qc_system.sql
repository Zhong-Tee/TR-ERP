-- QC System: reject_duration, settings_reasons, ink_types.hex_code
-- For QC Operation / Reject / Reports / History / Settings

-- 1. Add reject_duration to qc_records (seconds in Reject before update)
ALTER TABLE qc_records
  ADD COLUMN IF NOT EXISTS reject_duration INTEGER;

COMMENT ON COLUMN qc_records.reject_duration IS 'Duration in seconds item was in Reject queue before this update (for KPI/CSV)';

-- 2. Settings: failure reasons for QC FAIL dropdown
CREATE TABLE IF NOT EXISTS settings_reasons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reason_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE settings_reasons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "QC staff and admin can manage settings_reasons"
  ON settings_reasons FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'qc_staff')
    )
  );

CREATE POLICY "Authenticated can view settings_reasons"
  ON settings_reasons FOR SELECT
  USING (auth.role() = 'authenticated');

-- 3. Add hex_code to ink_types for QC ink color display
ALTER TABLE ink_types
  ADD COLUMN IF NOT EXISTS hex_code TEXT DEFAULT '#cccccc';

COMMENT ON COLUMN ink_types.hex_code IS 'Hex color for QC display (e.g. #000000)';
