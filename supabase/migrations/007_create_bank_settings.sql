-- Migration: Create bank_settings table for storing bank account information
-- This table stores bank account numbers and bank codes for slip verification

CREATE TABLE IF NOT EXISTS bank_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_number VARCHAR(50) NOT NULL,
  bank_code VARCHAR(10) NOT NULL,
  bank_name VARCHAR(100),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(account_number, bank_code)
);

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_bank_settings_account_number ON bank_settings(account_number);
CREATE INDEX IF NOT EXISTS idx_bank_settings_bank_code ON bank_settings(bank_code);
CREATE INDEX IF NOT EXISTS idx_bank_settings_active ON bank_settings(is_active);

-- Enable RLS
ALTER TABLE bank_settings ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Allow authenticated users to read, only admins can modify
CREATE POLICY "Allow authenticated users to read bank_settings"
  ON bank_settings
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow admins to insert bank_settings"
  ON bank_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE us_users.id = auth.uid()
      AND us_users.role IN ('superadmin', 'admin', 'account_staff')
    )
  );

CREATE POLICY "Allow admins to update bank_settings"
  ON bank_settings
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE us_users.id = auth.uid()
      AND us_users.role IN ('superadmin', 'admin', 'account_staff')
    )
  );

CREATE POLICY "Allow admins to delete bank_settings"
  ON bank_settings
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE us_users.id = auth.uid()
      AND us_users.role IN ('superadmin', 'admin', 'account_staff')
    )
  );

-- Add comment
COMMENT ON TABLE bank_settings IS 'Bank account settings for slip verification';
COMMENT ON COLUMN bank_settings.account_number IS 'Bank account number';
COMMENT ON COLUMN bank_settings.bank_code IS 'Bank code from EasySlip (e.g., 002, 004, 014)';
COMMENT ON COLUMN bank_settings.bank_name IS 'Bank name in Thai';
COMMENT ON COLUMN bank_settings.is_active IS 'Whether this bank account is active for verification';
