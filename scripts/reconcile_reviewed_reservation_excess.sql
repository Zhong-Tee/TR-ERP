-- Explicit reviewed rows ONLY. Replace [] with the product UUID and snapshot
-- from audit_reservation_discrepancies.sql. Empty input deliberately raises an error.
-- Example row: {"product_id":"UUID","expected_reserved":1,"expected_linked_reserved":0}
-- No auto-selection of all products. Unsafe or changed rows abort the whole batch.
SELECT * FROM public.rpc_reconcile_reservation_excess(
  '[]'::jsonb,
  'ตรวจ WMS ตัดสต๊อกครบแล้วและต้นทางจองที่ยังใช้งานครบ ก่อนปลดจองเดิมส่วนเกิน'
);
