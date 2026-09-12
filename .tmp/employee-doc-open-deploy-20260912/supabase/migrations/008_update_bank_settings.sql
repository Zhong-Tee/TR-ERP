-- Migration: Update bank_settings table to add account_name and channels
-- This migration adds account_name field and creates a junction table for bank-channels relationship

-- Add account_name column
ALTER TABLE bank_settings 
ADD COLUMN IF NOT EXISTS account_name VARCHAR(100);

-- Create junction table for bank_settings and channels
CREATE TABLE IF NOT EXISTS bank_settings_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_setting_id UUID NOT NULL REFERENCES bank_settings(id) ON DELETE CASCADE,
  channel_code VARCHAR(50) NOT NULL REFERENCES channels(channel_code) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(bank_setting_id, channel_code)
);

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_bank_settings_channels_bank_setting_id ON bank_settings_channels(bank_setting_id);
CREATE INDEX IF NOT EXISTS idx_bank_settings_channels_channel_code ON bank_settings_channels(channel_code);

-- Enable RLS
ALTER TABLE bank_settings_channels ENABLE ROW LEVEL SECURITY;

-- RLS Policies for bank_settings_channels
CREATE POLICY "Allow authenticated users to read bank_settings_channels"
  ON bank_settings_channels
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow admins to insert bank_settings_channels"
  ON bank_settings_channels
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE us_users.id = auth.uid()
      AND us_users.role IN ('superadmin', 'admin', 'account_staff')
    )
  );

CREATE POLICY "Allow admins to update bank_settings_channels"
  ON bank_settings_channels
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE us_users.id = auth.uid()
      AND us_users.role IN ('superadmin', 'admin', 'account_staff')
    )
  );

CREATE POLICY "Allow admins to delete bank_settings_channels"
  ON bank_settings_channels
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
COMMENT ON COLUMN bank_settings.account_name IS 'Display name for this bank account';
COMMENT ON TABLE bank_settings_channels IS 'Junction table linking bank_settings to channels';
