-- หลังยืนยันที่อยู่บิล REQ: ย้ายจาก รอลงข้อมูล → ใบสั่งงาน (หรือ เสร็จสิ้น สำหรับ PUMP) เพื่อเข้าคิว Plan

BEGIN;

CREATE OR REPLACE FUNCTION rpc_confirm_claim_req_shipping(
  p_order_id UUID,
  p_recipient_name TEXT,
  p_customer_address TEXT,
  p_mobile_phone TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_role TEXT;
  v_rec TEXT := trim(both FROM coalesce(p_recipient_name, ''));
  v_addr TEXT := trim(both FROM coalesce(p_customer_address, ''));
  v_phone TEXT := trim(both FROM coalesce(p_mobile_phone, ''));
  v_bill TEXT;
  v_bd jsonb;
BEGIN
  SELECT u.role INTO v_role FROM us_users u WHERE u.id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'sales-tr', 'sales-pump') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยืนยันที่อยู่บิลเคลม (REQ)';
  END IF;

  SELECT o.bill_no, o.billing_details INTO v_bill, v_bd
  FROM or_orders o WHERE o.id = p_order_id FOR UPDATE;

  IF v_bill IS NULL THEN
    RAISE EXCEPTION 'ไม่พบบิล';
  END IF;
  IF v_bill NOT LIKE 'REQ%' THEN
    RAISE EXCEPTION 'บิลนี้ไม่ใช่บิลเคลม (REQ)';
  END IF;

  IF length(v_rec) = 0 OR length(v_addr) = 0 OR length(v_phone) = 0 THEN
    RAISE EXCEPTION 'กรุณากรอกชื่อผู้รับ ที่อยู่จัดส่ง และเบอร์โทรให้ครบ';
  END IF;

  v_bd := coalesce(v_bd, '{}'::jsonb);
  v_bd := v_bd || jsonb_build_object('mobile_phone', v_phone);

  UPDATE or_orders SET
    recipient_name = v_rec,
    customer_address = v_addr,
    billing_details = v_bd,
    claim_shipping_confirmed_at = NOW(),
    updated_at = NOW(),
    status = CASE
      WHEN status IS DISTINCT FROM 'รอลงข้อมูล' THEN status
      WHEN trim(both FROM coalesce(channel_code, '')) = 'PUMP' THEN 'เสร็จสิ้น'::text
      ELSE 'ใบสั่งงาน'::text
    END
  WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true);
END;
$fn$;

REVOKE ALL ON FUNCTION rpc_confirm_claim_req_shipping(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_confirm_claim_req_shipping(UUID, TEXT, TEXT, TEXT) TO authenticated;

-- แก้รายการที่ยืนยันที่อยู่แล้วแต่สถานะยังไม่ถูก promote (ก่อนมี logic ด้านบน)
UPDATE or_orders SET
  status = CASE
    WHEN trim(both FROM coalesce(channel_code, '')) = 'PUMP' THEN 'เสร็จสิ้น'::text
    ELSE 'ใบสั่งงาน'::text
  END,
  updated_at = NOW()
WHERE bill_no LIKE 'REQ%'
  AND status = 'รอลงข้อมูล'
  AND claim_shipping_confirmed_at IS NOT NULL;

COMMIT;
