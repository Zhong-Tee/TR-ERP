-- Authorized repair for the single bill investigated in this chat.
-- Requires migration 648. Keeps all packing, parcel and verification evidence.
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='30s';
SELECT set_config('app.order_status_source','refund_status_repair',true);
SELECT set_config('app.order_status_reason','แก้บิล FBTR26100104 ที่สถานะย้อนกลับหลังส่งคำขอโอนคืนซ้ำ โดยมีหลักฐานแพ็คและทวนสอบแล้ว ไม่มีประวัติยกเลิกการส่งภายหลัง และคำขอโอนคืนล่าสุดอนุมัติแล้ว ตามคำสั่งผู้ใช้',true);
DO $$
DECLARE v_order public.or_orders; v_latest text;
BEGIN
  SELECT * INTO v_order FROM public.or_orders WHERE bill_no='FBTR26100104' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิลที่ต้องการแก้ไข'; END IF;
  IF v_order.status='จัดส่งแล้ว' THEN RETURN; END IF;
  IF v_order.status<>'ใบสั่งงาน' OR v_order.shipped_time IS NULL
    OR v_order.tracking_number IS DISTINCT FROM 'TH270798NPQS4H'
    OR (v_order.transport_meta->>'verified') IS DISTINCT FROM 'true'
    OR nullif(v_order.transport_meta->>'verified_at','') IS NULL
    OR (v_order.transport_meta->>'verified_at')::timestamptz<v_order.shipped_time
    OR EXISTS(SELECT 1 FROM public.pk_packing_reset_logs WHERE order_id=v_order.id AND reset_at>v_order.shipped_time) THEN
    RAISE EXCEPTION 'หลักฐานของบิลเปลี่ยนไป ต้องตรวจใหม่ก่อนแก้สถานะ';
  END IF;
  SELECT status INTO v_latest FROM public.ac_refunds WHERE order_id=v_order.id ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM 'approved' OR public.or_refund_production_block(v_order.id,v_order.total_amount) IS NOT NULL THEN
    RAISE EXCEPTION 'คำขอโอนคืนยังไม่เสร็จสิ้น';
  END IF;
  UPDATE public.or_orders SET status='จัดส่งแล้ว' WHERE id=v_order.id;
END $$;
SELECT bill_no,status,tracking_number,shipped_time,transport_meta->>'verified_at' AS verified_at
FROM public.or_orders WHERE bill_no='FBTR26100104';
COMMIT;
