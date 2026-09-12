-- วันที่ เวลา นัดรับ (ช่องทาง SHOP PICKUP เท่านั้น)
ALTER TABLE or_orders
  ADD COLUMN IF NOT EXISTS scheduled_pickup_at TIMESTAMPTZ;

COMMENT ON COLUMN or_orders.scheduled_pickup_at IS 'วันที่ เวลา นัดรับ (ช่องทาง SHOP PICKUP)';
