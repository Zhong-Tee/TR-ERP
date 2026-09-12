-- =====================================================================
-- Migration 323: ให้ sales แยก/รวมรายการสินค้าในงาน Marketplace ได้
--
-- ปัญหา: migration 291 ตั้ง mp_items_insert / mp_items_delete ไว้ให้เฉพาะ
--   superadmin/admin เท่านั้น แต่ปุ่ม "แยกรายการ" ใน MarketplaceOrderModal
--   ต้อง INSERT แถวใหม่ และปุ่ม "รวมกลับ" ต้อง DELETE แถวที่แยกไว้
--   → sales-tr / sales-pump กดแล้วเจอ
--     "new row violates row-level security policy for table mp_order_items"
--
-- แก้: ให้ INSERT/DELETE ใช้เงื่อนไขเดียวกับ SELECT/UPDATE คือ
--   "ตามสิทธิ์ของงานแม่ (mp_orders) ที่ assign ให้ตัวเอง"
--   sales ยังแตะได้เฉพาะงานที่ assigned_to = ตัวเอง เท่านั้น
-- =====================================================================

DROP POLICY IF EXISTS mp_items_insert ON mp_order_items;
DROP POLICY IF EXISTS mp_items_delete ON mp_order_items;

-- INSERT: แถวใหม่ต้องผูกกับงานที่ตัวเองมีสิทธิ์ (admin = ทุกงาน, sales = งานที่ถูก assign)
CREATE POLICY mp_items_insert ON mp_order_items FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM mp_orders o WHERE o.id = mp_order_id AND (
      EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin'))
      OR (o.assigned_to = auth.uid()
          AND EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role LIKE 'sales-%'))
    )
  ));

-- DELETE: ลบได้เฉพาะแถวของงานที่ตัวเองมีสิทธิ์ (ใช้ตอนกด "รวมกลับ")
CREATE POLICY mp_items_delete ON mp_order_items FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM mp_orders o WHERE o.id = mp_order_id AND (
      EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin'))
      OR (o.assigned_to = auth.uid()
          AND EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND u.role LIKE 'sales-%'))
    )
  ));

NOTIFY pgrst, 'reload schema';
