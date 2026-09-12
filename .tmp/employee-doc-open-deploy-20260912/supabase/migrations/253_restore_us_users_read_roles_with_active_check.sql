-- ============================================================
-- 253: Restore broad read access on us_users (regression fix)
-- ------------------------------------------------------------
-- Migration 252 added an is_active gate to the "Admins can view
-- all users" SELECT policy, but accidentally narrowed the allowed
-- roles from the full list set in migration 149
--   (superadmin, admin, sales-tr, manager, picker, auditor, store, account)
-- down to just ['superadmin', 'sales-tr'].
--
-- ผลกระทบ: role อื่นๆ (admin, manager, store, picker, ...) อ่าน
-- us_users ไม่ได้อีกต่อไป ทำให้ dropdown "เลือก Picker" ในเมนู
-- จัดสินค้า → ใบงานใหม่ ว่างเปล่า และขึ้นข้อความ
-- "ยังไม่มีผู้ใช้ Role picker"
--
-- แก้: คืนรายชื่อ role เดิม โดยยังคง is_active gate ที่ 252 ต้องการ
-- ============================================================

DROP POLICY IF EXISTS "Admins can view all users" ON public.us_users;
CREATE POLICY "Admins can view all users"
  ON public.us_users FOR SELECT
  USING (
    public.is_current_user_active() AND (
      auth.uid() = id OR
      check_user_role(
        auth.uid(),
        ARRAY['superadmin', 'admin', 'sales-tr', 'manager', 'picker', 'auditor', 'store', 'account', 'production']
      )
    )
  );
