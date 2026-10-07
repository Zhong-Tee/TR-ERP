-- Track sales bills created from 1 October 2026 (Bangkok), including summaries and exports.
BEGIN;
CREATE OR REPLACE FUNCTION public.bank_sales_workspace(p_from DATE DEFAULT NULL,p_to DATE DEFAULT NULL,
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
   'bank',COALESCE(sum(bank_received),0),'certified',COALESCE(sum(certified_received),0),'cash',COALESCE(sum(certified_cash),0),'other_certified',COALESCE(sum(certified_other),0),'outstanding',COALESCE(sum(greatest(total_amount-bank_received-certified_received,0)),0)) FROM base),
  'channels',(SELECT COALESCE(jsonb_agg(channel_code),'[]'::JSONB) FROM (SELECT DISTINCT channel_code FROM public.or_orders WHERE created_at >= TIMESTAMPTZ '2026-10-01 00:00:00+07' AND COALESCE(status,'') NOT IN ('ยกเลิก','รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ') ORDER BY channel_code) channels),
  'states',COALESCE((SELECT jsonb_object_agg(reconciliation_state,n) FROM (SELECT reconciliation_state,count(*) n FROM base GROUP BY reconciliation_state) counts),'{}'::JSONB)) INTO v_result;
 RETURN v_result;
END $$;

COMMIT;
