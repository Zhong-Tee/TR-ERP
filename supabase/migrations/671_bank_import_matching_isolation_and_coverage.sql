-- Prepared only. No existing allocation rows are changed.
BEGIN;
CREATE FUNCTION public.bank_auto_match_order_has_capacity(p_order_id uuid,p_amount numeric)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM or_orders o WHERE o.id=p_order_id
  AND COALESCE(o.status,'') NOT IN ('รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ','ยกเลิก')
  AND COALESCE((SELECT sum(a.allocated_amount) FROM ac_bank_reconciliation_allocations a WHERE a.order_id=o.id),0)
     +COALESCE((SELECT sum(c.amount) FROM ac_order_receipt_certifications c WHERE c.order_id=o.id AND c.revoked_at IS NULL),0)<o.total_amount-0.01
  AND COALESCE((SELECT sum(a.allocated_amount) FROM ac_bank_reconciliation_allocations a WHERE a.order_id=o.id),0)
     +COALESCE((SELECT sum(c.amount) FROM ac_order_receipt_certifications c WHERE c.order_id=o.id AND c.revoked_at IS NULL),0)
     +p_amount<=o.total_amount+0.01);
$$;
REVOKE ALL ON FUNCTION public.bank_auto_match_order_has_capacity(uuid,numeric) FROM PUBLIC,anon,authenticated;


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
          HAVING sum(c.amount) + COALESCE((SELECT sum(a.allocated_amount) FROM public.ac_bank_reconciliation_allocations a WHERE a.order_id=o.id),0) + v_tx.credit_amount > o.total_amount + 0.01)
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
          HAVING sum(c.amount) + COALESCE((SELECT sum(a.allocated_amount) FROM public.ac_bank_reconciliation_allocations a WHERE a.order_id=o.id),0) + v_tx.credit_amount > o.total_amount + 0.01)
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
          HAVING sum(c.amount) + COALESCE((SELECT sum(a.allocated_amount) FROM public.ac_bank_reconciliation_allocations a WHERE a.order_id=o.id),0) + v_tx.credit_amount > o.total_amount + 0.01)
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
          HAVING sum(c.amount) + COALESCE((SELECT sum(a.allocated_amount) FROM public.ac_bank_reconciliation_allocations a WHERE a.order_id=o.id),0) + v_tx.credit_amount > o.total_amount + 0.01)
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

