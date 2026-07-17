-- เพิ่มหัวข้อเคลม "ลงข้อมูลผิด" เป็นตัวเลือกแรก
INSERT INTO claim_type (code, name, sort_order)
VALUES ('data_entry_error', 'ลงข้อมูลผิด', 0)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  sort_order = EXCLUDED.sort_order;
