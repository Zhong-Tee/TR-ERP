BEGIN;
DROP FUNCTION public.bank_statement_workspace(DATE,DATE,UUID,TEXT,TEXT,INTEGER);
CREATE FUNCTION public.bank_statement_workspace(p_from DATE DEFAULT NULL,p_to DATE DEFAULT NULL,p_bank UUID DEFAULT NULL,
 p_status TEXT DEFAULT 'all',p_search TEXT DEFAULT '',p_offset INTEGER DEFAULT 0,p_include_debits BOOLEAN DEFAULT FALSE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_result JSONB;
BEGIN
 PERFORM public.bank_reconciliation_require_authorized_role();
 WITH base AS (SELECT t.*,b.bank_name,b.account_number,r.rule_name,r.match_keyword,
  COALESCE(r.is_active AND (r.bank_setting_id IS NULL OR r.bank_setting_id=t.bank_setting_id)
   AND strpos(lower(concat_ws(' ',t.transaction_type,t.channel,t.description)),lower(btrim(r.match_keyword)))>0,false) rule_valid
  FROM public.ac_bank_statement_transactions t JOIN public.bank_settings b ON b.id=t.bank_setting_id
  LEFT JOIN public.ac_bank_transaction_rules r ON r.id=t.classification_rule_id
  WHERE (p_include_debits OR t.credit_amount>0) AND (p_from IS NULL OR t.transaction_at>=p_from::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
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


REVOKE ALL ON FUNCTION public.bank_statement_workspace(DATE,DATE,UUID,TEXT,TEXT,INTEGER,BOOLEAN) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.bank_statement_workspace(DATE,DATE,UUID,TEXT,TEXT,INTEGER,BOOLEAN) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