CREATE OR REPLACE FUNCTION public.bank_statement_import_authorized_impl(
  p_bank_setting_id UUID,
  p_file_name TEXT,
  p_file_hash TEXT,
  p_metadata JSONB,
  p_transactions JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_bank public.bank_settings;
  v_import_id UUID;
  v_source_count INTEGER;
  v_inserted_count INTEGER;
  v_match_result JSONB;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์นำเข้า Statement';
  END IF;
  SELECT * INTO v_bank FROM public.bank_settings WHERE id = p_bank_setting_id AND is_active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบัญชีธนาคารที่เปิดใช้งาน'; END IF;
  IF regexp_replace(v_bank.account_number, '\D', '', 'g')
     <> regexp_replace(COALESCE(p_metadata->>'account_number', ''), '\D', '', 'g') THEN
    RAISE EXCEPTION 'เลขบัญชีในไฟล์ไม่ตรงกับบัญชีที่เลือก';
  END IF;
  IF p_transactions IS NULL OR jsonb_typeof(p_transactions) <> 'array'
     OR jsonb_array_length(p_transactions) < 1 OR jsonb_array_length(p_transactions) > 5000 THEN
    RAISE EXCEPTION 'Statement ต้องมี 1 ถึง 5,000 รายการ';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ac_bank_statement_imports
    WHERE bank_setting_id = p_bank_setting_id AND file_hash = p_file_hash
  ) THEN
    RAISE EXCEPTION 'ไฟล์ Statement นี้ถูกนำเข้าแล้ว';
  END IF;

  v_source_count := jsonb_array_length(p_transactions);
  INSERT INTO public.ac_bank_statement_imports (
    bank_setting_id, file_name, file_hash, parser_code, statement_reference,
    account_number_snapshot, account_name_snapshot, period_start, period_end,
    opening_balance, closing_balance, declared_credit_total, declared_debit_total,
    source_row_count, warnings, uploaded_by
  ) VALUES (
    p_bank_setting_id,
    NULLIF(trim(p_file_name), ''),
    p_file_hash,
    COALESCE(NULLIF(p_metadata->>'parser_code', ''), 'unknown'),
    NULLIF(p_metadata->>'statement_reference', ''),
    p_metadata->>'account_number',
    NULLIF(p_metadata->>'account_name', ''),
    (p_metadata->>'period_start')::DATE,
    (p_metadata->>'period_end')::DATE,
    NULLIF(p_metadata->>'opening_balance', '')::NUMERIC,
    NULLIF(p_metadata->>'closing_balance', '')::NUMERIC,
    NULLIF(p_metadata->>'declared_credit_total', '')::NUMERIC,
    NULLIF(p_metadata->>'declared_debit_total', '')::NUMERIC,
    v_source_count,
    COALESCE(p_metadata->'warnings', '[]'::JSONB),
    auth.uid()
  ) RETURNING id INTO v_import_id;

  INSERT INTO public.ac_bank_statement_transactions (
    import_id, bank_setting_id, source_row_number, transaction_at, effective_date,
    transaction_type, debit_amount, credit_amount, balance, channel, description,
    source_fingerprint, raw_data
  )
  SELECT
    v_import_id,
    p_bank_setting_id,
    x.source_row_number,
    x.transaction_at::TIMESTAMPTZ,
    x.effective_date::DATE,
    x.transaction_type,
    COALESCE(x.debit_amount, 0),
    COALESCE(x.credit_amount, 0),
    x.balance,
    NULLIF(x.channel, ''),
    NULLIF(x.description, ''),
    x.source_fingerprint,
    x.raw_data
  FROM jsonb_to_recordset(p_transactions) AS x(
    source_row_number INTEGER,
    transaction_at TEXT,
    effective_date TEXT,
    transaction_type TEXT,
    debit_amount NUMERIC,
    credit_amount NUMERIC,
    balance NUMERIC,
    channel TEXT,
    description TEXT,
    source_fingerprint TEXT,
    raw_data JSONB
  )
  WHERE x.source_row_number IS NOT NULL
    AND NULLIF(x.transaction_at, '') IS NOT NULL
    AND NULLIF(x.effective_date, '') IS NOT NULL
    AND NULLIF(x.transaction_type, '') IS NOT NULL
    AND NULLIF(x.source_fingerprint, '') IS NOT NULL
    AND (COALESCE(x.debit_amount, 0) > 0 OR COALESCE(x.credit_amount, 0) > 0)
  ON CONFLICT (bank_setting_id, source_fingerprint) DO NOTHING;
  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  UPDATE public.ac_bank_statement_imports
  SET imported_row_count = v_inserted_count,
      duplicate_row_count = v_source_count - v_inserted_count
  WHERE id = v_import_id;

  -- Keep input validation atomic; isolate only the optional automatic matching stage.
  BEGIN
    v_match_result := public.bank_statement_auto_match(v_import_id);
  EXCEPTION WHEN OTHERS THEN
    v_match_result:=jsonb_build_object('matched',0,'ambiguous',0,'requires_review',true,'warning',SQLERRM);
    UPDATE public.ac_bank_statement_imports SET warnings=COALESCE(warnings,'[]'::jsonb)||jsonb_build_array(
      jsonb_build_object('code','auto_match_failed','message',SQLERRM,'action','rerun_auto_match')) WHERE id=v_import_id;
  END;
  RETURN jsonb_build_object(
    'import_id', v_import_id,
    'source_count', v_source_count,
    'inserted_count', v_inserted_count,
    'duplicate_count', v_source_count - v_inserted_count,
    'match_result', v_match_result
  );
END;
$$;

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
    WHEN upper(COALESCE(o.bill_no,'')) LIKE 'REQ%' AND o.total_amount<=0.01
      AND COALESCE(a.amount,0)+COALESCE(c.amount,0)<=0.01 THEN 'no_payment'
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
   'bank',COALESCE(sum(bank_received),0),'certified',COALESCE(sum(certified_received),0),'cash',COALESCE(sum(certified_cash),0),'other_certified',COALESCE(sum(certified_other),0),'outstanding',COALESCE(sum(greatest(total_amount-bank_received-certified_received,0)),0)) FROM base),
  'channels',(SELECT COALESCE(jsonb_agg(channel_code),'[]'::JSONB) FROM (SELECT DISTINCT channel_code FROM public.or_orders WHERE COALESCE(channel_code,'') NOT IN ('SPTR','FSPTR','TTTR','LZTR','PGTR','WY') AND created_at >= TIMESTAMPTZ '2026-10-01 00:00:00+07' AND COALESCE(status,'') NOT IN ('ยกเลิก','รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ') ORDER BY channel_code) channels),
  'states',COALESCE((SELECT jsonb_object_agg(reconciliation_state,n) FROM (SELECT reconciliation_state,count(*) n FROM base GROUP BY reconciliation_state) counts),'{}'::JSONB)) INTO v_result;
 RETURN v_result;
END $$;

COMMIT;
NOTIFY pgrst,'reload schema';
