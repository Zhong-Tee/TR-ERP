-- Sales-first reconciliation, audited receipts, literal rules and combined Statements.
BEGIN;

CREATE TABLE public.ac_order_receipt_certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.or_orders(id),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  receipt_method TEXT NOT NULL CHECK (receipt_method IN ('cash', 'other', 'transfer_exception')),
  received_on DATE NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  evidence_reference TEXT,
  certified_by UUID NOT NULL REFERENCES public.us_users(id),
  certified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by UUID REFERENCES public.us_users(id),
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT
);
CREATE INDEX ON public.ac_order_receipt_certifications(order_id);
ALTER TABLE public.ac_order_receipt_certifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY receipt_read ON public.ac_order_receipt_certifications FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.us_users WHERE id = auth.uid() AND role IN ('superadmin','account')));

CREATE FUNCTION public.bank_certify_receipt(p_order_id UUID, p_amount NUMERIC, p_method TEXT,
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
  IF v_received + p_amount > v_order.total_amount + 0.01 THEN RAISE EXCEPTION 'ยอดรับรองเกินยอดค้างของบิล กรุณาตรวจเงินที่จับคู่แล้ว'; END IF;
  INSERT INTO public.ac_order_receipt_certifications(order_id,amount,receipt_method,received_on,reason,evidence_reference,certified_by)
  VALUES(p_order_id,p_amount,p_method,p_received_on,btrim(p_reason),NULLIF(btrim(p_evidence),''),auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION public.bank_revoke_receipt(p_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.us_users WHERE id=auth.uid() AND role='superadmin') THEN RAISE EXCEPTION 'เฉพาะ superadmin สามารถยกเลิกการรับรอง'; END IF;
  IF NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผล'; END IF;
  PERFORM 1 FROM public.or_orders WHERE id=(SELECT order_id FROM public.ac_order_receipt_certifications WHERE id=p_id) FOR UPDATE;
  UPDATE public.ac_order_receipt_certifications SET revoked_by=auth.uid(),revoked_at=now(),revoke_reason=btrim(p_reason)
  WHERE id=p_id AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบการรับรองที่ยังใช้งาน'; END IF;
END $$;

CREATE FUNCTION public.bank_sales_workspace(p_from DATE DEFAULT NULL,p_to DATE DEFAULT NULL,
 p_status TEXT DEFAULT 'pending',p_search TEXT DEFAULT '',p_channel TEXT DEFAULT '',p_method TEXT DEFAULT '',p_offset INTEGER DEFAULT 0)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_result JSONB;
BEGIN
 PERFORM public.bank_reconciliation_require_authorized_role();
 WITH base AS (
  SELECT o.id,o.bill_no,o.created_at,o.channel_code,o.payment_method,o.total_amount,
   COALESCE(a.amount,0) bank_received,COALESCE(c.amount,0) certified_received,
   COALESCE(s.amount,0)+COALESCE(m.amount,0) evidence_amount,COALESCE(c.cash,0) certified_cash,COALESCE(c.other,0) certified_other,
   s.payment_at,
   CASE WHEN COALESCE(a.amount,0)+COALESCE(c.amount,0)>o.total_amount+0.01 THEN 'overpaid'
    WHEN COALESCE(a.amount,0)+COALESCE(c.amount,0)>=o.total_amount-0.01 THEN CASE WHEN COALESCE(c.amount,0)>0 THEN 'certified' ELSE 'matched' END
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
      NULLIF(regexp_replace(COALESCE(vs.easyslip_receiver_account,''),'\D','','g'),'') receiver_account,NULLIF(btrim(vs.easyslip_receiver_bank_id),'') bank_code
    FROM public.ac_verified_slips vs WHERE vs.order_id=o.id AND COALESCE(vs.is_deleted,false)=false AND vs.verified_amount>0 AND vs.easyslip_date IS NOT NULL
    UNION ALL
    SELECT CASE WHEN ms.transfer_date ~ '^\d{4}-\d{2}-\d{2}$' THEN ms.transfer_date::DATE END,NULL::TEXT,NULL::TEXT
    FROM public.ac_manual_slip_checks ms WHERE ms.order_id=o.id AND ms.status='approved'
   ) p
  ) coverage ON TRUE
  WHERE COALESCE(o.status,'') NOT IN ('ยกเลิก','รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ')
   AND (p_from IS NULL OR o.created_at >= p_from::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
   AND (p_to IS NULL OR o.created_at < (p_to+1)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
   AND (p_channel='' OR o.channel_code=p_channel) AND (p_method='' OR COALESCE(o.payment_method,'')=p_method)
   AND (p_search='' OR strpos(lower(o.bill_no),lower(p_search))>0)
 ), filtered AS (SELECT * FROM base WHERE p_status='all' OR reconciliation_state=p_status
   OR p_status='pending' AND reconciliation_state IN ('partial','waiting_bank','no_evidence','overpaid')),
 page AS (SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT 50 OFFSET greatest(p_offset,0))
 SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]'::JSONB),
  'count',(SELECT count(*) FROM filtered),'summary',(SELECT jsonb_build_object('bills',count(*),'sales',COALESCE(sum(total_amount),0),
   'bank',COALESCE(sum(bank_received),0),'certified',COALESCE(sum(certified_received),0),'cash',COALESCE(sum(certified_cash),0),'other_certified',COALESCE(sum(certified_other),0),'outstanding',COALESCE(sum(greatest(total_amount-bank_received-certified_received,0)),0)) FROM base),
  'channels',(SELECT COALESCE(jsonb_agg(channel_code),'[]'::JSONB) FROM (SELECT DISTINCT channel_code FROM public.or_orders WHERE COALESCE(status,'') NOT IN ('ยกเลิก','รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ') ORDER BY channel_code) channels),
  'states',COALESCE((SELECT jsonb_object_agg(reconciliation_state,n) FROM (SELECT reconciliation_state,count(*) n FROM base GROUP BY reconciliation_state) counts),'{}'::JSONB)) INTO v_result;
 RETURN v_result;
