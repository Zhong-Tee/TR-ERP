-- Run AFTER migration 631. User confirmed one cash payment of 2079.
-- Preserve both approval audit records, exclude the second from active payments.
BEGIN;
SELECT id FROM public.or_orders WHERE id='0599b759-237d-42af-a4db-4249e70fe4b1' FOR UPDATE;
DO $$
DECLARE o public.or_orders; kept public.ac_manual_slip_checks; repeated public.ac_manual_slip_checks;
BEGIN
 SELECT * INTO o FROM public.or_orders WHERE id='0599b759-237d-42af-a4db-4249e70fe4b1';
 IF NOT FOUND OR o.bill_no<>'SHOPP26100005' OR o.fulfillment_method<>'self_pickup'
  OR o.work_order_id IS NOT NULL OR o.status NOT IN ('ลงข้อมูลผิด','ตรวจสอบแล้ว','รอตรวจคำสั่งซื้อ')
  OR o.price<>2310 OR NOT ((o.shipping_cost=30 AND o.discount=261 AND o.total_amount=2079)
   OR (o.shipping_cost=0 AND o.discount=261 AND o.total_amount IN (2049,2079))
   OR (o.shipping_cost=0 AND o.discount=231 AND o.total_amount=2079)) THEN
  RAISE EXCEPTION 'บิลมีข้อมูลเปลี่ยนไป ต้องตรวจสอบก่อนแก้ยอด';
 END IF;
 SELECT * INTO kept FROM public.ac_manual_slip_checks WHERE id='e0a5ae14-60ac-4b52-b2e9-284e386b447f' FOR UPDATE;
 SELECT * INTO repeated FROM public.ac_manual_slip_checks WHERE id='e62533f5-9fe8-480d-b205-eecf2659e1db' FOR UPDATE;
 IF kept.order_id IS DISTINCT FROM o.id OR repeated.order_id IS DISTINCT FROM o.id
  OR kept.status IS DISTINCT FROM 'approved' OR kept.transfer_amount IS DISTINCT FROM 2079
  OR repeated.transfer_amount IS DISTINCT FROM kept.transfer_amount
  OR repeated.transfer_date IS DISTINCT FROM kept.transfer_date
  OR repeated.transfer_time IS DISTINCT FROM kept.transfer_time
  OR NOT (repeated.status='approved' OR (repeated.status='cancelled' AND repeated.duplicate_of=kept.id)) THEN
  RAISE EXCEPTION 'รายการตรวจมือไม่ตรงกับข้อมูลที่ยืนยัน';
 END IF;
 UPDATE public.ac_manual_slip_checks SET status='cancelled',duplicate_of=kept.id,
 cancelled_at=coalesce(cancelled_at,now()), rejected_reason='ตรวจรับเงินสดซ้ำ: นับยอดจากรายการแรกเพียงครั้งเดียว'
 WHERE id=repeated.id;
 PERFORM set_config('app.legacy_pickup_normalization','yes',true);
 UPDATE public.or_orders SET shipping_cost=0,discount=231,total_amount=2079 WHERE id=o.id;
 -- Set the original approval total after restoring the confirmed payable total.
 UPDATE public.ac_manual_slip_checks SET approved_order_total=2079 WHERE id=kept.id;
END $$;
SELECT bill_no,status,price,shipping_cost,discount,total_amount FROM public.or_orders WHERE id='0599b759-237d-42af-a4db-4249e70fe4b1';
SELECT id,status,duplicate_of,transfer_amount,approved_order_total FROM public.ac_manual_slip_checks WHERE order_id='0599b759-237d-42af-a4db-4249e70fe4b1';
COMMIT;
