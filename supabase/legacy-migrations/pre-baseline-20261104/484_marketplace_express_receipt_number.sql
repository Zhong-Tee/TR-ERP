-- Marketplace shipping rules may request an additional express parcel receipt number.
BEGIN;

ALTER TABLE mp_orders
  ADD COLUMN IF NOT EXISTS requires_express_receipt_number BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS express_receipt_number TEXT;

ALTER TABLE or_orders
  ADD COLUMN IF NOT EXISTS express_receipt_number TEXT;

COMMENT ON COLUMN mp_orders.requires_express_receipt_number IS
  'Snapshot from the matched Marketplace shipping rule; controls the Assign field.';
COMMENT ON COLUMN mp_orders.express_receipt_number IS
  'เลขรับพัสดุด่วนที่กรอกในหน้า Marketplace Assign';
COMMENT ON COLUMN or_orders.express_receipt_number IS
  'เลขรับพัสดุด่วนที่ส่งต่อจาก Marketplace Assign';

COMMIT;
