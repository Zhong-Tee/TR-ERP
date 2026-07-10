-- =============================================================================
-- เพิ่มผู้ติดต่อฉุกเฉินคนที่ 2 (emergency_contact_2) ให้ตารางพนักงาน
--   - โครงสร้างเดียวกับ emergency_contact: { name, phone, relationship }
-- IDEMPOTENT: รันซ้ำได้
-- =============================================================================

ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS emergency_contact_2 JSONB;
