BEGIN;
-- Preserve total_amount as gross sales/VAT; use receivable_amount for payment coverage.
-- Function bodies copied from the latest migrations noted below.

-- Source: 688_overpayment_customer_waiver.sql / tr_guard_fully_allocated_bank_bill
CREATE OR REPLACE FUNCTION public.tr_guard_fully_allocated_bank_bill() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_bill_no text; v_limit numeric; v_allocated numeric;
BEGIN
 SELECT bill_no,receivable_amount INTO v_bill_no,v_limit FROM or_orders WHERE id=NEW.order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิลที่ต้องการจับคู่'; END IF;
 v_limit:=coalesce(v_limit,0)+public.or_approved_overpayment_amount(NEW.order_id);
 SELECT coalesce(sum(allocated_amount),0) INTO v_allocated FROM ac_bank_reconciliation_allocations
   WHERE order_id=NEW.order_id AND id IS DISTINCT FROM NEW.id;
 IF v_allocated>=v_limit-0.01 THEN
   RAISE EXCEPTION 'เลขบิล % ถูกจับคู่ครบตามยอดที่อนุมัติแล้ว กรุณายกเลิกคู่เดิมก่อนหากต้องการเปลี่ยนรายการ',v_bill_no;
 END IF;
 RETURN NEW;
END $$;

-- Source: 688_overpayment_customer_waiver.sql / bank_reconciliation_bill_match_availability
CREATE OR REPLACE FUNCTION public.bank_reconciliation_bill_match_availability(p_bill_no text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_order public.or_orders; v_allocated numeric; v_limit numeric;
BEGIN
 PERFORM public.bank_reconciliation_require_authorized_role();
 SELECT * INTO v_order FROM or_orders WHERE upper(trim(bill_no))=upper(trim(p_bill_no)) AND status<>'ยกเลิก' LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิล หรือบิลถูกยกเลิก'; END IF;
 SELECT coalesce(sum(allocated_amount),0) INTO v_allocated FROM ac_bank_reconciliation_allocations WHERE order_id=v_order.id;
 v_allocated:=v_allocated+coalesce((SELECT sum(amount) FROM ac_order_receipt_certifications WHERE order_id=v_order.id AND revoked_at IS NULL),0);
 v_limit:=coalesce(v_order.receivable_amount,0)+public.or_approved_overpayment_amount(v_order.id);
 RETURN jsonb_build_object('available',v_allocated<v_limit-0.01,'bill_no',v_order.bill_no,'order_id',v_order.id,
   'bill_amount',v_order.receivable_amount,'allowed_amount',v_limit,'allocated_amount',v_allocated,
   'remaining_amount',greatest(v_limit-v_allocated,0));
END $$;

-- Source: 636_certified_receipt_matching_guards.sql / bank_reconciliation_global_summary
CREATE OR REPLACE FUNCTION public.bank_reconciliation_global_summary()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_unmatched_count BIGINT;
  v_ambiguous_count BIGINT;
  v_missing_payment_count BIGINT;
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();

  SELECT
    COUNT(*) FILTER (WHERE tx.credit_amount > 0 AND tx.reconciliation_status = 'unmatched'),
    COUNT(*) FILTER (WHERE tx.credit_amount > 0 AND tx.reconciliation_status = 'ambiguous')
  INTO v_unmatched_count, v_ambiguous_count
  FROM public.ac_bank_statement_transactions tx;

  SELECT COUNT(*)
  INTO v_missing_payment_count
  FROM (
    SELECT 'verified_slip'::TEXT AS source_type, slip.id AS source_id
    FROM public.ac_verified_slips slip
    JOIN public.or_orders customer_order ON customer_order.id = slip.order_id
    WHERE COALESCE(slip.is_deleted, false) = false
      AND slip.easyslip_date IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM public.ac_order_receipt_certifications c WHERE c.order_id=customer_order.id AND c.revoked_at IS NULL
       HAVING sum(c.amount)+COALESCE((SELECT sum(a.allocated_amount) FROM public.ac_bank_reconciliation_allocations a WHERE a.order_id=customer_order.id),0)>=customer_order.receivable_amount-0.01)
      AND COALESCE(customer_order.status, '') NOT IN ('รอลงข้อมูล', 'ลงข้อมูลผิด', 'ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ', 'ยกเลิก')
      AND NOT EXISTS (
        SELECT 1 FROM public.ac_bank_reconciliation_allocations allocation
        WHERE allocation.verified_slip_id = slip.id
      )
      AND EXISTS (
        SELECT 1
        FROM public.ac_bank_statement_imports statement_import
        JOIN public.bank_settings bank ON bank.id = statement_import.bank_setting_id
        WHERE slip.easyslip_date >= statement_import.period_start::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
          AND slip.easyslip_date < (statement_import.period_end + 1)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
          AND (NULLIF(trim(slip.easyslip_receiver_bank_id), '') IS NULL OR trim(slip.easyslip_receiver_bank_id) = bank.bank_code)
          AND (
            NULLIF(regexp_replace(COALESCE(slip.easyslip_receiver_account, ''), '\D', '', 'g'), '') IS NULL
            OR right(regexp_replace(slip.easyslip_receiver_account, '\D', '', 'g'), 4)
               = right(regexp_replace(bank.account_number, '\D', '', 'g'), 4)
          )
      )
    UNION ALL
    SELECT 'manual_slip'::TEXT AS source_type, manual_slip.id AS source_id
    FROM public.ac_manual_slip_checks manual_slip
    JOIN public.or_orders customer_order ON customer_order.id = manual_slip.order_id
    WHERE manual_slip.status = 'approved'
      AND manual_slip.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      AND manual_slip.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND NOT EXISTS(SELECT 1 FROM public.ac_order_receipt_certifications c WHERE c.order_id=customer_order.id AND c.revoked_at IS NULL
       HAVING sum(c.amount)+COALESCE((SELECT sum(a.allocated_amount) FROM public.ac_bank_reconciliation_allocations a WHERE a.order_id=customer_order.id),0)>=customer_order.receivable_amount-0.01)
      AND COALESCE(customer_order.status, '') <> 'ยกเลิก'
      AND NOT EXISTS (
        SELECT 1 FROM public.ac_bank_reconciliation_allocations allocation
        WHERE allocation.manual_slip_check_id = manual_slip.id
      )
      AND EXISTS (
        SELECT 1
        FROM public.ac_bank_statement_imports statement_import
        JOIN public.bank_settings_channels channel
          ON channel.bank_setting_id = statement_import.bank_setting_id
         AND channel.channel_code = customer_order.channel_code
        WHERE CASE
          WHEN manual_slip.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN manual_slip.transfer_date::DATE
          ELSE NULL
        END BETWEEN statement_import.period_start AND statement_import.period_end
      )
  ) missing;

  RETURN jsonb_build_object(
    'unmatched_count', COALESCE(v_unmatched_count, 0),
    'ambiguous_count', COALESCE(v_ambiguous_count, 0),
    'missing_payment_count', COALESCE(v_missing_payment_count, 0)
  );
END;
$$;

