BEGIN;

-- Stored generated columns are computed after BEFORE triggers. NEW.receivable_amount
-- is not available here, so compare its writable inputs (total_amount/billing_details)
-- instead. Keep all existing Marketplace review and correction restrictions.
CREATE OR REPLACE FUNCTION public.guard_marketplace_review_order()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.source_marketplace_order_id IS NOT NULL AND OLD.status='รอตรวจคำสั่งซื้อ'
       AND EXISTS(SELECT 1 FROM public.mp_orders WHERE billed_order_id=OLD.id) THEN
      RAISE EXCEPTION 'บิล Marketplace อยู่ระหว่างรอตรวจคำสั่งซื้อ ไม่สามารถลบบิลได้';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.source_marketplace_order_id IS NOT NULL THEN
    IF NEW.source_marketplace_order_id IS DISTINCT FROM OLD.source_marketplace_order_id THEN
      RAISE EXCEPTION 'ไม่สามารถเปลี่ยนที่มาของบิล Marketplace';
    END IF;
    IF OLD.status='รอตรวจคำสั่งซื้อ' AND
       (to_jsonb(NEW)-ARRAY['status','updated_at','receivable_amount']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','updated_at','receivable_amount']) THEN
      RAISE EXCEPTION 'บิล Marketplace อยู่ระหว่างรอตรวจคำสั่งซื้อ กรุณาตีกลับก่อนแก้ไขข้อมูล';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_marketplace_flagged_header()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_errors jsonb; v_key text;
BEGIN
  IF OLD.source_marketplace_order_id IS NULL OR OLD.status<>'ลงข้อมูลผิด' THEN RETURN NEW; END IF;
  v_errors:=public.marketplace_correction_errors(OLD.id);
  FOR v_key IN SELECT key FROM jsonb_each(to_jsonb(NEW)) LOOP
    IF v_key=ANY(ARRAY['status','updated_at','last_edited_by','entry_date','item_uid_sequence','receivable_amount']) THEN CONTINUE; END IF;
    IF to_jsonb(NEW)->v_key IS NOT DISTINCT FROM to_jsonb(OLD)->v_key THEN CONTINUE; END IF;
    IF v_key=ANY(ARRAY['tracking_number','express_receipt_number']) AND v_errors->>v_key='true' THEN CONTINUE; END IF;
    RAISE EXCEPTION 'แก้ไขได้เฉพาะฟิลด์ที่ผู้ตรวจระบุผิด: %',v_key;
  END LOOP;
  RETURN NEW;
END $$;

COMMIT;
