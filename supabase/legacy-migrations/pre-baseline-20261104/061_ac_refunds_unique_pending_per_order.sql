-- ============================================
-- ป้องกันรายการโอนคืน (ac_refunds) ซ้ำ:
-- อนุญาตให้มี pending refund ได้แค่ 1 รายการต่อ order
-- (ยังอนุญาตให้มี approved/rejected หลายรายการได้)
-- ============================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_ac_refunds_order_pending
  ON ac_refunds (order_id)
  WHERE status = 'pending';
