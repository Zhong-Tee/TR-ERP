-- ลำดับการแสดงผลของประเภทงาน (ลากจัดลำดับในหน้าจัดการประเภทงาน)
ALTER TABLE hr_task_categories ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;

-- ตั้งลำดับเริ่มต้นตามชื่อ (ลำดับเดิมที่แสดงอยู่)
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY name) AS rn FROM hr_task_categories)
UPDATE hr_task_categories c SET sort_order = o.rn FROM ordered o WHERE c.id = o.id;

-- ให้ PostgREST เห็นคอลัมน์ใหม่ทันที
NOTIFY pgrst, 'reload schema';
