-- =============================================================================
-- ลบระบบนำเข้าไฟล์สแกนลายนิ้วมือ (เดิม) — ถูกแทนด้วยระบบบันทึกเวลา GPS (hr_time_entries)
-- คำเตือน: ลบข้อมูลประวัติการอัปโหลด/สรุปจากไฟล์ Excel เดิมถาวร
-- IDEMPOTENT: safe to re-run
-- =============================================================================

-- ─── 1. ตารางระบบนำเข้าไฟล์เดิม ──────────────────────────────────────────────
DROP TABLE IF EXISTS hr_attendance_daily;
DROP TABLE IF EXISTS hr_attendance_summary;
DROP TABLE IF EXISTS hr_attendance_uploads CASCADE;

DROP FUNCTION IF EXISTS batch_upsert_attendance(JSONB, JSONB, JSONB);

-- ─── 2. คอลัมน์รหัสลายนิ้วมือใน hr_employees (ใช้กับไฟล์เดิมเท่านั้น) ────────
ALTER TABLE hr_employees DROP COLUMN IF EXISTS fingerprint_id_old;
ALTER TABLE hr_employees DROP COLUMN IF EXISTS fingerprint_id_new;

-- ─── 3. hr_clock_settings — ถูกแทนด้วย hr_work_schedules (migration 263) ─────
-- 263 ย้ายค่าไปเป็นชุด "มาตรฐานบริษัท" แล้ว
DROP TABLE IF EXISTS hr_clock_settings;

-- ─── 4. Storage bucket hr-attendance ─────────────────────────────────────────
-- Supabase ไม่อนุญาตให้ DELETE storage.objects/buckets ตรง ๆ ผ่าน SQL (42501)
-- → ลบ bucket "hr-attendance" ด้วยมือที่ Dashboard > Storage (Empty bucket แล้ว Delete bucket)

-- สร้าง policy ชุด private buckets ใหม่โดยตัด hr-attendance ออก
DROP POLICY IF EXISTS "hr_private_buckets_select" ON storage.objects;
DROP POLICY IF EXISTS "hr_private_buckets_insert" ON storage.objects;
DROP POLICY IF EXISTS "hr_private_buckets_delete" ON storage.objects;

CREATE POLICY "hr_private_buckets_select" ON storage.objects FOR SELECT
  USING (bucket_id IN ('hr-documents','hr-contracts','hr-company-docs','hr-resumes') AND (SELECT hr_is_admin() OR auth.uid() IS NOT NULL));
CREATE POLICY "hr_private_buckets_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id IN ('hr-documents','hr-contracts','hr-company-docs','hr-resumes') AND (SELECT hr_is_admin()));
CREATE POLICY "hr_private_buckets_delete" ON storage.objects FOR DELETE
  USING (bucket_id IN ('hr-documents','hr-contracts','hr-company-docs','hr-resumes') AND (SELECT hr_is_admin()));
