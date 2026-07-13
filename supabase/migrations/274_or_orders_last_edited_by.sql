-- ผู้สร้างบิล (admin_user) ต้องไม่ถูกเขียนทับตอนแก้ไขบิล — ใช้เป็นการมองเห็นหลักของ sales
-- เพิ่ม last_edited_by เก็บชื่อผู้แก้ไขล่าสุด (แสดงผลอย่างเดียว ไม่มีผลต่อการมองเห็น)

ALTER TABLE or_orders
ADD COLUMN IF NOT EXISTS last_edited_by text;

COMMENT ON COLUMN or_orders.last_edited_by IS 'ชื่อผู้แก้ไขบิลล่าสุด (username/email) — แสดงผลเท่านั้น ไม่ใช้กรองการมองเห็น (การมองเห็นใช้ admin_user = ผู้สร้างบิล)';
