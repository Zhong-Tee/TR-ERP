-- Add unit_price column to or_order_items table
ALTER TABLE or_order_items
ADD COLUMN IF NOT EXISTS unit_price NUMERIC(10, 2) DEFAULT 0;

COMMENT ON COLUMN or_order_items.unit_price IS 'ราคาต่อหน่วย';

-- Create fonts table
CREATE TABLE IF NOT EXISTS fonts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  font_code VARCHAR(20) UNIQUE NOT NULL,
  font_name VARCHAR(100) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE fonts IS 'ตารางฟอนต์';
COMMENT ON COLUMN fonts.font_code IS 'รหัสฟอนต์';
COMMENT ON COLUMN fonts.font_name IS 'ชื่อฟอนต์';

-- Enable RLS
ALTER TABLE fonts ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Allow all authenticated users to read fonts"
  ON fonts FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow superadmin and admin to insert fonts"
  ON fonts FOR INSERT
  TO authenticated
  WITH CHECK (
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
  );

CREATE POLICY "Allow superadmin and admin to update fonts"
  ON fonts FOR UPDATE
  TO authenticated
  USING (
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
  );

-- Add trigger for updated_at
CREATE TRIGGER update_fonts_updated_at BEFORE UPDATE ON fonts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default fonts
INSERT INTO fonts (font_code, font_name) VALUES
  ('ANGSANA', 'Angsana'),
  ('CORDIA', 'Cordia'),
  ('BROWALLIA', 'Browallia'),
  ('TAHOMA', 'Tahoma'),
  ('SARABUN', 'Sarabun'),
  ('THN_KRUB', 'THNiramitAS'),
  ('DB_HELVETHAICAT', 'DB HelvetHaicaT'),
  ('CUSTOM', 'กำหนดเอง')
ON CONFLICT (font_code) DO NOTHING;
