-- =============================================================================
-- Migration 312: คืนสิทธิ์ storage ให้ bucket hr-assets (รูปทรัพย์สิน)
--
-- ต้นเหตุ: migration 264 ตั้งใจตัด hr-attendance ออกจาก hr_private_buckets_*
-- แต่ตอน recreate policy ลืมใส่ hr-assets กลับเข้ารายการ (150 เดิมมี hr-assets)
-- ทำให้ bucket hr-assets ไม่มี storage policy เหลืออยู่เลย → อัปโหลด/ลบไม่ได้
-- สำหรับทุก role รวมถึง admin (เพิ่งมาเจอเพราะ account ลองอัปโหลดรูปทรัพย์สิน)
--
-- แก้เป็น bucket สาธารณะแบบเดียวกับ hr-photos เพราะ:
--   1) โค้ดฝั่งแอปแสดงรูปด้วย getPublicUrl (ต้องการ public bucket)
--   2) รูปทรัพย์สิน (อุปกรณ์/เครื่องมือ) ไม่ใช่ข้อมูลอ่อนไหวเท่าเอกสาร/สัญญา
--
-- สิทธิ์เขียนอิง hr_is_admin() ซึ่งหลัง migration 311 รวม role account แล้ว
-- =============================================================================

BEGIN;

-- ให้ getPublicUrl แสดงรูปได้ (เดิม private=false ทำให้ URL เข้าไม่ถึงรูป)
UPDATE storage.buckets SET public = true WHERE id = 'hr-assets';

DROP POLICY IF EXISTS "hr_assets_photos_select" ON storage.objects;
DROP POLICY IF EXISTS "hr_assets_photos_insert" ON storage.objects;
DROP POLICY IF EXISTS "hr_assets_photos_update" ON storage.objects;
DROP POLICY IF EXISTS "hr_assets_photos_delete" ON storage.objects;

CREATE POLICY "hr_assets_photos_select" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'hr-assets');

CREATE POLICY "hr_assets_photos_insert" ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id = 'hr-assets' AND (SELECT hr_is_admin()));

CREATE POLICY "hr_assets_photos_update" ON storage.objects
  FOR UPDATE
  USING (bucket_id = 'hr-assets' AND (SELECT hr_is_admin()))
  WITH CHECK (bucket_id = 'hr-assets' AND (SELECT hr_is_admin()));

CREATE POLICY "hr_assets_photos_delete" ON storage.objects
  FOR DELETE
  USING (bucket_id = 'hr-assets' AND (SELECT hr_is_admin()));

COMMIT;
