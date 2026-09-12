-- =============================================================================
-- Migration 310: ให้ role account อัปโหลด/แก้ไข/ลบ รูปพนักงานใน bucket hr-photos
--
-- เดิม (migration 114) storage policy ของ hr-photos ให้ INSERT/DELETE เฉพาะ admin
-- (hr_is_admin()) ทำให้ account บันทึกการแก้ไขพนักงานที่มีการเปลี่ยนรูปไม่ได้
-- ขึ้น error "new row violates row-level security policy"
--
-- โค้ดฝั่งแอปอัปโหลดด้วย upsert:true จึงเพิ่มทั้ง INSERT (รูปใหม่) และ UPDATE
-- (ทับรูปเดิม path เดียวกัน) รวมถึง DELETE ให้ครบการจัดการรูปพนักงาน
-- SELECT ไม่ต้องเพิ่ม เพราะ hr_photos_select เปิดให้อ่านทุกคนอยู่แล้ว (bucket สาธารณะ)
-- reuse public.hr_account_can_read_all() ซึ่งเป็น true เมื่อ us_users.role = 'account'
-- =============================================================================

BEGIN;

DROP POLICY IF EXISTS "hr_photos_account_insert" ON storage.objects;
DROP POLICY IF EXISTS "hr_photos_account_update" ON storage.objects;
DROP POLICY IF EXISTS "hr_photos_account_delete" ON storage.objects;

CREATE POLICY "hr_photos_account_insert" ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id = 'hr-photos' AND (SELECT public.hr_account_can_read_all()));

CREATE POLICY "hr_photos_account_update" ON storage.objects
  FOR UPDATE
  USING (bucket_id = 'hr-photos' AND (SELECT public.hr_account_can_read_all()))
  WITH CHECK (bucket_id = 'hr-photos' AND (SELECT public.hr_account_can_read_all()));

CREATE POLICY "hr_photos_account_delete" ON storage.objects
  FOR DELETE
  USING (bucket_id = 'hr-photos' AND (SELECT public.hr_account_can_read_all()));

COMMIT;
