BEGIN;

-- A returned Marketplace bill must finish saving its items before entering the locked review queue.
-- No guard bypass: pending-review bills are rejected before any write, under the same row lock.
CREATE FUNCTION public.rpc_save_marketplace_bill(p_order_id uuid, p_order_data jsonb, p_items jsonb)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE
  v_order public.or_orders;
  v_assignments text;
  v_status text;
  v_allowed text[] := ARRAY[
    'channel_code','customer_name','customer_address','channel_order_no','recipient_name',
    'scheduled_pickup_at','tracking_number','express_receipt_number','price','shipping_cost',
    'discount','total_amount','payment_method','promotion','payment_date','payment_time',
    'fulfillment_method','requires_confirm_design','status','entry_date','billing_details','last_edited_by'
  ];
BEGIN
  IF jsonb_typeof(p_order_data) IS DISTINCT FROM 'object' OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ข้อมูลบิลหรือรายการสินค้าไม่ถูกต้อง';
  END IF;
  IF jsonb_array_length(p_items)=0 THEN RAISE EXCEPTION 'กรุณาตรวจสอบรายการสินค้าและ SKU ต้นทางก่อนบันทึก'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_order_data) AS fields(key) WHERE NOT key=ANY(v_allowed)) THEN
    RAISE EXCEPTION 'มีฟิลด์บิลที่ไม่อนุญาตให้แก้ไข';
  END IF;
  IF nullif(p_order_data->>'status','') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุสถานะบิล'; END IF;

  SELECT * INTO v_order FROM public.or_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบหรือไม่มีสิทธิ์แก้ไขบิล'; END IF;
  IF v_order.source_marketplace_order_id IS NULL THEN RAISE EXCEPTION 'บิลนี้ไม่ได้มาจาก Marketplace'; END IF;
  IF v_order.status='รอตรวจคำสั่งซื้อ' THEN
    RAISE EXCEPTION 'บิล Marketplace อยู่ระหว่างรอตรวจคำสั่งซื้อ กรุณาตีกลับก่อนแก้ไขข้อมูล';
  END IF;

  PERFORM public.rpc_save_order_items(p_order_id,p_items);
  SELECT string_agg(format('%I = proposed.%I',key,key),', ' ORDER BY key)
    INTO v_assignments FROM jsonb_object_keys(p_order_data) AS fields(key);
  EXECUTE format('UPDATE public.or_orders AS target SET %s
    FROM jsonb_populate_record(NULL::public.or_orders,$1) AS proposed
    WHERE target.id=$2 RETURNING target.status',v_assignments)
    INTO v_status USING p_order_data,p_order_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่สามารถบันทึกบิลได้'; END IF;
  RETURN v_status;
END $$;
REVOKE ALL ON FUNCTION public.rpc_save_marketplace_bill(uuid,jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_save_marketplace_bill(uuid,jsonb,jsonb) TO authenticated;

COMMIT;
