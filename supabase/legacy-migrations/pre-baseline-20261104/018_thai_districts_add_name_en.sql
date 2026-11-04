-- เพิ่ม name_en ใน thai_districts (ตรง districts.csv) สำหรับกรณีรัน 017 ไปแล้ว
ALTER TABLE thai_districts ADD COLUMN IF NOT EXISTS name_en text;
