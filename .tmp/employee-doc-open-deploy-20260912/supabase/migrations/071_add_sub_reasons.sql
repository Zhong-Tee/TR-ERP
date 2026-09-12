-- Add parent_id for hierarchical sub-reasons (inherit fail_type from parent)
ALTER TABLE settings_reasons
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES settings_reasons(id) ON DELETE CASCADE;

COMMENT ON COLUMN settings_reasons.parent_id
  IS 'NULL = top-level reason, UUID = sub-reason under that parent';

CREATE INDEX IF NOT EXISTS idx_settings_reasons_parent
  ON settings_reasons(parent_id);
