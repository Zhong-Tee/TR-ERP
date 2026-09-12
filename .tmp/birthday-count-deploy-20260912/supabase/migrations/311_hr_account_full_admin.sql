-- =============================================================================
-- Migration 311: ยกระดับ role account ให้เป็นผู้ดูแล HR เต็มตัว
--
-- ผู้ใช้ต้องการให้ account เข้าทำงานได้ทุกเมนู HR และแก้ไขข้อมูลได้ (ไม่ใช่แค่
-- ทะเบียนพนักงาน) วิธีที่ครอบคลุมและดูแลง่ายที่สุดคือเพิ่ม 'account' เข้า
-- hr_is_admin() เพราะทุก RLS policy / storage policy ของโมดูล HR อ้างฟังก์ชันนี้
--
-- ตรวจแล้วว่า hr_is_admin() ถูกใช้เฉพาะภายในโมดูล HR เท่านั้น (ตาราง hr_* และ
-- storage bucket hr-*) จึงไม่กระทบสิทธิ์ของโมดูลอื่น (sales/warehouse/purchase)
--
-- ผลที่ได้: account เพิ่ม/แก้ไข/ลบ ได้ทุกเมนู HR รวมทะเบียนทรัพย์สิน สัญญาจ้าง
-- ลางาน/OT ใบเตือน ฯลฯ และอัปโหลด/ลบไฟล์ได้ทุก bucket HR
-- migration 309 (hr_employees) และ 310 (hr-photos) จึงถูกครอบคลุมด้วย ไม่ต้องรัน
-- เพิ่ม (ถ้ารันไปแล้วก็ปล่อยไว้ได้ ไม่ขัดกัน)
--
-- หมายเหตุ: การแจ้งเตือนใบลา (hr_leave_notify) ยังส่งเฉพาะ superadmin/admin/hr
-- ตามเดิม account จะยังไม่ได้รับ Telegram แจ้งใบลา (ไม่กระทบสิทธิ์การทำงาน)
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.hr_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.us_users
    WHERE id = auth.uid()
      AND role IN ('superadmin', 'admin', 'hr', 'account')
  );
$$;

REVOKE ALL ON FUNCTION public.hr_is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_is_admin() TO authenticated;

COMMIT;
