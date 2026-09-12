-- หัวข้อเคลมชุดใหม่ + คอลัมน์ URL / คำอธิบาย ในคิว or_claim_requests

BEGIN;

ALTER TABLE or_claim_requests
  ADD COLUMN IF NOT EXISTS supporting_url TEXT,
  ADD COLUMN IF NOT EXISTS claim_description TEXT;

COMMENT ON COLUMN or_claim_requests.supporting_url IS 'ลิงก์หลักฐานเคลม (เช่น รูป/วิดีโอภายนอก)';
COMMENT ON COLUMN or_claim_requests.claim_description IS 'คำอธิบายการเคลม ทุกหัวข้อ';

-- ย้ายรหัสเก่าไปรหัสใหม่ (ข้อมูลเดิมใน or_orders / or_claim_requests)
UPDATE or_claim_requests SET claim_type = 'damaged_defect' WHERE claim_type = 'damage';
UPDATE or_claim_requests SET claim_type = 'incomplete_qty' WHERE claim_type = 'missing';
UPDATE or_claim_requests SET claim_type = 'not_as_ordered' WHERE claim_type = 'wrong';

UPDATE or_orders SET claim_type = 'damaged_defect' WHERE claim_type = 'damage';
UPDATE or_orders SET claim_type = 'incomplete_qty' WHERE claim_type = 'missing';
UPDATE or_orders SET claim_type = 'not_as_ordered' WHERE claim_type = 'wrong';

DELETE FROM claim_type WHERE code IN ('damage', 'missing', 'wrong');

INSERT INTO claim_type (code, name, sort_order) VALUES
  ('damaged_defect', 'สินค้าเสียหาย/ชำรุด', 1),
  ('not_as_ordered', 'ได้สินค้าไม่ตรงตามที่สั่ง', 2),
  ('incomplete_qty', 'สินค้าขาด/ไม่ครบ', 3),
  ('quality_issue', 'คุณภาพไม่ตรงมาตรฐาน', 4),
  ('shipping_damage', 'ความเสียหายจากขนส่ง', 5),
  ('usage_issue', 'ปัญหาการใช้งาน', 6),
  ('late_delivery', 'ได้สินค้าล่าช้า', 7),
  ('other', 'อื่นๆ', 99)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  sort_order = EXCLUDED.sort_order;

COMMIT;