-- Source: 631_manual_payment_duplicate_and_edit_reuse.sql / guard_manual_payment_identity
CREATE OR REPLACE FUNCTION public.guard_manual_payment_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_total numeric; v_duplicate uuid;
BEGIN
 SELECT receivable_amount INTO v_total FROM public.or_orders WHERE id=NEW.order_id FOR UPDATE;
 IF NEW.status IN ('pending','approved') THEN
  IF NEW.duplicate_of IS NOT NULL THEN RAISE EXCEPTION 'รายการซ้ำไม่สามารถนับยอดหรืออนุมัติได้'; END IF;
  SELECT id INTO v_duplicate FROM public.ac_manual_slip_checks
   WHERE order_id=NEW.order_id AND id<>NEW.id AND status IN ('pending','approved')
    AND duplicate_of IS NULL AND trim(transfer_date)=trim(NEW.transfer_date)
    AND trim(transfer_time)=trim(NEW.transfer_time) AND transfer_amount=NEW.transfer_amount
   LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'บิลนี้มีรายการยอดและวันเวลาเดียวกันแล้ว (%) ห้ามส่งหรืออนุมัติซ้ำ',v_duplicate; END IF;
 END IF;
 IF NEW.status='approved' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
  NEW.approved_order_total:=v_total;
 ELSIF TG_OP='UPDATE' THEN
  IF NOT (OLD.approved_order_total IS NULL AND NEW.approved_order_total=v_total) THEN
   NEW.approved_order_total:=OLD.approved_order_total;
  END IF;
 END IF;
 RETURN NEW;
END $$;

-- Source: 631_manual_payment_duplicate_and_edit_reuse.sql / reuse_manual_payment_after_order_edit
CREATE OR REPLACE FUNCTION public.reuse_manual_payment_after_order_edit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_paid numeric; v_owner text;
BEGIN
 IF OLD.status NOT IN ('ลงข้อมูลผิด','รอลงข้อมูล','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ')
  OR NEW.status<>'ลงข้อมูลเสร็จสิ้น' OR NEW.work_order_id IS NOT NULL
  OR NEW.channel_code IS DISTINCT FROM OLD.channel_code
  OR NEW.payment_method IS DISTINCT FROM OLD.payment_method THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.ac_manual_slip_checks WHERE order_id=NEW.id AND status='pending') THEN RETURN NEW; END IF;
 SELECT sum(transfer_amount) INTO v_paid FROM public.ac_manual_slip_checks
 WHERE order_id=NEW.id AND status='approved' AND duplicate_of IS NULL
 AND approved_order_total=public.or_tax_receivable(NEW.total_amount,NEW.billing_details);
 v_paid:=coalesce(v_paid,0)-coalesce((SELECT sum(amount) FROM public.ac_refunds
  WHERE order_id=NEW.id AND status IN ('pending','approved')),0);
 IF coalesce(v_paid,0)<public.or_tax_receivable(NEW.total_amount,NEW.billing_details) OR public.or_tax_receivable(NEW.total_amount,NEW.billing_details)<=0 THEN RETURN NEW; END IF;
 SELECT role INTO v_owner FROM public.us_users
 WHERE username=NEW.admin_user OR email=NEW.admin_user
 ORDER BY (username=NEW.admin_user) DESC NULLS LAST LIMIT 1;
 NEW.status:=CASE
  WHEN upper(trim(NEW.channel_code))='WY' THEN 'ตรวจสอบแล้ว'
  WHEN v_owner='sales-tr' AND ((NEW.channel_code='PUMP' AND NEW.requires_confirm_design=FALSE)
   OR (NEW.channel_code IS DISTINCT FROM 'PUMP' AND coalesce(NEW.requires_confirm_design,FALSE)=FALSE)) THEN 'รอตรวจคำสั่งซื้อ'
  WHEN NEW.channel_code='PUMP' AND NEW.requires_confirm_design=FALSE THEN 'ไม่ต้องออกแบบ'
  ELSE 'ตรวจสอบแล้ว' END;
 RETURN NEW;
END $$;

