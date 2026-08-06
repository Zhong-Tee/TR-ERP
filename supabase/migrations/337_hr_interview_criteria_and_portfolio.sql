-- =============================================================================
-- 1) ลิงก์ portfolio ของผู้สมัคร
-- 2) หัวข้อเกณฑ์การให้คะแนนสัมภาษณ์ ผูกกับตำแหน่งงาน
--      - ตั้งค่าที่ HR → ตั้งค่า → เกณฑ์การให้คะแนน
--      - เลือกตำแหน่งตอนให้คะแนน = ดึงหัวข้อเริ่มต้นมาให้ (ยังเพิ่ม/ลบเองได้)
-- IDEMPOTENT: safe to re-run
-- =============================================================================

ALTER TABLE hr_candidates ADD COLUMN IF NOT EXISTS portfolio_url TEXT;

CREATE TABLE IF NOT EXISTS hr_interview_criteria_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id UUID NOT NULL REFERENCES hr_positions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  max_score INT NOT NULL DEFAULT 10,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_interview_criteria_position
  ON hr_interview_criteria_templates(position_id, sort_order);

-- =============================================================================
-- RLS: ทุกคนที่ล็อกอินอ่านได้ / จัดการได้เฉพาะ HR/admin (hr_is_admin)
-- =============================================================================
ALTER TABLE hr_interview_criteria_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hr_interview_criteria_select" ON hr_interview_criteria_templates;
DROP POLICY IF EXISTS "hr_interview_criteria_write" ON hr_interview_criteria_templates;
CREATE POLICY "hr_interview_criteria_select" ON hr_interview_criteria_templates
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_interview_criteria_write" ON hr_interview_criteria_templates
  FOR ALL TO authenticated USING (hr_is_admin()) WITH CHECK (hr_is_admin());
