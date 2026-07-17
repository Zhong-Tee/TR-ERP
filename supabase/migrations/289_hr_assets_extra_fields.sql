-- =============================================================================
-- 289: HR Asset Registry — ฟิลด์เพิ่มเติม + สถานะใหม่ + รันรหัสอัตโนมัติ
--      รูปแบบรหัส: AST-2026-0001 (รันใหม่ทุกปี ตามปฏิทิน ค.ศ. เวลาไทย)
--      รันซ้ำได้ปลอดภัย (idempotent)
-- =============================================================================

BEGIN;

-- ─── ฟิลด์ใหม่ ───────────────────────────────────────────────────────────────
ALTER TABLE hr_assets
  ADD COLUMN IF NOT EXISTS serial_number TEXT,
  ADD COLUMN IF NOT EXISTS sub_type TEXT,
  ADD COLUMN IF NOT EXISTS vendor_name TEXT,
  ADD COLUMN IF NOT EXISTS received_date DATE,
  ADD COLUMN IF NOT EXISTS warranty_expire_date DATE,
  ADD COLUMN IF NOT EXISTS useful_life_years NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS depreciation_per_year NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS has_warranty BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS warranty_period INTEGER,
  ADD COLUMN IF NOT EXISTS warranty_unit TEXT;

COMMENT ON COLUMN hr_assets.serial_number IS 'S/N ของทรัพย์สิน';
COMMENT ON COLUMN hr_assets.sub_type IS 'ประเภทย่อย เช่น Notebook, Printer, Monitor';
COMMENT ON COLUMN hr_assets.vendor_name IS 'ชื่อผู้ขาย';
COMMENT ON COLUMN hr_assets.received_date IS 'วันที่รับเข้า';
COMMENT ON COLUMN hr_assets.useful_life_years IS 'อายุการใช้งาน (ปี) — ใช้คำนวณค่าเสื่อม/ปี';
COMMENT ON COLUMN hr_assets.depreciation_per_year IS 'ค่าเสื่อมราคาต่อปี = มูลค่าตอนซื้อ ÷ อายุการใช้งาน';
COMMENT ON COLUMN hr_assets.current_value IS 'มูลค่าปัจจุบัน = มูลค่าตอนซื้อ − (ค่าเสื่อม/ปี × ปีที่ใช้งานไปแล้ว) ไม่ต่ำกว่า 0';
COMMENT ON COLUMN hr_assets.has_warranty IS 'มีการรับประกันหรือไม่ — false = วันหมดประกันเท่ากับวันที่ซื้อ';
COMMENT ON COLUMN hr_assets.warranty_period IS 'ระยะเวลารับประกัน (จำนวน) ใช้คู่กับ warranty_unit';
COMMENT ON COLUMN hr_assets.warranty_unit IS 'หน่วยของระยะประกัน: day | year';
COMMENT ON COLUMN hr_assets.warranty_expire_date IS 'วันหมดประกัน — คำนวณจากวันที่ซื้อ + ระยะประกัน';

ALTER TABLE hr_assets DROP CONSTRAINT IF EXISTS hr_assets_warranty_unit_check;
ALTER TABLE hr_assets ADD CONSTRAINT hr_assets_warranty_unit_check
  CHECK (warranty_unit IS NULL OR warranty_unit IN ('day', 'year'));

-- ─── สถานะใหม่: เพิ่ม ยืมใช้งาน (borrowed) และ จำหน่ายแล้ว (disposed) ────────
ALTER TABLE hr_assets DROP CONSTRAINT IF EXISTS hr_assets_status_check;
ALTER TABLE hr_assets ADD CONSTRAINT hr_assets_status_check
  CHECK (status IN ('active', 'borrowed', 'maintenance', 'retired', 'disposed', 'lost'));

-- ─── รันรหัสทรัพย์สินอัตโนมัติ: AST-2026-0001 ───────────────────────────────
-- ไม่ใช้ sequence เพราะเลขต้องรีเซ็ตทุกปี — อ่านเลขล่าสุดของปีนั้นแทน
DROP SEQUENCE IF EXISTS hr_asset_code_seq;

/** เลขรหัสถัดไปของปีปัจจุบัน — อ่านอย่างเดียว ใช้แสดงตัวอย่างในฟอร์ม */
CREATE OR REPLACE FUNCTION hr_asset_peek_next_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year TEXT;
  v_next INT;
BEGIN
  v_year := to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY');
  SELECT COALESCE(MAX((regexp_match(asset_code, '^AST-' || v_year || '-([0-9]+)$'))[1]::INT), 0) + 1
    INTO v_next
    FROM hr_assets
   WHERE asset_code ~ ('^AST-' || v_year || '-[0-9]+$');
  RETURN 'AST-' || v_year || '-' || lpad(v_next::TEXT, 4, '0');
END;
$$;

REVOKE ALL ON FUNCTION hr_asset_peek_next_code() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hr_asset_peek_next_code() TO authenticated;

CREATE OR REPLACE FUNCTION hr_assets_set_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year TEXT;
  v_next INT;
BEGIN
  IF NEW.asset_code IS NULL OR btrim(NEW.asset_code) = '' THEN
    v_year := to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY');
    -- กันสองคนกดบันทึกพร้อมกันแล้วได้เลขซ้ำ
    PERFORM pg_advisory_xact_lock(hashtext('hr_asset_code:' || v_year));
    SELECT COALESCE(MAX((regexp_match(asset_code, '^AST-' || v_year || '-([0-9]+)$'))[1]::INT), 0) + 1
      INTO v_next
      FROM hr_assets
     WHERE asset_code ~ ('^AST-' || v_year || '-[0-9]+$');
    NEW.asset_code := 'AST-' || v_year || '-' || lpad(v_next::TEXT, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_assets_set_code ON hr_assets;
CREATE TRIGGER trg_hr_assets_set_code
  BEFORE INSERT ON hr_assets
  FOR EACH ROW EXECUTE FUNCTION hr_assets_set_code();

COMMIT;
