-- ลำดับการแสดงผลของโปรโมชั่น (ลากจัดลำดับในหน้าตั้งค่า → จัดการโปรโมชั่น)
ALTER TABLE promotion ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;

-- ตั้งลำดับเริ่มต้นตามชื่อ (ลำดับเดิมที่แสดงอยู่)
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY name) AS rn FROM promotion)
UPDATE promotion p SET sort_order = o.rn FROM ordered o WHERE p.id = o.id;

-- ให้ PostgREST เห็นคอลัมน์ใหม่ทันที
NOTIFY pgrst, 'reload schema';
