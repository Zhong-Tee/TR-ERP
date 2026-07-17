-- =============================================================================
-- 290: HR Asset Registry — ประวัติการเปลี่ยนแปลง (audit log) + แผนกส่วนกลาง "สำนักงาน"
--      บันทึกอัตโนมัติผ่าน trigger: สร้างใหม่ / เปลี่ยนผู้รับผิดชอบ / เปลี่ยนสถานะ /
--      เปลี่ยนแผนก / เปลี่ยนสถานที่ใช้งาน / เปลี่ยนชื่อ
-- =============================================================================

BEGIN;

-- ─── แผนกส่วนกลาง สำหรับทรัพย์สินที่ไม่มีแผนกใดดูแลเป็นพิเศษ ──────────────────
INSERT INTO hr_departments (name, description)
VALUES ('สำนักงาน', 'ทรัพย์สินส่วนกลางขององค์กร — ไม่มีแผนกใดดูแลเป็นพิเศษ')
ON CONFLICT (name) DO NOTHING;

-- ─── ตาราง log ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_asset_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID REFERENCES hr_assets(id) ON DELETE CASCADE,
  asset_code TEXT,                 -- snapshot ชื่อ/รหัส ณ เวลานั้น (ไม่ต้อง join ตอนแสดง)
  asset_name TEXT,
  action TEXT NOT NULL,            -- 'created' | 'updated'
  field TEXT,                      -- คอลัมน์ที่เปลี่ยน (null สำหรับ created)
  field_label TEXT,                -- ป้ายภาษาไทยของฟิลด์
  old_value TEXT,
  new_value TEXT,
  changed_by UUID,
  changed_by_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_asset_logs_asset ON hr_asset_logs(asset_id);
CREATE INDEX IF NOT EXISTS idx_hr_asset_logs_created ON hr_asset_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_asset_logs_field ON hr_asset_logs(field);

ALTER TABLE hr_asset_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hr_asset_logs_select" ON hr_asset_logs;
CREATE POLICY "hr_asset_logs_select" ON hr_asset_logs FOR SELECT TO authenticated USING (hr_is_admin());

GRANT SELECT ON hr_asset_logs TO authenticated;

-- ─── helper: แปลงค่าให้อ่านง่าย ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION hr_asset_status_label(p TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p
    WHEN 'active' THEN 'ใช้งาน'
    WHEN 'borrowed' THEN 'ยืมใช้งาน'
    WHEN 'maintenance' THEN 'ซ่อมบำรุง'
    WHEN 'retired' THEN 'ปลดระวาง'
    WHEN 'disposed' THEN 'จำหน่ายแล้ว'
    WHEN 'lost' THEN 'สูญหาย'
    ELSE p
  END;
$$;

CREATE OR REPLACE FUNCTION hr_asset_emp_name(p UUID)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p IS NULL THEN '— ไม่ระบุ —'
    ELSE COALESCE(
      (SELECT NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') FROM hr_employees WHERE id = p),
      (SELECT employee_code FROM hr_employees WHERE id = p),
      '(ไม่พบพนักงาน)'
    )
  END;
$$;

CREATE OR REPLACE FUNCTION hr_asset_dept_name(p UUID)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p IS NULL THEN '— ไม่ระบุ —'
    ELSE COALESCE((SELECT name FROM hr_departments WHERE id = p), '(ไม่พบแผนก)')
  END;
$$;

-- ─── trigger: บันทึกการเปลี่ยนแปลง ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION hr_assets_log_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_by TEXT;
BEGIN
  SELECT username INTO v_by FROM us_users WHERE id = v_uid;
  v_by := COALESCE(v_by, 'ระบบ');

  IF TG_OP = 'INSERT' THEN
    INSERT INTO hr_asset_logs(asset_id, asset_code, asset_name, action, changed_by, changed_by_name)
    VALUES (NEW.id, NEW.asset_code, NEW.name, 'created', v_uid, v_by);
    RETURN NEW;
  END IF;

  -- UPDATE: บันทึกทีละฟิลด์ที่เปลี่ยนจริง
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    INSERT INTO hr_asset_logs(asset_id, asset_code, asset_name, action, field, field_label, old_value, new_value, changed_by, changed_by_name)
    VALUES (NEW.id, NEW.asset_code, NEW.name, 'updated', 'name', 'ชื่อทรัพย์สิน', OLD.name, NEW.name, v_uid, v_by);
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO hr_asset_logs(asset_id, asset_code, asset_name, action, field, field_label, old_value, new_value, changed_by, changed_by_name)
    VALUES (NEW.id, NEW.asset_code, NEW.name, 'updated', 'status', 'สถานะ',
            hr_asset_status_label(OLD.status), hr_asset_status_label(NEW.status), v_uid, v_by);
  END IF;

  IF NEW.assigned_employee_id IS DISTINCT FROM OLD.assigned_employee_id THEN
    INSERT INTO hr_asset_logs(asset_id, asset_code, asset_name, action, field, field_label, old_value, new_value, changed_by, changed_by_name)
    VALUES (NEW.id, NEW.asset_code, NEW.name, 'updated', 'assigned_employee_id', 'ผู้รับผิดชอบ',
            hr_asset_emp_name(OLD.assigned_employee_id), hr_asset_emp_name(NEW.assigned_employee_id), v_uid, v_by);
  END IF;

  IF NEW.department_id IS DISTINCT FROM OLD.department_id THEN
    INSERT INTO hr_asset_logs(asset_id, asset_code, asset_name, action, field, field_label, old_value, new_value, changed_by, changed_by_name)
    VALUES (NEW.id, NEW.asset_code, NEW.name, 'updated', 'department_id', 'แผนก',
            hr_asset_dept_name(OLD.department_id), hr_asset_dept_name(NEW.department_id), v_uid, v_by);
  END IF;

  IF NEW.location IS DISTINCT FROM OLD.location THEN
    INSERT INTO hr_asset_logs(asset_id, asset_code, asset_name, action, field, field_label, old_value, new_value, changed_by, changed_by_name)
    VALUES (NEW.id, NEW.asset_code, NEW.name, 'updated', 'location', 'สถานที่ใช้งาน',
            OLD.location, NEW.location, v_uid, v_by);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_assets_log ON hr_assets;
CREATE TRIGGER trg_hr_assets_log
  AFTER INSERT OR UPDATE ON hr_assets
  FOR EACH ROW EXECUTE FUNCTION hr_assets_log_changes();

COMMIT;
