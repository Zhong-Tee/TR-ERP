-- Migration: Create bill_header_settings table for storing company bill header info
-- Also adds bill_header_id FK to bank_settings for linking bank accounts to bill headers

-- 1. Create bill_header_settings table
CREATE TABLE IF NOT EXISTS bill_header_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_key VARCHAR(50) UNIQUE NOT NULL,
  bill_code VARCHAR(10) DEFAULT '',
  company_name TEXT NOT NULL,
  company_name_en TEXT,
  address TEXT NOT NULL,
  tax_id VARCHAR(20) NOT NULL,
  branch VARCHAR(100) DEFAULT 'สำนักงานใหญ่',
  phone VARCHAR(50),
  logo_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bill_header_settings_company_key ON bill_header_settings(company_key);

-- Enable RLS
ALTER TABLE bill_header_settings ENABLE ROW LEVEL SECURITY;

-- RLS: authenticated can read
CREATE POLICY "Allow authenticated to read bill_header_settings"
  ON bill_header_settings FOR SELECT TO authenticated USING (true);

-- RLS: only superadmin can insert/update/delete
CREATE POLICY "Allow superadmin to insert bill_header_settings"
  ON bill_header_settings FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE us_users.id = auth.uid()
      AND us_users.role = 'superadmin'
    )
  );

CREATE POLICY "Allow superadmin to update bill_header_settings"
  ON bill_header_settings FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE us_users.id = auth.uid()
      AND us_users.role = 'superadmin'
    )
  );

CREATE POLICY "Allow superadmin to delete bill_header_settings"
  ON bill_header_settings FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE us_users.id = auth.uid()
      AND us_users.role = 'superadmin'
    )
  );

-- 2. Add bill_header_id FK to bank_settings
ALTER TABLE bank_settings
  ADD COLUMN IF NOT EXISTS bill_header_id UUID REFERENCES bill_header_settings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bank_settings_bill_header_id ON bank_settings(bill_header_id);

-- 3. Seed data from previously hardcoded companyData
INSERT INTO bill_header_settings (company_key, bill_code, company_name, company_name_en, address, tax_id, branch, phone)
VALUES
  ('tr', 'TR', 'ห้างหุ้นส่วนจำกัด ทีอาร์ คิดส์ช็อป', 'TR Kidsshop Limited Partnership', '1641,1643 ชั้นที่ 3 ถนนเพชรเกษม แขวงหลักสอง เขตบางแค กรุงเทพมหานคร 10160', '0103563005345', 'สำนักงานใหญ่', '082-934-1288'),
  ('odf', 'ODF', 'บริษัท ออนดีมานด์ แฟคตอรี่ จำกัด', 'Ondemand Factory Co., Ltd.', '1641,1643 ถนนเพชรเกษม แขวงหลักสอง เขตบางแค กรุงเทพมหานคร 10160', '0105564109286', 'สำนักงานใหญ่', '082-934-1288')
ON CONFLICT (company_key) DO NOTHING;

-- 4. Storage bucket for bill logos (run via Supabase dashboard or CLI)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('bill-logos', 'bill-logos', true) ON CONFLICT DO NOTHING;

COMMENT ON TABLE bill_header_settings IS 'Bill header settings: company name, address, tax ID, logo for tax invoices and cash bills';
COMMENT ON COLUMN bank_settings.bill_header_id IS 'Links a bank account to a bill header for auto-selecting company info on invoices';