-- Source: 634_reconciliation_workspace.sql / bank_certify_receipt
CREATE OR REPLACE FUNCTION public.bank_certify_receipt(p_order_id UUID, p_amount NUMERIC, p_method TEXT,
  p_received_on DATE, p_reason TEXT, p_evidence TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id UUID; v_order public.or_orders; v_received NUMERIC;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.us_users WHERE id = auth.uid() AND role = 'superadmin') THEN
    RAISE EXCEPTION 'เฉพาะ superadmin สามารถรับรองเงินรับ';
  END IF;
  SELECT * INTO v_order FROM public.or_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR COALESCE(v_order.status,'') IN ('ยกเลิก','รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ') THEN
    RAISE EXCEPTION 'บิลนี้ไม่สามารถรับรองเงินรับได้';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount,2)
     OR p_received_on IS NULL OR p_received_on > (now() AT TIME ZONE 'Asia/Bangkok')::DATE
     OR NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุยอดเงิน วันที่รับ และเหตุผลให้ถูกต้อง'; END IF;
  SELECT COALESCE((SELECT sum(allocated_amount) FROM public.ac_bank_reconciliation_allocations WHERE order_id=p_order_id),0)
    + COALESCE((SELECT sum(amount) FROM public.ac_order_receipt_certifications WHERE order_id=p_order_id AND revoked_at IS NULL),0)
    INTO v_received;
  IF v_received + p_amount > v_order.receivable_amount + 0.01 THEN RAISE EXCEPTION 'ยอดรับรองเกินยอดค้างของบิล กรุณาตรวจเงินที่จับคู่แล้ว'; END IF;
  INSERT INTO public.ac_order_receipt_certifications(order_id,amount,receipt_method,received_on,reason,evidence_reference,certified_by)
  VALUES(p_order_id,p_amount,p_method,p_received_on,btrim(p_reason),NULLIF(btrim(p_evidence),''),auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Source: 674_sales_discount_approval.sql / bank_sales_workspace
CREATE OR REPLACE FUNCTION public.bank_sales_workspace(p_from DATE DEFAULT NULL,p_to DATE DEFAULT NULL,
 p_status TEXT DEFAULT 'pending',p_search TEXT DEFAULT '',p_channel TEXT DEFAULT '',p_method TEXT DEFAULT '',p_offset INTEGER DEFAULT 0)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_result JSONB;
BEGIN
 PERFORM public.bank_reconciliation_require_authorized_role();
 WITH base AS (
  SELECT o.id,o.bill_no,o.created_at,o.channel_code,o.payment_method,o.total_amount,o.receivable_amount,
   COALESCE(a.amount,0) bank_received,COALESCE(c.amount,0) certified_received,
   COALESCE(s.amount,0)+COALESCE(m.amount,0) evidence_amount,COALESCE(c.cash,0) certified_cash,COALESCE(c.other,0) certified_other,
   s.payment_at,
   CASE WHEN COALESCE(a.amount,0)+COALESCE(c.amount,0)>o.receivable_amount+0.01 THEN 'overpaid'
    WHEN ((upper(COALESCE(o.bill_no,'')) LIKE 'REQ%' AND o.receivable_amount<=0.01) OR (o.payment_not_required AND o.receivable_amount=0))
      AND COALESCE(a.amount,0)+COALESCE(c.amount,0)<=0.01 THEN 'no_payment'
    WHEN COALESCE(a.amount,0)+COALESCE(c.amount,0)>=o.receivable_amount-0.01 THEN CASE WHEN COALESCE(c.amount,0)>0 THEN 'certified' ELSE 'matched' END
    WHEN COALESCE(a.amount,0)+COALESCE(c.amount,0)>0 THEN 'partial'
    WHEN COALESCE(s.amount,0)+COALESCE(m.amount,0)>0 THEN 'waiting_bank' ELSE 'no_evidence' END reconciliation_state,
   CASE WHEN coverage.payment_count=0 OR coverage.has_unknown THEN 'unknown'
    WHEN coverage.uncovered THEN 'not_uploaded' ELSE 'covered' END statement_coverage
  FROM public.or_orders o
  LEFT JOIN LATERAL (SELECT sum(allocated_amount) amount FROM public.ac_bank_reconciliation_allocations WHERE order_id=o.id) a ON TRUE
  LEFT JOIN LATERAL (SELECT sum(amount) amount,sum(amount) FILTER(WHERE receipt_method='cash') cash,sum(amount) FILTER(WHERE receipt_method<>'cash') other FROM public.ac_order_receipt_certifications WHERE order_id=o.id AND revoked_at IS NULL) c ON TRUE
  LEFT JOIN LATERAL (SELECT sum(verified_amount) amount,max(easyslip_date) payment_at,max(NULLIF(easyslip_receiver_account,'')) receiver_account
    FROM public.ac_verified_slips WHERE order_id=o.id AND COALESCE(is_deleted,false)=false AND verified_amount>0 AND easyslip_date IS NOT NULL) s ON TRUE
  LEFT JOIN LATERAL (SELECT sum(transfer_amount) amount,max(CASE WHEN transfer_date ~ '^\d{4}-\d{2}-\d{2}$' THEN transfer_date::DATE END) payment_on
    FROM public.ac_manual_slip_checks WHERE order_id=o.id AND status='approved'
    AND NOT EXISTS (SELECT 1 FROM public.ac_verified_slips vs WHERE vs.order_id=o.id AND COALESCE(vs.is_deleted,false)=false AND vs.easyslip_date IS NOT NULL AND vs.verified_amount>0)) m ON TRUE
  LEFT JOIN LATERAL (
   SELECT count(*) payment_count,bool_or(p.payment_on IS NULL OR NOT EXISTS(
     SELECT 1 FROM public.bank_settings b WHERE
      (p.receiver_account IS NOT NULL AND right(regexp_replace(p.receiver_account,'\D','','g'),4)=right(regexp_replace(b.account_number,'\D','','g'),4)
       AND (p.bank_code IS NULL OR b.bank_code=p.bank_code))
      OR (p.receiver_account IS NULL AND EXISTS(SELECT 1 FROM public.bank_settings_channels bc WHERE bc.bank_setting_id=b.id AND bc.channel_code=o.channel_code))
    )) has_unknown,
    bool_or(EXISTS(SELECT 1 FROM public.bank_settings b WHERE
      ((p.receiver_account IS NOT NULL AND right(regexp_replace(p.receiver_account,'\D','','g'),4)=right(regexp_replace(b.account_number,'\D','','g'),4)
        AND (p.bank_code IS NULL OR b.bank_code=p.bank_code))
       OR (p.receiver_account IS NULL AND EXISTS(SELECT 1 FROM public.bank_settings_channels bc WHERE bc.bank_setting_id=b.id AND bc.channel_code=o.channel_code)))
      AND NOT EXISTS(SELECT 1 FROM public.ac_bank_statement_imports i WHERE i.bank_setting_id=b.id AND p.payment_on BETWEEN i.period_start AND i.period_end)
    )) uncovered
   FROM (
    SELECT (vs.easyslip_date AT TIME ZONE 'Asia/Bangkok')::DATE payment_on,
      NULLIF(regexp_replace(CASE
        WHEN COALESCE(vs.easyslip_receiver_account,'') ~ '[xX*•]' AND NULLIF(btrim(vs.expected_bank_account),'') IS NOT NULL THEN vs.expected_bank_account
        ELSE COALESCE(NULLIF(btrim(vs.easyslip_receiver_account),''),vs.expected_bank_account,'') END,'\D','','g'),'') receiver_account,
      CASE WHEN (COALESCE(vs.easyslip_receiver_account,'') ~ '[xX*•]' OR NULLIF(btrim(vs.easyslip_receiver_account),'') IS NULL)
        AND NULLIF(btrim(vs.expected_bank_account),'') IS NOT NULL
        THEN COALESCE(NULLIF(btrim(vs.expected_bank_code),''),NULLIF(btrim(vs.easyslip_receiver_bank_id),''))
        ELSE NULLIF(btrim(vs.easyslip_receiver_bank_id),'') END bank_code
    FROM public.ac_verified_slips vs WHERE vs.order_id=o.id AND COALESCE(vs.is_deleted,false)=false AND vs.verified_amount>0 AND vs.easyslip_date IS NOT NULL
    UNION ALL
    SELECT CASE WHEN ms.transfer_date ~ '^\d{4}-\d{2}-\d{2}$' THEN ms.transfer_date::DATE END,NULL::TEXT,NULL::TEXT
    FROM public.ac_manual_slip_checks ms WHERE ms.order_id=o.id AND ms.status='approved'
   ) p
  ) coverage ON TRUE
  WHERE COALESCE(o.status,'') NOT IN ('ยกเลิก','รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ')
   AND COALESCE(o.channel_code,'') NOT IN ('SPTR','FSPTR','TTTR','LZTR','PGTR','WY')
   AND o.created_at >= TIMESTAMPTZ '2026-10-01 00:00:00+07'
   AND (p_from IS NULL OR o.created_at >= p_from::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
   AND (p_to IS NULL OR o.created_at < (p_to+1)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
   AND (p_channel='' OR o.channel_code=p_channel) AND (p_method='' OR COALESCE(o.payment_method,'')=p_method)
   AND (p_search='' OR strpos(lower(o.bill_no),lower(p_search))>0)
 ), filtered AS (SELECT * FROM base WHERE p_status='all' OR reconciliation_state=p_status
   OR p_status='pending' AND reconciliation_state IN ('partial','waiting_bank','no_evidence','overpaid')),
 page AS (SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT 50 OFFSET greatest(p_offset,0))
 SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]'::JSONB),
  'count',(SELECT count(*) FROM filtered),'summary',(SELECT jsonb_build_object('bills',count(*),'sales',COALESCE(sum(total_amount),0),
   'bank',COALESCE(sum(bank_received),0),'certified',COALESCE(sum(certified_received),0),'cash',COALESCE(sum(certified_cash),0),'other_certified',COALESCE(sum(certified_other),0),'outstanding',COALESCE(sum(greatest(receivable_amount-bank_received-certified_received,0)),0)) FROM base),
  'channels',(SELECT COALESCE(jsonb_agg(channel_code),'[]'::JSONB) FROM (SELECT DISTINCT channel_code FROM public.or_orders WHERE COALESCE(channel_code,'') NOT IN ('SPTR','FSPTR','TTTR','LZTR','PGTR','WY') AND created_at >= TIMESTAMPTZ '2026-10-01 00:00:00+07' AND COALESCE(status,'') NOT IN ('ยกเลิก','รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ') ORDER BY channel_code) channels),
  'states',COALESCE((SELECT jsonb_object_agg(reconciliation_state,n) FROM (SELECT reconciliation_state,count(*) n FROM base GROUP BY reconciliation_state) counts),'{}'::JSONB)) INTO v_result;
 RETURN v_result;
END $$;

-- Source: 688_overpayment_customer_waiver.sql / tr_guard_bank_certified_allocation
CREATE OR REPLACE FUNCTION public.tr_guard_bank_certified_allocation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_total numeric; v_cert numeric; v_bank numeric;
BEGIN
 SELECT receivable_amount INTO v_total FROM or_orders WHERE id=NEW.order_id FOR UPDATE;
 SELECT coalesce(sum(amount),0) INTO v_cert FROM ac_order_receipt_certifications WHERE order_id=NEW.order_id AND revoked_at IS NULL;
 IF v_cert>0 THEN
  SELECT coalesce(sum(allocated_amount),0) INTO v_bank FROM ac_bank_reconciliation_allocations WHERE order_id=NEW.order_id AND id<>NEW.id;
  IF v_cert+v_bank+NEW.allocated_amount>v_total+public.or_approved_overpayment_amount(NEW.order_id)+0.01 THEN
    RAISE EXCEPTION 'บิลมีการรับรองเงินรับแล้ว กรุณายกเลิกหรือปรับการรับรองก่อนจับคู่เพื่อไม่ให้นับเงินซ้ำ';
  END IF;
 END IF;
 RETURN NEW;
END $$;

-- Source: 671_bank_import_matching_isolation_and_coverage.sql / bank_statement_auto_match_authorized_impl
CREATE OR REPLACE FUNCTION public.bank_statement_auto_match_authorized_impl(p_import_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_tx RECORD;
  v_candidate_count INTEGER;
  v_exact_count INTEGER;
  v_sender_count INTEGER;
  v_source_kind TEXT;
  v_source_id UUID;
  v_order_id UUID;
  v_is_exact BOOLEAN;
  v_sender_match BOOLEAN;
  v_matched INTEGER := 0;
  v_ambiguous INTEGER := 0;
  v_skipped INTEGER := 0;
  v_inserted INTEGER;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์กระทบยอดธนาคาร';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ac_bank_statement_imports WHERE id = p_import_id) THEN
    RAISE EXCEPTION 'ไม่พบรอบ Statement';
  END IF;

  FOR v_tx IN
    SELECT
      t.*,
      b.bank_code,
      b.account_number,
      substring(COALESCE(t.description, '') FROM 'X([0-9]{3,})') AS statement_sender_suffix
    FROM public.ac_bank_statement_transactions t
    JOIN public.bank_settings b ON b.id = t.bank_setting_id
    WHERE t.import_id = p_import_id
      AND t.credit_amount > 0
      AND t.reconciliation_status <> 'ignored'
      AND NOT EXISTS (
        SELECT 1 FROM public.ac_bank_reconciliation_allocations a WHERE a.transaction_id = t.id
      )
    ORDER BY t.transaction_at, t.id
    FOR UPDATE OF t SKIP LOCKED
  LOOP
    WITH candidates AS (
      SELECT
        'verified'::TEXT AS source_kind,
        s.id AS source_id,
        s.order_id,
        ABS(EXTRACT(EPOCH FROM (s.easyslip_date - v_tx.transaction_at))) AS time_diff_seconds,
        date_trunc('minute', s.easyslip_date) = date_trunc('minute', v_tx.transaction_at) AS is_exact,
        CASE
          WHEN NULLIF(v_tx.statement_sender_suffix, '') IS NULL THEN FALSE
          ELSE right(
            regexp_replace(
              COALESCE(
                s.easyslip_response #>> '{data,sender,account,bank,account}',
                s.easyslip_response #>> '{data,from,account,bank,account}',
                s.easyslip_response #>> '{data,from,account,account}',
                ''
              ),
              '\D', '', 'g'
            ),
            length(v_tx.statement_sender_suffix)
          ) = v_tx.statement_sender_suffix
        END AS sender_match
      FROM public.ac_verified_slips s
      JOIN public.or_orders o ON o.id = s.order_id
      WHERE COALESCE(s.is_deleted, false) = false
        AND NOT EXISTS (SELECT 1 FROM public.ac_order_receipt_certifications c WHERE c.order_id=o.id AND c.revoked_at IS NULL
          HAVING sum(c.amount) + COALESCE((SELECT sum(a.allocated_amount) FROM public.ac_bank_reconciliation_allocations a WHERE a.order_id=o.id),0) + v_tx.credit_amount > o.receivable_amount + 0.01)
        AND COALESCE(o.status, '') NOT IN ('รอลงข้อมูล', 'ลงข้อมูลผิด', 'ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ', 'ยกเลิก')
        AND public.bank_auto_match_order_has_capacity(o.id,v_tx.credit_amount)
        AND s.easyslip_date >= v_tx.transaction_at - INTERVAL '10 minutes'
        AND s.easyslip_date <= v_tx.transaction_at + INTERVAL '10 minutes'
        AND ABS(s.verified_amount - v_tx.credit_amount) <= 0.01
        AND (
          (
            (NULLIF(trim(s.easyslip_receiver_bank_id), '') IS NULL OR trim(s.easyslip_receiver_bank_id) = v_tx.bank_code)
            AND (
              NULLIF(regexp_replace(COALESCE(s.easyslip_receiver_account, ''), '\D', '', 'g'), '') IS NULL
              OR right(regexp_replace(s.easyslip_receiver_account, '\D', '', 'g'), 4)
                 = right(regexp_replace(v_tx.account_number, '\D', '', 'g'), 4)
            )
          )
          OR (
            trim(COALESCE(s.expected_bank_code, '')) = v_tx.bank_code
            AND right(regexp_replace(COALESCE(s.expected_bank_account, ''), '\D', '', 'g'), 4)
                = right(regexp_replace(v_tx.account_number, '\D', '', 'g'), 4)
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.ac_bank_reconciliation_allocations used
          WHERE used.verified_slip_id = s.id
        )
      UNION ALL
      SELECT
        'manual'::TEXT AS source_kind,
        m.id AS source_id,
        m.order_id,
        ABS(EXTRACT(EPOCH FROM (
          ((m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok') - v_tx.transaction_at
        ))) AS time_diff_seconds,
        date_trunc('minute', (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
          = date_trunc('minute', v_tx.transaction_at) AS is_exact,
        FALSE AS sender_match
      FROM public.ac_manual_slip_checks m
      JOIN public.or_orders o ON o.id = m.order_id
      WHERE m.status = 'approved'
        AND m.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND m.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND NOT EXISTS (SELECT 1 FROM public.ac_order_receipt_certifications c WHERE c.order_id=o.id AND c.revoked_at IS NULL
          HAVING sum(c.amount) + COALESCE((SELECT sum(a.allocated_amount) FROM public.ac_bank_reconciliation_allocations a WHERE a.order_id=o.id),0) + v_tx.credit_amount > o.receivable_amount + 0.01)
        AND COALESCE(o.status, '') <> 'ยกเลิก'
        AND public.bank_auto_match_order_has_capacity(o.id,v_tx.credit_amount)
        AND (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
              >= v_tx.transaction_at - INTERVAL '10 minutes'
        AND (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
              <= v_tx.transaction_at + INTERVAL '10 minutes'
        AND ABS(m.transfer_amount - v_tx.credit_amount) <= 0.01
        AND EXISTS (
          SELECT 1 FROM public.bank_settings_channels bsc
          WHERE bsc.bank_setting_id = v_tx.bank_setting_id
            AND bsc.channel_code = o.channel_code
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.ac_bank_reconciliation_allocations used
          WHERE used.manual_slip_check_id = m.id
        )
    ), stats AS (
      SELECT
        COUNT(*)::INTEGER AS candidate_count,
        COUNT(*) FILTER (WHERE is_exact)::INTEGER AS exact_count,
        COUNT(*) FILTER (WHERE sender_match)::INTEGER AS sender_count
      FROM candidates
    ), selected AS (
      SELECT c.*
      FROM candidates c
      CROSS JOIN stats s
      WHERE (s.exact_count = 1 AND c.is_exact)
         OR (s.exact_count <> 1 AND s.sender_count = 1 AND c.sender_match)
         OR (s.exact_count = 0 AND s.sender_count <> 1 AND s.candidate_count = 1)
      ORDER BY
        CASE WHEN c.is_exact THEN 0 WHEN c.sender_match THEN 1 ELSE 2 END,
        c.time_diff_seconds,
        c.source_kind,
        c.source_id
      LIMIT 1
    )
    SELECT
      stats.candidate_count,
      stats.exact_count,
      stats.sender_count,
      selected.source_kind,
      selected.source_id,
      selected.order_id,
      selected.is_exact,
      selected.sender_match
    INTO
      v_candidate_count,
      v_exact_count,
      v_sender_count,
      v_source_kind,
      v_source_id,
      v_order_id,
      v_is_exact,
      v_sender_match
    FROM stats
    LEFT JOIN selected ON TRUE;

    IF v_source_id IS NOT NULL THEN
      BEGIN
      PERFORM 1 FROM public.or_orders WHERE id=v_order_id FOR UPDATE;
      -- Recheck capacity after acquiring the same order lock as the allocation guards.
      IF NOT public.bank_auto_match_order_has_capacity(v_order_id,v_tx.credit_amount) THEN
        UPDATE public.ac_bank_statement_transactions SET reconciliation_status='unmatched' WHERE id=v_tx.id;
        v_skipped:=v_skipped+1;
        CONTINUE;
      END IF;
      INSERT INTO public.ac_bank_reconciliation_allocations (
        transaction_id, order_id, verified_slip_id, manual_slip_check_id,
        allocated_amount, match_method, matched_by
      ) VALUES (
        v_tx.id,
        v_order_id,
        CASE WHEN v_source_kind = 'verified' THEN v_source_id ELSE NULL END,
        CASE WHEN v_source_kind = 'manual' THEN v_source_id ELSE NULL END,
        v_tx.credit_amount,
        CASE
          WHEN v_source_kind = 'verified' AND v_is_exact THEN 'exact_verified_slip'
          WHEN v_source_kind = 'manual' AND v_is_exact THEN 'exact_manual_slip'
          WHEN v_source_kind = 'verified' AND v_sender_match THEN 'sender_confirmed_verified_slip'
          WHEN v_source_kind = 'verified' THEN 'time_tolerant_verified_slip'
          ELSE 'time_tolerant_manual_slip'
        END,
        auth.uid()
      ) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_inserted=ROW_COUNT;
      IF v_inserted>0 THEN
        UPDATE public.ac_bank_statement_transactions SET reconciliation_status='matched' WHERE id=v_tx.id;
        v_matched:=v_matched+1;
      END IF;
      EXCEPTION WHEN SQLSTATE 'P0001' OR unique_violation OR check_violation THEN
        UPDATE public.ac_bank_statement_transactions SET reconciliation_status='unmatched' WHERE id=v_tx.id;
        v_skipped:=v_skipped+1;
        UPDATE public.ac_bank_statement_imports SET warnings=COALESCE(warnings,'[]'::jsonb)||jsonb_build_array(
          jsonb_build_object('code','auto_match_skipped','transaction_id',v_tx.id,'message',SQLERRM)) WHERE id=v_tx.import_id;
      END;
    ELSIF v_candidate_count > 1 THEN
      UPDATE public.ac_bank_statement_transactions
      SET reconciliation_status = 'ambiguous'
      WHERE id = v_tx.id;
      v_ambiguous := v_ambiguous + 1;
    ELSE
      UPDATE public.ac_bank_statement_transactions
      SET reconciliation_status = 'unmatched'
      WHERE id = v_tx.id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'matched', v_matched,
    'skipped', v_skipped,
    'ambiguous', v_ambiguous,
    'time_tolerance_minutes', 10,
    'supports_split_payment', true
  );
END;
$$;

-- Source: 671_bank_import_matching_isolation_and_coverage.sql / bank_workspace_auto_match
CREATE OR REPLACE FUNCTION public.bank_workspace_auto_match(p_from DATE DEFAULT NULL, p_to DATE DEFAULT NULL, p_bank UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_tx RECORD;
  v_candidate_count INTEGER;
  v_exact_count INTEGER;
  v_sender_count INTEGER;
  v_source_kind TEXT;
  v_source_id UUID;
  v_order_id UUID;
  v_is_exact BOOLEAN;
  v_sender_match BOOLEAN;
  v_matched INTEGER := 0;
  v_ambiguous INTEGER := 0;
  v_skipped INTEGER := 0;
  v_inserted INTEGER;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์กระทบยอดธนาคาร';
  END IF;
  PERFORM public.bank_reconciliation_require_authorized_role();

  FOR v_tx IN
    SELECT
      t.*,
      b.bank_code,
      b.account_number,
      substring(COALESCE(t.description, '') FROM 'X([0-9]{3,})') AS statement_sender_suffix
    FROM public.ac_bank_statement_transactions t
    JOIN public.bank_settings b ON b.id = t.bank_setting_id
    WHERE (p_from IS NULL OR t.transaction_at >= p_from::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
      AND (p_to IS NULL OR t.transaction_at < (p_to+1)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
      AND (p_bank IS NULL OR t.bank_setting_id=p_bank)
      AND t.credit_amount > 0
      AND t.reconciliation_status <> 'ignored'
      AND NOT EXISTS (
        SELECT 1 FROM public.ac_bank_reconciliation_allocations a WHERE a.transaction_id = t.id
      )
    ORDER BY t.transaction_at, t.id
    FOR UPDATE OF t SKIP LOCKED
  LOOP
    WITH candidates AS (
      SELECT
        'verified'::TEXT AS source_kind,
        s.id AS source_id,
        s.order_id,
        ABS(EXTRACT(EPOCH FROM (s.easyslip_date - v_tx.transaction_at))) AS time_diff_seconds,
        date_trunc('minute', s.easyslip_date) = date_trunc('minute', v_tx.transaction_at) AS is_exact,
        CASE
          WHEN NULLIF(v_tx.statement_sender_suffix, '') IS NULL THEN FALSE
          ELSE right(
            regexp_replace(
              COALESCE(
                s.easyslip_response #>> '{data,sender,account,bank,account}',
                s.easyslip_response #>> '{data,from,account,bank,account}',
                s.easyslip_response #>> '{data,from,account,account}',
                ''
              ),
              '\D', '', 'g'
            ),
            length(v_tx.statement_sender_suffix)
          ) = v_tx.statement_sender_suffix
        END AS sender_match
      FROM public.ac_verified_slips s
      JOIN public.or_orders o ON o.id = s.order_id
      WHERE COALESCE(s.is_deleted, false) = false
        AND NOT EXISTS (SELECT 1 FROM public.ac_order_receipt_certifications c WHERE c.order_id=o.id AND c.revoked_at IS NULL
          HAVING sum(c.amount) + COALESCE((SELECT sum(a.allocated_amount) FROM public.ac_bank_reconciliation_allocations a WHERE a.order_id=o.id),0) + v_tx.credit_amount > o.receivable_amount + 0.01)
        AND COALESCE(o.status, '') NOT IN ('รอลงข้อมูล', 'ลงข้อมูลผิด', 'ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ', 'ยกเลิก')
        AND public.bank_auto_match_order_has_capacity(o.id,v_tx.credit_amount)
        AND s.easyslip_date >= v_tx.transaction_at - INTERVAL '10 minutes'
        AND s.easyslip_date <= v_tx.transaction_at + INTERVAL '10 minutes'
        AND ABS(s.verified_amount - v_tx.credit_amount) <= 0.01
        AND (
          (
            (NULLIF(trim(s.easyslip_receiver_bank_id), '') IS NULL OR trim(s.easyslip_receiver_bank_id) = v_tx.bank_code)
            AND (
              NULLIF(regexp_replace(COALESCE(s.easyslip_receiver_account, ''), '\D', '', 'g'), '') IS NULL
              OR right(regexp_replace(s.easyslip_receiver_account, '\D', '', 'g'), 4)
                 = right(regexp_replace(v_tx.account_number, '\D', '', 'g'), 4)
            )
          )
          OR (
            trim(COALESCE(s.expected_bank_code, '')) = v_tx.bank_code
            AND right(regexp_replace(COALESCE(s.expected_bank_account, ''), '\D', '', 'g'), 4)
                = right(regexp_replace(v_tx.account_number, '\D', '', 'g'), 4)
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.ac_bank_reconciliation_allocations used
          WHERE used.verified_slip_id = s.id
        )
      UNION ALL
      SELECT
        'manual'::TEXT AS source_kind,
        m.id AS source_id,
        m.order_id,
        ABS(EXTRACT(EPOCH FROM (
          ((m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok') - v_tx.transaction_at
        ))) AS time_diff_seconds,
        date_trunc('minute', (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
          = date_trunc('minute', v_tx.transaction_at) AS is_exact,
        FALSE AS sender_match
      FROM public.ac_manual_slip_checks m
      JOIN public.or_orders o ON o.id = m.order_id
      WHERE m.status = 'approved'
        AND m.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND m.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND NOT EXISTS (SELECT 1 FROM public.ac_order_receipt_certifications c WHERE c.order_id=o.id AND c.revoked_at IS NULL
          HAVING sum(c.amount) + COALESCE((SELECT sum(a.allocated_amount) FROM public.ac_bank_reconciliation_allocations a WHERE a.order_id=o.id),0) + v_tx.credit_amount > o.receivable_amount + 0.01)
        AND COALESCE(o.status, '') <> 'ยกเลิก'
        AND public.bank_auto_match_order_has_capacity(o.id,v_tx.credit_amount)
        AND (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
              >= v_tx.transaction_at - INTERVAL '10 minutes'
        AND (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
              <= v_tx.transaction_at + INTERVAL '10 minutes'
        AND ABS(m.transfer_amount - v_tx.credit_amount) <= 0.01
        AND EXISTS (
          SELECT 1 FROM public.bank_settings_channels bsc
          WHERE bsc.bank_setting_id = v_tx.bank_setting_id
            AND bsc.channel_code = o.channel_code
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.ac_bank_reconciliation_allocations used
          WHERE used.manual_slip_check_id = m.id
        )
    ), stats AS (
      SELECT
        COUNT(*)::INTEGER AS candidate_count,
        COUNT(*) FILTER (WHERE is_exact)::INTEGER AS exact_count,
        COUNT(*) FILTER (WHERE sender_match)::INTEGER AS sender_count
      FROM candidates
    ), selected AS (
      SELECT c.*
      FROM candidates c
      CROSS JOIN stats s
      WHERE (s.exact_count = 1 AND c.is_exact)
         OR (s.exact_count <> 1 AND s.sender_count = 1 AND c.sender_match)
         OR (s.exact_count = 0 AND s.sender_count <> 1 AND s.candidate_count = 1)
      ORDER BY
        CASE WHEN c.is_exact THEN 0 WHEN c.sender_match THEN 1 ELSE 2 END,
        c.time_diff_seconds,
        c.source_kind,
        c.source_id
      LIMIT 1
    )
    SELECT
      stats.candidate_count,
      stats.exact_count,
      stats.sender_count,
      selected.source_kind,
      selected.source_id,
      selected.order_id,
      selected.is_exact,
      selected.sender_match
    INTO
      v_candidate_count,
      v_exact_count,
      v_sender_count,
      v_source_kind,
      v_source_id,
      v_order_id,
      v_is_exact,
      v_sender_match
    FROM stats
    LEFT JOIN selected ON TRUE;

    IF v_source_id IS NOT NULL THEN
      BEGIN
      PERFORM 1 FROM public.or_orders WHERE id=v_order_id FOR UPDATE;
      -- Recheck capacity after acquiring the same order lock as the allocation guards.
      IF NOT public.bank_auto_match_order_has_capacity(v_order_id,v_tx.credit_amount) THEN
        UPDATE public.ac_bank_statement_transactions SET reconciliation_status='unmatched' WHERE id=v_tx.id;
        v_skipped:=v_skipped+1;
        CONTINUE;
      END IF;
      INSERT INTO public.ac_bank_reconciliation_allocations (
        transaction_id, order_id, verified_slip_id, manual_slip_check_id,
        allocated_amount, match_method, matched_by
      ) VALUES (
        v_tx.id,
        v_order_id,
        CASE WHEN v_source_kind = 'verified' THEN v_source_id ELSE NULL END,
        CASE WHEN v_source_kind = 'manual' THEN v_source_id ELSE NULL END,
        v_tx.credit_amount,
        CASE
          WHEN v_source_kind = 'verified' AND v_is_exact THEN 'exact_verified_slip'
          WHEN v_source_kind = 'manual' AND v_is_exact THEN 'exact_manual_slip'
          WHEN v_source_kind = 'verified' AND v_sender_match THEN 'sender_confirmed_verified_slip'
          WHEN v_source_kind = 'verified' THEN 'time_tolerant_verified_slip'
          ELSE 'time_tolerant_manual_slip'
        END,
        auth.uid()
      ) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_inserted=ROW_COUNT;
      IF v_inserted>0 THEN
        UPDATE public.ac_bank_statement_transactions SET reconciliation_status='matched' WHERE id=v_tx.id;
        v_matched:=v_matched+1;
      END IF;
      EXCEPTION WHEN SQLSTATE 'P0001' OR unique_violation OR check_violation THEN
        UPDATE public.ac_bank_statement_transactions SET reconciliation_status='unmatched' WHERE id=v_tx.id;
        v_skipped:=v_skipped+1;
        UPDATE public.ac_bank_statement_imports SET warnings=COALESCE(warnings,'[]'::jsonb)||jsonb_build_array(
          jsonb_build_object('code','auto_match_skipped','transaction_id',v_tx.id,'message',SQLERRM)) WHERE id=v_tx.import_id;
      END;
    ELSIF v_candidate_count > 1 THEN
      UPDATE public.ac_bank_statement_transactions
      SET reconciliation_status = 'ambiguous'
      WHERE id = v_tx.id;
      v_ambiguous := v_ambiguous + 1;
    ELSE
      UPDATE public.ac_bank_statement_transactions
      SET reconciliation_status = 'unmatched'
      WHERE id = v_tx.id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'matched', v_matched,
    'skipped', v_skipped,
    'ambiguous', v_ambiguous,
    'time_tolerance_minutes', 10,
    'supports_split_payment', true
  );
END;
$$;

-- Source: 688_overpayment_customer_waiver.sql / or_refund_production_block
CREATE OR REPLACE FUNCTION public.or_refund_production_block(p_order_id uuid,p_total numeric)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_latest record; v_remaining numeric;
BEGIN
  IF EXISTS(SELECT 1 FROM ac_refunds WHERE order_id=p_order_id AND status='pending') THEN RETURN 'รออนุมัติคำขอโอนคืน'; END IF;
  IF EXISTS(SELECT 1 FROM ac_overpayment_waivers WHERE order_id=p_order_id AND status='pending') THEN RETURN 'รอบัญชีรับรองลูกค้าไม่รับเงินคืน'; END IF;
  SELECT * INTO v_latest FROM (
    SELECT status,rejected_reason,created_at,id FROM ac_refunds WHERE order_id=p_order_id
    UNION ALL SELECT status,rejected_reason,created_at,id FROM ac_overpayment_waivers WHERE order_id=p_order_id
  ) r ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_latest.status='rejected' THEN RETURN 'คำขอจัดการยอดเกินถูกปฏิเสธ: '||coalesce(v_latest.rejected_reason,'กรุณาแก้ไขและส่งคำขอใหม่'); END IF;
  -- p_total may be public.or_tax_receivable(NEW.total_amount,NEW.billing_details) in a BEFORE trigger, before the row is stored.
  SELECT receivable_amount INTO p_total FROM public.or_orders WHERE id=p_order_id;
  v_remaining:=public.or_overpayment_paid(p_order_id)-coalesce(p_total,0)
    -coalesce((SELECT sum(amount) FROM ac_refunds WHERE order_id=p_order_id AND status='approved' AND reason ILIKE '%โอนเกิน%'),0)
    -coalesce((SELECT sum(amount) FROM ac_overpayment_waivers WHERE order_id=p_order_id AND status='approved'
      AND order_total=p_total AND paid_amount=public.or_overpayment_paid(p_order_id)),0);
  IF v_remaining>0.01 THEN RETURN 'พบยอดโอนเกิน '||to_char(v_remaining,'FM999999999990.00')||' บาท ยังไม่ได้รับอนุมัติการจัดการยอดเกิน'; END IF;
  RETURN NULL;
END $$;

-- Source: 688_overpayment_customer_waiver.sql / bank_auto_match_order_has_capacity
CREATE OR REPLACE FUNCTION public.bank_auto_match_order_has_capacity(p_order_id uuid,p_amount numeric)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM or_orders o WHERE o.id=p_order_id
  AND coalesce(o.status,'') NOT IN ('รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ','ยกเลิก')
  AND coalesce((SELECT sum(allocated_amount) FROM ac_bank_reconciliation_allocations WHERE order_id=o.id),0)
    +coalesce((SELECT sum(amount) FROM ac_order_receipt_certifications WHERE order_id=o.id AND revoked_at IS NULL),0)
    <o.receivable_amount+public.or_approved_overpayment_amount(o.id)-0.01
  AND coalesce((SELECT sum(allocated_amount) FROM ac_bank_reconciliation_allocations WHERE order_id=o.id),0)
    +coalesce((SELECT sum(amount) FROM ac_order_receipt_certifications WHERE order_id=o.id AND revoked_at IS NULL),0)
    +p_amount<=o.receivable_amount+public.or_approved_overpayment_amount(o.id)+0.01)
$$;

-- Source: 689_optional_overpayment_waiver_evidence.sql / submit_overpayment_waiver
CREATE OR REPLACE FUNCTION public.submit_overpayment_waiver(p_order_id uuid,p_reason text,p_evidence_url text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_order public.or_orders; v_user public.us_users; v_paid numeric; v_amount numeric; v_id uuid; v_owner_role text; v_next text;
BEGIN
  SELECT * INTO v_user FROM us_users WHERE id=auth.uid();
  IF v_user.role IS NULL OR v_user.role NOT IN ('superadmin','admin','admin-tr','account','order_staff','sales-tr','sales-pump') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ส่งคำขอไม่รับเงินคืน';
  END IF;
  IF nullif(trim(p_reason),'') IS NULL OR length(p_reason)>1000 THEN
    RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ลูกค้าไม่รับเงินคืน (ไม่เกิน 1,000 ตัวอักษร)';
  END IF;
  IF nullif(trim(p_evidence_url),'') IS NOT NULL
    AND trim(p_evidence_url) !~ '^https?://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'กรุณากรอกลิงก์หลักฐานให้ถูกต้อง โดยขึ้นต้นด้วย https:// หรือ http://';
  END IF;
  SELECT * INTO v_order FROM or_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิล'; END IF;
  IF v_user.role IN ('sales-tr','sales-pump') AND v_order.admin_user IS DISTINCT FROM v_user.username
    AND v_order.admin_user IS DISTINCT FROM v_user.email THEN RAISE EXCEPTION 'ไม่มีสิทธิ์จัดการบิลนี้'; END IF;
  IF v_order.status='ยกเลิก' THEN RAISE EXCEPTION 'บิลถูกยกเลิกแล้ว'; END IF;
  PERFORM public.or_supersede_stale_waivers(p_order_id);
  IF EXISTS(SELECT 1 FROM ac_refunds WHERE order_id=p_order_id AND status IN ('pending','approved') AND reason ILIKE '%โอนเกิน%') THEN
    RAISE EXCEPTION 'บิลนี้มีคำขอโอนคืนแล้ว กรุณาจัดการคำขอเดิมก่อน';
  END IF;
  IF EXISTS(SELECT 1 FROM ac_overpayment_waivers WHERE order_id=p_order_id AND status IN ('pending','approved')) THEN
    RAISE EXCEPTION 'บิลนี้มีคำขอไม่รับเงินคืนที่รอพิจารณาหรืออนุมัติแล้ว';
  END IF;
  v_paid:=public.or_overpayment_paid(p_order_id); v_amount:=v_paid-v_order.receivable_amount;
  IF v_amount<=0.01 THEN RAISE EXCEPTION 'ไม่พบยอดโอนเกินที่ต้องจัดการ'; END IF;
  INSERT INTO ac_overpayment_waivers(order_id,amount,order_total,paid_amount,reason,evidence_url,created_by,created_by_name)
    VALUES(p_order_id,v_amount,v_order.receivable_amount,v_paid,trim(p_reason),nullif(trim(p_evidence_url),''),auth.uid(),coalesce(v_user.username,v_user.email,v_user.id::text)) RETURNING id INTO v_id;
  SELECT role INTO v_owner_role FROM us_users WHERE username=v_order.admin_user OR email=v_order.admin_user
    ORDER BY (username=v_order.admin_user) DESC NULLS LAST LIMIT 1;
  v_next:=CASE WHEN upper(trim(v_order.channel_code))='WY' THEN 'ตรวจสอบแล้ว'
    WHEN v_owner_role='sales-tr' AND ((v_order.channel_code='PUMP' AND v_order.requires_confirm_design=FALSE)
      OR (v_order.channel_code IS DISTINCT FROM 'PUMP' AND coalesce(v_order.requires_confirm_design,FALSE)=FALSE)) THEN 'รอตรวจคำสั่งซื้อ'
    WHEN v_order.channel_code='PUMP' AND v_order.requires_confirm_design=FALSE THEN 'ไม่ต้องออกแบบ'
    ELSE 'ตรวจสอบแล้ว' END;
  PERFORM public.or_apply_payment_review_status(p_order_id,v_next,'overpayment_request');
  RETURN v_id;
END $$;

-- Source: 688_overpayment_customer_waiver.sql / decide_overpayment_waiver
CREATE OR REPLACE FUNCTION public.decide_overpayment_waiver(p_id uuid,p_action text,p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_order_id uuid; v_order public.or_orders; v_request public.ac_overpayment_waivers;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role IN ('superadmin','account','admin','admin-tr')) THEN
    RAISE EXCEPTION 'เฉพาะบัญชีหรือผู้ดูแลเท่านั้นที่พิจารณาได้';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'ผลการพิจารณาไม่ถูกต้อง'; END IF;
  IF p_action='rejected' AND nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ไม่อนุมัติ'; END IF;
  SELECT order_id INTO v_order_id FROM ac_overpayment_waivers WHERE id=p_id;
  SELECT * INTO v_order FROM or_orders WHERE id=v_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำขอ'; END IF;
  SELECT * INTO v_request FROM ac_overpayment_waivers WHERE id=p_id FOR UPDATE;
  IF v_request.status<>'pending' THEN RAISE EXCEPTION 'คำขอนี้ถูกพิจารณาแล้ว กรุณารีเฟรช'; END IF;
  IF p_action='approved' THEN
    IF v_order.status='ยกเลิก' OR v_request.order_total<>v_order.receivable_amount
      OR v_request.paid_amount<>public.or_overpayment_paid(v_order_id)
      OR v_request.amount<>v_request.paid_amount-v_order.receivable_amount THEN
      RAISE EXCEPTION 'ยอดบิลหรือยอดรับเปลี่ยนแปลง กรุณาปฏิเสธและให้ฝ่ายขายส่งคำขอใหม่';
    END IF;
    IF EXISTS(SELECT 1 FROM ac_refunds WHERE order_id=v_order_id AND status IN ('pending','approved') AND reason ILIKE '%โอนเกิน%') THEN
      RAISE EXCEPTION 'บิลนี้มีคำขอโอนคืนที่ยังใช้งานอยู่';
    END IF;
  END IF;
  UPDATE ac_overpayment_waivers SET status=p_action,reviewed_by=auth.uid(),reviewed_at=now(),
    reviewed_by_name=(SELECT coalesce(username,email,id::text) FROM us_users WHERE id=auth.uid()),
    rejected_reason=CASE WHEN p_action='rejected' THEN trim(p_reason) END WHERE id=p_id;
END $$;

-- Source: 688_overpayment_customer_waiver.sql / or_approved_waiver_amount
CREATE OR REPLACE FUNCTION public.or_approved_waiver_amount(p_order_id uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(sum(w.amount),0) FROM ac_overpayment_waivers w JOIN or_orders o ON o.id=w.order_id
 WHERE w.order_id=p_order_id AND w.status='approved' AND w.order_total=o.receivable_amount
   AND w.paid_amount=public.or_overpayment_paid(o.id)
$$;

-- Source: 688_overpayment_customer_waiver.sql / or_supersede_stale_waivers
CREATE OR REPLACE FUNCTION public.or_supersede_stale_waivers(p_order_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 UPDATE ac_overpayment_waivers w SET status='superseded',invalidated_at=now()
 FROM or_orders o WHERE w.order_id=o.id AND w.order_id=p_order_id AND w.status='approved'
  AND (w.order_total<>o.receivable_amount OR w.paid_amount<>public.or_overpayment_paid(o.id))
$$;

-- Source: 662_bank_overpayment_refund_matching.sql / bank_overpayment_refunds_before_waiver
CREATE OR REPLACE FUNCTION public.bank_overpayment_refunds_before_waiver(p_order_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_excess NUMERIC; v_matched NUMERIC; v_result JSONB;
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();
  SELECT greatest(0,
    COALESCE((SELECT sum(allocated_amount) FROM public.ac_bank_reconciliation_allocations WHERE order_id=o.id),0)
    + COALESCE((SELECT sum(amount) FROM public.ac_order_receipt_certifications WHERE order_id=o.id AND revoked_at IS NULL),0)
    - o.receivable_amount) INTO v_excess FROM public.or_orders o WHERE o.id=p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิล'; END IF;
  SELECT COALESCE(sum(r.amount),0) INTO v_matched FROM public.ac_bank_overpayment_refund_matches m
    JOIN public.ac_refunds r ON r.id=m.refund_id WHERE m.order_id=p_order_id;
  SELECT jsonb_build_object('excess',v_excess,'matched_amount',v_matched,
    'remaining',greatest(0,v_excess-v_matched),
    'refunds',COALESCE(jsonb_agg(jsonb_build_object(
      'id',r.id,'amount',r.amount,'created_at',r.created_at,
      'recipient',r.refund_recipient_account_name,'bank',r.refund_recipient_bank,
      'account_number',r.refund_recipient_account_number,'reason',r.refund_recipient_reason,
      'has_slip',COALESCE(cardinality(r.refund_slip_paths),0)>0,
      'sent',r.refund_slip_sent_at IS NOT NULL,'matched_at',m.matched_at
    ) ORDER BY r.created_at DESC,r.id),'[]'::JSONB)) INTO v_result
  FROM public.ac_refunds r LEFT JOIN public.ac_bank_overpayment_refund_matches m ON m.refund_id=r.id
  WHERE r.order_id=p_order_id AND (r.status='approved' OR m.refund_id IS NOT NULL);
  RETURN v_result;
END $$;

-- Reuse the existing selector API so blocked bills show a reason before attachment.
CREATE OR REPLACE FUNCTION public.or_work_order_refund_blocks(p_order_ids uuid[])
RETURNS TABLE(order_id uuid,bill_no text,reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role IN ('superadmin','admin','sales-tr','sales-pump','account','qc_order','production')) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์'; END IF;
 RETURN QUERY SELECT o.id,o.bill_no,b.reason FROM or_orders o CROSS JOIN LATERAL (
 SELECT CASE WHEN o.billing_details @> '{"request_tax_invoice":true}' AND NOT public.or_tax_approved(o.billing_details,'invoice') THEN 'รอบัญชีอนุมัติใบกำกับภาษี'
 WHEN o.billing_details @> '{"withholding_requested":true}' AND NOT public.or_tax_approved(o.billing_details,'withholding') THEN 'รอบัญชีอนุมัติหัก ณ ที่จ่าย'
 ELSE public.or_refund_production_block(o.id,o.receivable_amount) END reason
 ) b WHERE o.id=ANY(p_order_ids) AND b.reason IS NOT NULL;
END $$;
COMMIT;