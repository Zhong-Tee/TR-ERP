-- Add slip_storage_path to ac_verified_slips so we can match and soft-delete
-- when user deletes a slip from UI (by storage path). Without this, soft-delete
-- cannot find the row and the list keeps showing old + new slips.
ALTER TABLE ac_verified_slips
  ADD COLUMN IF NOT EXISTS slip_storage_path TEXT;

-- Soft-delete columns: store who deleted, when, and reason (deletion_reason must be filled)
ALTER TABLE ac_verified_slips
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES us_users(id),
  ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_verified_slips_slip_storage_path
  ON ac_verified_slips (slip_storage_path) WHERE slip_storage_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_verified_slips_is_deleted
  ON ac_verified_slips (is_deleted) WHERE is_deleted = true;
