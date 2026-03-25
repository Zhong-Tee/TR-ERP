-- 191: เก็บ work_order_id ต้นทางสำหรับบิลที่ถูก "ย้ายไปใบสั่งงาน"
-- เพื่อให้ Dashboard/Plan ผูกป้ายด้วย UUID ไม่ชนชื่อใบงานซ้ำ

ALTER TABLE or_orders
  ADD COLUMN IF NOT EXISTS plan_released_from_work_order_id UUID REFERENCES or_work_orders(id) ON DELETE SET NULL;

COMMENT ON COLUMN or_orders.plan_released_from_work_order_id IS
  'work_order_id ต้นทางที่บิลถูกย้ายออกจากใบงานไปเป็นใบสั่งงาน (ใช้กันชื่อใบงานซ้ำ)';

