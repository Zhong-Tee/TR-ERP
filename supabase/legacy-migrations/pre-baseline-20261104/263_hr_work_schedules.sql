-- =============================================================================
-- HR Work Schedules: มาตรฐานเวลาทำงานหลายชุด (ตั้งชื่อได้ กำหนดวัน/เวลา/ผ่อนผันสายต่อชุด)
-- แทนที่ hr_clock_settings แบบแถวเดียว — ตารางเดิมคงไว้ (ไม่ลบ) แต่ UI ใช้ตารางนี้แทน
-- IDEMPOTENT: safe to re-run
-- =============================================================================

-- ─── 1. hr_work_schedules ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_work_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  work_start TIME NOT NULL DEFAULT '08:00',
  work_end TIME NOT NULL DEFAULT '17:00',
  late_grace_min INT NOT NULL DEFAULT 0,
  -- วันทำงานต่อสัปดาห์ (ISO: 1=จันทร์ ... 7=อาทิตย์) คั่นด้วย comma
  work_days TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
  -- ชุดค่าเริ่มต้น: ใช้กับพนักงานที่ยังไม่ได้กำหนดมาตรฐานเวลา
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 2. hr_employees.work_schedule_id ────────────────────────────────────────
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS work_schedule_id UUID REFERENCES hr_work_schedules(id) ON DELETE SET NULL;

-- ─── 3. Seed: ย้ายค่าจาก hr_clock_settings เดิมมาเป็นชุดแรก (ค่าเริ่มต้น) ────
INSERT INTO hr_work_schedules (name, work_start, work_end, late_grace_min, work_days, is_default)
SELECT 'มาตรฐานบริษัท', s.work_start, s.work_end, s.late_grace_min, s.work_days, true
FROM hr_clock_settings s
WHERE NOT EXISTS (SELECT 1 FROM hr_work_schedules)
LIMIT 1;

-- เผื่อกรณีไม่มีแถวใน hr_clock_settings เลย
INSERT INTO hr_work_schedules (name, is_default)
SELECT 'มาตรฐานบริษัท', true
WHERE NOT EXISTS (SELECT 1 FROM hr_work_schedules);

-- ─── 4. Trigger: บังคับให้มี default เพียงชุดเดียว ───────────────────────────
CREATE OR REPLACE FUNCTION hr_work_schedules_single_default() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_default THEN
    UPDATE hr_work_schedules SET is_default = false WHERE id <> NEW.id AND is_default;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_hr_work_schedules_single_default ON hr_work_schedules;
CREATE TRIGGER trg_hr_work_schedules_single_default
  AFTER INSERT OR UPDATE OF is_default ON hr_work_schedules
  FOR EACH ROW WHEN (NEW.is_default) EXECUTE FUNCTION hr_work_schedules_single_default();

DROP TRIGGER IF EXISTS trg_hr_work_schedules_updated ON hr_work_schedules;
CREATE TRIGGER trg_hr_work_schedules_updated BEFORE UPDATE ON hr_work_schedules FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

-- ─── 5. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE hr_work_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hr_work_schedules_select" ON hr_work_schedules;
DROP POLICY IF EXISTS "hr_work_schedules_manage" ON hr_work_schedules;
CREATE POLICY "hr_work_schedules_select" ON hr_work_schedules FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_work_schedules_manage" ON hr_work_schedules FOR ALL TO authenticated USING (hr_is_superadmin());
