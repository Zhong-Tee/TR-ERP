-- =============================================================================
-- เปิดสิทธิ์ให้พนักงานอ่านทรัพย์สินที่ถือครองของตัวเองได้ (Employee Portal)
-- เดิม hr_assets ให้เฉพาะ admin — เพิ่ม policy select สำหรับเจ้าของทรัพย์สิน
-- (ใบเตือน/ใบรับรอง มี policy อ่านของตัวเองอยู่แล้วใน migration 134)
-- IDEMPOTENT: safe to re-run
-- =============================================================================

DROP POLICY IF EXISTS "hr_assets_select_own" ON hr_assets;
CREATE POLICY "hr_assets_select_own" ON hr_assets
  FOR SELECT TO authenticated
  USING (hr_is_admin() OR assigned_employee_id = hr_my_employee_id());
