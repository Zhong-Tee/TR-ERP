-- =============================================================================
-- เงินพิเศษ/ประจำตำแหน่ง (position_allowance)
--   - hr_employees.salary = ฐานเงินเดือน, position_allowance = เงินพิเศษ/ประจำตำแหน่ง
--   - hr_salary_history เก็บทั้งฐานเงินเดือนและเงินพิเศษ/ประจำตำแหน่งต่อรายการ
--   - รายการล่าสุด (effective_date มากสุด) sync กลับไปที่ hr_employees เหมือน salary
-- IDEMPOTENT: รันซ้ำได้
-- =============================================================================

ALTER TABLE hr_employees
  ADD COLUMN IF NOT EXISTS position_allowance NUMERIC(12,2);

ALTER TABLE hr_salary_history
  ADD COLUMN IF NOT EXISTS position_allowance NUMERIC(12,2);

NOTIFY pgrst, 'reload schema';
