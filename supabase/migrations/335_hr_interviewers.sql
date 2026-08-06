-- =============================================================================
-- ผู้สัมภาษณ์ (Interviewers)
--   - รายชื่อพนักงานที่ตั้งค่าไว้ให้เลือกเป็นผู้สัมภาษณ์ในหน้า "นัดสัมภาษณ์"
--   - โครงสร้าง/สิทธิ์เหมือน hr_announcement_approvers (ตั้งค่าโดย superadmin)
-- IDEMPOTENT: safe to re-run
-- =============================================================================

CREATE TABLE IF NOT EXISTS hr_interviewers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL UNIQUE REFERENCES hr_employees(id) ON DELETE CASCADE,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_interviewers_active ON hr_interviewers(is_active, sort_order);

-- =============================================================================
-- RLS: ทุกคนที่ล็อกอินอ่านได้ / ตั้งค่าได้เฉพาะ superadmin
-- =============================================================================
ALTER TABLE hr_interviewers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hr_interviewers_select" ON hr_interviewers;
DROP POLICY IF EXISTS "hr_interviewers_write" ON hr_interviewers;
CREATE POLICY "hr_interviewers_select" ON hr_interviewers FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_interviewers_write" ON hr_interviewers FOR ALL TO authenticated
  USING (hr_is_superadmin()) WITH CHECK (hr_is_superadmin());