END $$;

CREATE FUNCTION public.bank_statement_workspace(p_from DATE DEFAULT NULL,p_to DATE DEFAULT NULL,p_bank UUID DEFAULT NULL,
 p_status TEXT DEFAULT 'all',p_search TEXT DEFAULT '',p_offset INTEGER DEFAULT 0)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_result JSONB;
BEGIN
 PERFORM public.bank_reconciliation_require_authorized_role();
 WITH base AS (SELECT t.*,b.bank_name,b.account_number,r.rule_name,r.match_keyword,
  COALESCE(r.is_active AND (r.bank_setting_id IS NULL OR r.bank_setting_id=t.bank_setting_id)
   AND strpos(lower(concat_ws(' ',t.transaction_type,t.channel,t.description)),lower(btrim(r.match_keyword)))>0,false) rule_valid
  FROM public.ac_bank_statement_transactions t JOIN public.bank_settings b ON b.id=t.bank_setting_id
  LEFT JOIN public.ac_bank_transaction_rules r ON r.id=t.classification_rule_id
  WHERE (p_from IS NULL OR t.transaction_at>=p_from::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
   AND (p_to IS NULL OR t.transaction_at<(p_to+1)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
   AND (p_bank IS NULL OR t.bank_setting_id=p_bank)
   AND (p_search='' OR strpos(lower(concat_ws(' ',t.transaction_type,t.channel,t.description)),lower(p_search))>0)),
 filtered AS (SELECT * FROM base WHERE p_status='all' OR reconciliation_status=p_status),
 page AS (SELECT * FROM filtered ORDER BY transaction_at DESC,id LIMIT 100 OFFSET greatest(p_offset,0))
 SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]'::JSONB),
  'count',(SELECT count(*) FROM filtered),'summary',(SELECT jsonb_build_object('credit',COALESCE(sum(credit_amount),0),
   'matched',COALESCE(sum(credit_amount) FILTER(WHERE reconciliation_status='matched'),0),
   'other',COALESCE(sum(credit_amount) FILTER(WHERE reconciliation_status='ignored'),0),
   'unmatchedCount',count(*) FILTER(WHERE credit_amount>0 AND reconciliation_status='unmatched'),
   'ambiguousCount',count(*) FILTER(WHERE credit_amount>0 AND reconciliation_status='ambiguous')) FROM base)) INTO v_result;
 RETURN v_result;
END $$;

CREATE FUNCTION public.bank_workspace_diagnostics(p_transaction_ids UUID[])
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_diagnostics JSONB; v_candidates JSONB;
BEGIN
 PERFORM public.bank_reconciliation_require_authorized_role();
 SELECT COALESCE(jsonb_agg(to_jsonb(d)),'[]'::JSONB) INTO v_diagnostics
 FROM (SELECT DISTINCT import_id FROM public.ac_bank_statement_transactions WHERE id=ANY(p_transaction_ids)) i
 CROSS JOIN LATERAL public.bank_statement_match_diagnostics(i.import_id) d WHERE d.transaction_id=ANY(p_transaction_ids);
 SELECT COALESCE(jsonb_agg(to_jsonb(d)),'[]'::JSONB) INTO v_candidates
 FROM (SELECT DISTINCT import_id FROM public.ac_bank_statement_transactions WHERE id=ANY(p_transaction_ids)) i
 CROSS JOIN LATERAL public.bank_statement_match_candidate_lists(i.import_id) d WHERE d.transaction_id=ANY(p_transaction_ids);
 RETURN jsonb_build_object('diagnostics',v_diagnostics,'candidates',v_candidates);
END $$;

REVOKE ALL ON FUNCTION public.bank_workspace_diagnostics(UUID[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.bank_workspace_diagnostics(UUID[]) TO authenticated;
REVOKE ALL ON FUNCTION public.bank_certify_receipt(UUID,NUMERIC,TEXT,DATE,TEXT,TEXT),public.bank_revoke_receipt(UUID,TEXT),
 public.bank_sales_workspace(DATE,DATE,TEXT,TEXT,TEXT,TEXT,INTEGER),public.bank_statement_workspace(DATE,DATE,UUID,TEXT,TEXT,INTEGER) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.bank_certify_receipt(UUID,NUMERIC,TEXT,DATE,TEXT,TEXT),public.bank_revoke_receipt(UUID,TEXT),
 public.bank_sales_workspace(DATE,DATE,TEXT,TEXT,TEXT,TEXT,INTEGER),public.bank_statement_workspace(DATE,DATE,UUID,TEXT,TEXT,INTEGER) TO authenticated;

COMMIT;
