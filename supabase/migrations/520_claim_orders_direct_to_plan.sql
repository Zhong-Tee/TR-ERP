-- บิลเคลมที่ยืนยันข้อมูลจัดส่งแล้วต้องเข้า Plan -> ใบสั่งงานโดยตรง
-- ไม่ผ่านสถานะ "ตรวจสอบแล้ว" / หน้ารอตรวจคำสั่งซื้อ

BEGIN;

CREATE OR REPLACE FUNCTION public.tr_fn_claim_order_direct_to_plan()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.bill_no LIKE 'REQ%'
     AND NEW.claim_shipping_confirmed_at IS NOT NULL
     AND NEW.status = 'ตรวจสอบแล้ว' THEN
    NEW.status := CASE
      WHEN BTRIM(COALESCE(NEW.channel_code, '')) = 'PUMP' THEN 'เสร็จสิ้น'::text
      ELSE 'ใบสั่งงาน'::text
    END;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS tr_claim_order_direct_to_plan ON public.or_orders;
CREATE TRIGGER tr_claim_order_direct_to_plan
  BEFORE INSERT OR UPDATE ON public.or_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_fn_claim_order_direct_to_plan();

-- แก้บิลเคลมเดิมที่ผ่านการยืนยันข้อมูลแล้ว แต่ถูก client เขียนทับให้ค้างอยู่
UPDATE public.or_orders
SET
  status = CASE
    WHEN BTRIM(COALESCE(channel_code, '')) = 'PUMP' THEN 'เสร็จสิ้น'::text
    ELSE 'ใบสั่งงาน'::text
  END,
  updated_at = NOW()
WHERE bill_no LIKE 'REQ%'
  AND claim_shipping_confirmed_at IS NOT NULL
  AND status = 'ตรวจสอบแล้ว';

COMMIT;
