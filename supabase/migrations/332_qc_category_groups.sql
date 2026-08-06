-- ============================================
-- QC CATEGORY GROUPS: กรุ๊ปหมวดหมู่สินค้าสำหรับตัวกรองในเมนู QC Operation
-- ตั้งชื่อกรุ๊ปและเลือกหมวดหมู่เข้ากรุ๊ปได้เองจากแถบ Settings ของ QC
-- (แทนการ hard-code เดิม เช่น UV-CTTA-L / SUB-KTA-C)
-- ============================================

-- 1. กรุ๊ป
CREATE TABLE IF NOT EXISTS qc_category_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE qc_category_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view qc category groups"
  ON qc_category_groups FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admin and QC staff can manage qc category groups"
  ON qc_category_groups FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'admin-tr', 'admin_qc', 'qc_staff')
    )
  );

-- 2. หมวดหมู่ที่อยู่ในกรุ๊ป
--    UNIQUE(category) — หมวดหมู่หนึ่งอยู่ได้กรุ๊ปเดียวเท่านั้น เพื่อไม่ให้การจัดกรุ๊ปกำกวม
CREATE TABLE IF NOT EXISTS qc_category_group_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES qc_category_groups(id) ON DELETE CASCADE,
  category TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_qc_category_group_items_group ON qc_category_group_items(group_id);

ALTER TABLE qc_category_group_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view qc category group items"
  ON qc_category_group_items FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admin and QC staff can manage qc category group items"
  ON qc_category_group_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'admin-tr', 'admin_qc', 'qc_staff')
    )
  );

-- 3. ค่าเริ่มต้น (ตามที่ใช้งานอยู่ปัจจุบัน) — แก้ไข/เพิ่ม/ลบได้เองในหน้า Settings
DO $$
DECLARE
  seed  JSONB := '[
    {"name": "UV-CTTA-E",  "sort": 1, "categories": ["UV-CTTA", "UV-CTTB", "UV-CTTC", "UV-CTTD", "UV-CTTE"]},
    {"name": "UV-CTTL",    "sort": 2, "categories": ["UV-CTTL"]},
    {"name": "UV-CTTF",    "sort": 3, "categories": ["UV-CTTF"]},
    {"name": "IRON+STK",   "sort": 4, "categories": ["IRON", "STK"]},
    {"name": "ETC+INK",    "sort": 5, "categories": ["ETC", "INK"]},
    {"name": "SUB-KTA-C",  "sort": 6, "categories": ["SUB-KTA", "SUB-KTB", "SUB-KTC"]}
  ]'::JSONB;
  grp   JSONB;
  gid   UUID;
  cat   TEXT;
BEGIN
  -- seed เฉพาะครั้งแรกที่ตารางยังว่าง เพื่อไม่ให้ทับค่าที่ผู้ใช้ตั้งไว้เอง
  IF EXISTS (SELECT 1 FROM qc_category_groups) THEN
    RETURN;
  END IF;

  FOR grp IN SELECT * FROM jsonb_array_elements(seed) LOOP
    INSERT INTO qc_category_groups (name, sort_order)
    VALUES (grp->>'name', (grp->>'sort')::INTEGER)
    RETURNING id INTO gid;

    FOR cat IN SELECT jsonb_array_elements_text(grp->'categories') LOOP
      INSERT INTO qc_category_group_items (group_id, category)
      VALUES (gid, cat)
      ON CONFLICT (category) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
