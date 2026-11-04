-- Account > Bill edit: allow audited shipping-address corrections after a
-- work order has been opened, but never after shipment.
BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_update_order_limited_fields_with_shipping(
  p_order_id UUID,
  p_lines JSONB,
  p_channel_order_no TEXT,
  p_tracking_number TEXT,
  p_express_receipt_number TEXT,
  p_shipping_details JSONB,
  p_edited_by TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_result JSONB;
  v_order RECORD;
  v_before_billing JSONB;
  v_after_billing JSONB;
  v_customer_name TEXT;
  v_recipient_name TEXT;
  v_customer_address TEXT;
  v_address_line TEXT;
  v_sub_district TEXT;
  v_district TEXT;
  v_province TEXT;
  v_postal_code TEXT;
  v_mobile_phone TEXT;
  v_changes JSONB := '[]'::jsonb;
  v_address_change_count INT := 0;
BEGIN
  IF p_shipping_details IS NULL OR jsonb_typeof(p_shipping_details) <> 'object' THEN
    RAISE EXCEPTION 'p_shipping_details ต้องเป็น JSON object';
  END IF;

  -- This RPC performs the role, lock, linked-work-order, pending-amendment,
  -- duplicate-tracking and shipped checks. Its row lock remains held until
  -- this outer function finishes, preventing packing from shipping the bill
  -- between the check and the address update.
  SELECT public.rpc_update_order_limited_fields(
    p_order_id,
    p_lines,
    p_channel_order_no,
    p_tracking_number,
    p_express_receipt_number,
    p_edited_by
  ) INTO v_base_result;

  SELECT
    id, bill_no, status, shipped_time, customer_name, recipient_name,
    customer_address, billing_details
  INTO v_order
  FROM public.or_orders
  WHERE id = p_order_id
  FOR UPDATE;

  -- Defence in depth: do not rely only on the inner RPC for this business
  -- invariant. This also protects the function if the inner RPC changes later.
  IF v_order.status = 'จัดส่งแล้ว' OR v_order.shipped_time IS NOT NULL THEN
    RAISE EXCEPTION 'บิลจัดส่งแล้ว ไม่สามารถแก้ไขข้อมูลจัดส่งได้';
  END IF;

  v_before_billing := coalesce(v_order.billing_details, '{}'::jsonb);
  v_customer_name := coalesce(nullif(trim(p_shipping_details->>'customer_name'), ''), v_order.customer_name);
  v_recipient_name := nullif(trim(coalesce(p_shipping_details->>'recipient_name', '')), '');
  v_customer_address := coalesce(nullif(trim(p_shipping_details->>'customer_address'), ''), v_order.customer_address);
  v_address_line := nullif(trim(coalesce(p_shipping_details->>'address_line', '')), '');
  v_sub_district := nullif(trim(coalesce(p_shipping_details->>'sub_district', '')), '');
  v_district := nullif(trim(coalesce(p_shipping_details->>'district', '')), '');
  v_province := nullif(trim(coalesce(p_shipping_details->>'province', '')), '');
  v_postal_code := nullif(trim(coalesce(p_shipping_details->>'postal_code', '')), '');
  v_mobile_phone := nullif(trim(coalesce(p_shipping_details->>'mobile_phone', '')), '');

  v_after_billing := v_before_billing || jsonb_build_object(
    'address_line', v_address_line,
    'sub_district', v_sub_district,
    'district', v_district,
    'province', v_province,
    'postal_code', v_postal_code,
    'mobile_phone', v_mobile_phone
  );

  IF v_order.customer_name IS DISTINCT FROM v_customer_name THEN
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'customer_name', 'label', 'ชื่อลูกค้า/ช่องทาง',
      'before', coalesce(v_order.customer_name, ''), 'after', coalesce(v_customer_name, '')
    ));
  END IF;
  IF v_order.recipient_name IS DISTINCT FROM v_recipient_name THEN
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'recipient_name', 'label', 'ชื่อผู้รับ',
      'before', coalesce(v_order.recipient_name, ''), 'after', coalesce(v_recipient_name, '')
    ));
  END IF;
  IF v_order.customer_address IS DISTINCT FROM v_customer_address THEN
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'customer_address', 'label', 'ที่อยู่เต็ม',
      'before', coalesce(v_order.customer_address, ''), 'after', coalesce(v_customer_address, '')
    ));
  END IF;
  IF (v_before_billing->>'address_line') IS DISTINCT FROM v_address_line THEN
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'billing_details.address_line', 'label', 'ที่อยู่',
      'before', coalesce(v_before_billing->>'address_line', ''), 'after', coalesce(v_address_line, '')
    ));
  END IF;
  IF (v_before_billing->>'sub_district') IS DISTINCT FROM v_sub_district THEN
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'billing_details.sub_district', 'label', 'แขวง/ตำบล',
      'before', coalesce(v_before_billing->>'sub_district', ''), 'after', coalesce(v_sub_district, '')
    ));
  END IF;
  IF (v_before_billing->>'district') IS DISTINCT FROM v_district THEN
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'billing_details.district', 'label', 'เขต/อำเภอ',
      'before', coalesce(v_before_billing->>'district', ''), 'after', coalesce(v_district, '')
    ));
  END IF;
  IF (v_before_billing->>'province') IS DISTINCT FROM v_province THEN
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'billing_details.province', 'label', 'จังหวัด',
      'before', coalesce(v_before_billing->>'province', ''), 'after', coalesce(v_province, '')
    ));
  END IF;
  IF (v_before_billing->>'postal_code') IS DISTINCT FROM v_postal_code THEN
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'billing_details.postal_code', 'label', 'รหัสไปรษณีย์',
      'before', coalesce(v_before_billing->>'postal_code', ''), 'after', coalesce(v_postal_code, '')
    ));
  END IF;
  IF (v_before_billing->>'mobile_phone') IS DISTINCT FROM v_mobile_phone THEN
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'billing_details.mobile_phone', 'label', 'เบอร์โทรมือถือ',
      'before', coalesce(v_before_billing->>'mobile_phone', ''), 'after', coalesce(v_mobile_phone, '')
    ));
  END IF;

  v_address_change_count := jsonb_array_length(v_changes);

  IF v_address_change_count > 0 THEN
    UPDATE public.or_orders
    SET customer_name = v_customer_name,
        recipient_name = v_recipient_name,
        customer_address = v_customer_address,
        billing_details = v_after_billing,
        last_edited_by = coalesce(nullif(trim(p_edited_by), ''), 'unknown')
    WHERE id = p_order_id;

    INSERT INTO public.ac_bill_edit_logs (
      order_id, bill_no, edited_by, changes, snapshot_before, snapshot_after
    ) VALUES (
      p_order_id,
      nullif(v_order.bill_no, ''),
      coalesce(nullif(trim(p_edited_by), ''), 'unknown'),
      v_changes,
      jsonb_build_object(
        'customer_name', v_order.customer_name,
        'recipient_name', v_order.recipient_name,
        'customer_address', v_order.customer_address,
        'billing_details', v_before_billing
      ),
      jsonb_build_object(
        'customer_name', v_customer_name,
        'recipient_name', v_recipient_name,
        'customer_address', v_customer_address,
        'billing_details', v_after_billing
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'changes_count', coalesce((v_base_result->>'changes_count')::int, 0) + v_address_change_count
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_update_order_limited_fields_with_shipping(UUID, JSONB, TEXT, TEXT, TEXT, JSONB, TEXT) IS
'แก้ข้อมูลผลิต/อ้างอิงและข้อมูลจัดส่งของบิลที่ผูกใบงานก่อนจัดส่ง พร้อมบันทึกประวัติ';

REVOKE ALL ON FUNCTION public.rpc_update_order_limited_fields_with_shipping(UUID, JSONB, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_update_order_limited_fields_with_shipping(UUID, JSONB, TEXT, TEXT, TEXT, JSONB, TEXT) TO authenticated;

COMMIT;
