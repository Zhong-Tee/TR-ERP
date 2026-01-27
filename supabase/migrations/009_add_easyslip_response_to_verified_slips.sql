-- Add EasySlip full response fields to verified slips
ALTER TABLE ac_verified_slips
  ADD COLUMN IF NOT EXISTS easyslip_response JSONB,
  ADD COLUMN IF NOT EXISTS easyslip_trans_ref TEXT,
  ADD COLUMN IF NOT EXISTS easyslip_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS easyslip_receiver_bank_id TEXT,
  ADD COLUMN IF NOT EXISTS easyslip_receiver_account TEXT;

-- Optional indexes for faster lookup
CREATE INDEX IF NOT EXISTS idx_verified_slips_trans_ref
  ON ac_verified_slips (easyslip_trans_ref);

CREATE INDEX IF NOT EXISTS idx_verified_slips_receiver_bank_id
  ON ac_verified_slips (easyslip_receiver_bank_id);
