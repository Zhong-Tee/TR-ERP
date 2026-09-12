-- ตารางที่อยู่ประเทศไทย สำหรับค้นหาจังหวัด/แขวง/ตำบล/เขตอำเภอ จากรหัสไปรษณีย์ 5 หลัก
-- รัน migration นี้ก่อน แล้วรันสคริปต์ seed (scripts/seed_thai_address.mjs) เพื่อใส่ข้อมูลจาก CSV

-- จังหวัด
CREATE TABLE IF NOT EXISTS thai_provinces (
  id integer PRIMARY KEY,
  name_th text NOT NULL
);

-- เขต/อำเภอ (ตรง districts.csv: id, name_th, name_en, province_id)
CREATE TABLE IF NOT EXISTS thai_districts (
  id integer PRIMARY KEY,
  province_id integer NOT NULL REFERENCES thai_provinces(id),
  name_th text,
  name_en text
);

CREATE INDEX IF NOT EXISTS idx_thai_districts_province ON thai_districts(province_id);

-- แขวง/ตำบล
CREATE TABLE IF NOT EXISTS thai_sub_districts (
  id bigint PRIMARY KEY,
  zip_code text NOT NULL,
  name_th text NOT NULL,
  district_id integer NOT NULL REFERENCES thai_districts(id)
);

CREATE INDEX IF NOT EXISTS idx_thai_sub_districts_zip ON thai_sub_districts(zip_code);

-- RLS: อ่านได้ทุก role ที่ login แล้ว (ใช้ในฟอร์มลงออเดอร์)
ALTER TABLE thai_provinces ENABLE ROW LEVEL SECURITY;
ALTER TABLE thai_districts ENABLE ROW LEVEL SECURITY;
ALTER TABLE thai_sub_districts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read thai_provinces"
  ON thai_provinces FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow read thai_districts"
  ON thai_districts FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow read thai_sub_districts"
  ON thai_sub_districts FOR SELECT
  TO authenticated
  USING (true);

-- อนุญาตให้ anon อ่านได้ (ถ้าฟอร์มลงออเดอร์ใช้ก่อน login อาจต้องเปิด)
-- ถ้าไม่ต้องการให้ anon อ่าน ลบ policy ด้านล่างออก
CREATE POLICY "Allow read thai_provinces anon"
  ON thai_provinces FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "Allow read thai_districts anon"
  ON thai_districts FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "Allow read thai_sub_districts anon"
  ON thai_sub_districts FOR SELECT
  TO anon
  USING (true);
