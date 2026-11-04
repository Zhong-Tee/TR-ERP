-- ปักหมุดโปรโมชั่นที่ใช้บ่อย เพื่อแสดงแยกในหน้าเปิดบิล
ALTER TABLE promotion
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_promotion_featured_active
  ON promotion(is_featured, is_active, sort_order);

NOTIFY pgrst, 'reload schema';
