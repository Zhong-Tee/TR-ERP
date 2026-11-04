-- เพิ่มเกณฑ์ประเมินงาน 2 ด้าน: การแก้ปัญหา และ การทำงานเป็นทีม (รวมเป็น 6 ด้าน)
-- ปล่อยเป็น NULL ได้ เพื่อไม่กระทบผลประเมินเก่าที่มีแค่ 4 ด้าน
ALTER TABLE hr_task_evaluations ADD COLUMN IF NOT EXISTS problem_solving SMALLINT CHECK (problem_solving BETWEEN 1 AND 5);
ALTER TABLE hr_task_evaluations ADD COLUMN IF NOT EXISTS teamwork SMALLINT CHECK (teamwork BETWEEN 1 AND 5);

-- ให้ PostgREST เห็นคอลัมน์ใหม่ทันที
NOTIFY pgrst, 'reload schema';
