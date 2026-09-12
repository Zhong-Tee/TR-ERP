-- 259: Add toggle to show/hide system stock qty for auditors during count
ALTER TABLE inv_audits
  ADD COLUMN IF NOT EXISTS show_system_qty BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN inv_audits.show_system_qty IS
  'When true, auditors see snapshot system_qty on mobile count screens';
