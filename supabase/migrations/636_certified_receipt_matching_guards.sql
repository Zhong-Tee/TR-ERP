BEGIN;

CREATE FUNCTION public.tr_guard_bank_certified_allocation() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_total NUMERIC; v_cert NUMERIC; v_bank NUMERIC;
BEGIN
 SELECT total_amount INTO v_total FROM public.or_orders WHERE id=NEW.order_id FOR UPDATE;
 SELECT COALESCE(sum(amount),0) INTO v_cert FROM public.ac_order_receipt_certifications WHERE order_id=NEW.order_id AND revoked_at IS NULL;
 IF v_cert>0 THEN
  SELECT COALESCE(sum(allocated_amount),0) INTO v_bank FROM public.ac_bank_reconciliation_allocations WHERE order_id=NEW.order_id AND id<>NEW.id;
  IF v_cert+v_bank+NEW.allocated_amount>v_total+0.01 THEN RAISE EXCEPTION 'บิลมีการรับรองเงินรับแล้ว กรุณายกเลิกหรือปรับการรับรองก่อนจับคู่เพื่อไม่ให้นับเงินซ้ำ'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_guard_bank_certified_allocation BEFORE INSERT OR UPDATE ON public.ac_bank_reconciliation_allocations
FOR EACH ROW EXECUTE FUNCTION public.tr_guard_bank_certified_allocation();
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
      UPDATE public.ac_bank_statement_transactions
      SET reconciliation_status = 'matched'
      WHERE id = v_tx.id;
      v_matched := v_matched + 1;
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
      UPDATE public.ac_bank_statement_transactions
      SET reconciliation_status = 'matched'
      WHERE id = v_tx.id;
      v_matched := v_matched + 1;
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
    'ambiguous', v_ambiguous,
    'time_tolerance_minutes', 10,
    'supports_split_payment', true
  );
END;
$$;


REVOKE ALL ON FUNCTION public.bank_workspace_auto_match(DATE,DATE,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.bank_workspace_auto_match(DATE,DATE,UUID) TO authenticated;
CREATE OR REPLACE FUNCTION public.bank_reconciliation_missing_payments(p_import_id UUID)
RETURNS TABLE(
  source_type TEXT,
  source_id UUID,
  order_id UUID,
  bill_no TEXT,
  payment_at TIMESTAMPTZ,
  paid_amount NUMERIC,
  bill_amount NUMERIC,
  difference NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();
  RETURN QUERY SELECT missing.* FROM public.bank_reconciliation_missing_payments_authorized_impl(p_import_id) missing
 WHERE NOT EXISTS(SELECT 1 FROM public.ac_order_receipt_certifications c WHERE c.order_id=missing.order_id AND c.revoked_at IS NULL
 HAVING sum(c.amount)+COALESCE((SELECT sum(a.allocated_amount) FROM public.ac_bank_reconciliation_allocations a WHERE a.order_id=missing.order_id),0)>=missing.bill_amount-0.01);
END;
$$;

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
       HAVING sum(c.amount)+COALESCE((SELECT sum(a.allocated_amount) FROM public.ac_bank_reconciliation_allocations a WHERE a.order_id=customer_order.id),0)>=customer_order.total_amount-0.01)
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
       HAVING sum(c.amount)+COALESCE((SELECT sum(a.allocated_amount) FROM public.ac_bank_reconciliation_allocations a WHERE a.order_id=customer_order.id),0)>=customer_order.total_amount-0.01)
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

CREATE OR REPLACE FUNCTION public.bank_reconciliation_bill_match_availability(p_bill_no TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.or_orders;
  v_allocated_amount NUMERIC(18,2);
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();

  SELECT * INTO v_order
  FROM public.or_orders
  WHERE upper(trim(bill_no)) = upper(trim(p_bill_no))
    AND status <> 'ยกเลิก'
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบบิล หรือบิลถูกยกเลิก';
  END IF;

  SELECT COALESCE(SUM(allocation.allocated_amount), 0)
  INTO v_allocated_amount
  FROM public.ac_bank_reconciliation_allocations allocation
  WHERE allocation.order_id = v_order.id;

  v_allocated_amount := v_allocated_amount + COALESCE((SELECT sum(amount) FROM public.ac_order_receipt_certifications WHERE order_id=v_order.id AND revoked_at IS NULL),0);
  RETURN jsonb_build_object(
    'available', v_allocated_amount < COALESCE(v_order.total_amount, 0) - 0.01,
    'order_id', v_order.id,
    'bill_no', v_order.bill_no,
    'bill_amount', COALESCE(v_order.total_amount, 0),
    'allocated_amount', v_allocated_amount,
    'remaining_amount', GREATEST(COALESCE(v_order.total_amount, 0) - v_allocated_amount, 0)
  );
END;
$$;


CREATE FUNCTION public.bank_receipt_history(p_order_id UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_result JSONB;
BEGIN
 PERFORM public.bank_reconciliation_require_authorized_role();
 SELECT COALESCE(jsonb_agg(to_jsonb(h)),'[]'::JSONB) INTO v_result FROM (
  SELECT c.*,COALESCE(u.username,c.certified_by::TEXT) actor,COALESCE(r.username,c.revoked_by::TEXT) revoker
  FROM public.ac_order_receipt_certifications c LEFT JOIN public.us_users u ON u.id=c.certified_by
  LEFT JOIN public.us_users r ON r.id=c.revoked_by WHERE c.order_id=p_order_id ORDER BY c.certified_at DESC,c.id
 ) h; RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.bank_receipt_history(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.bank_receipt_history(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;