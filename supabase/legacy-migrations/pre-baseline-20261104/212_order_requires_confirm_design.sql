-- PUMP Confirm routing: บิลที่ไม่ต้องการเส้นทางออกแบบ → สถานะ "ไม่ต้องออกแบบ" แทน "ตรวจสอบแล้ว"
-- ค่า default true = ข้อมูลเดิมยังไปคิว "งานใหม่" เหมือนเดิม

ALTER TABLE or_orders
ADD COLUMN IF NOT EXISTS requires_confirm_design boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN or_orders.requires_confirm_design IS 'PUMP: true=คิว Confirm งานใหม่ (ต้องออกแบบ), false=คิว ไม่ต้องออกแบบ เมื่อถึงสถานะตรวจสอบแล้ว';
