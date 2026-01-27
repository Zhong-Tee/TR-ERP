-- Add validation status fields to ac_verified_slips
-- This allows storing EasySlip responses BEFORE validation, then marking validation status

ALTER TABLE ac_verified_slips
  ADD COLUMN IF NOT EXISTS is_validated BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS validation_status TEXT CHECK (validation_status IN ('pending', 'passed', 'failed')),
  ADD COLUMN IF NOT EXISTS validation_errors TEXT[],
  ADD COLUMN IF NOT EXISTS expected_amount NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS expected_bank_account TEXT,
  ADD COLUMN IF NOT EXISTS expected_bank_code TEXT,
  -- Individual validation statuses for each field
  ADD COLUMN IF NOT EXISTS account_name_match BOOLEAN,
  ADD COLUMN IF NOT EXISTS bank_code_match BOOLEAN,
  ADD COLUMN IF NOT EXISTS amount_match BOOLEAN;

-- Index for faster lookup of validation status
CREATE INDEX IF NOT EXISTS idx_verified_slips_validation_status
  ON ac_verified_slips (validation_status);

CREATE INDEX IF NOT EXISTS idx_verified_slips_is_validated
  ON ac_verified_slips (is_validated);
