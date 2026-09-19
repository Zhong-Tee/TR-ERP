-- Weekly bank statement imports and reconciliation against EasySlip/manual slips.
-- This migration is additive: existing order and slip workflows are not changed.
BEGIN;

CREATE TABLE IF NOT EXISTS public.ac_bank_statement_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_setting_id UUID NOT NULL REFERENCES public.bank_settings(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  parser_code TEXT NOT NULL,
  statement_reference TEXT,
  account_number_snapshot TEXT NOT NULL,
  account_name_snapshot TEXT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  opening_balance NUMERIC(18,2),
  closing_balance NUMERIC(18,2),
  declared_credit_total NUMERIC(18,2),
  declared_debit_total NUMERIC(18,2),
  source_row_count INTEGER NOT NULL DEFAULT 0,
  imported_row_count INTEGER NOT NULL DEFAULT 0,
  duplicate_row_count INTEGER NOT NULL DEFAULT 0,
  warnings JSONB NOT NULL DEFAULT '[]'::JSONB,
  status TEXT NOT NULL DEFAULT 'imported' CHECK (status IN ('imported', 'reviewed', 'closed')),
  uploaded_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  CONSTRAINT ac_bank_statement_imports_period_check CHECK (period_end >= period_start),
  CONSTRAINT ac_bank_statement_imports_file_unique UNIQUE (bank_setting_id, file_hash)
);

CREATE TABLE IF NOT EXISTS public.ac_bank_statement_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL REFERENCES public.ac_bank_statement_imports(id) ON DELETE CASCADE,
  bank_setting_id UUID NOT NULL REFERENCES public.bank_settings(id) ON DELETE RESTRICT,
  source_row_number INTEGER NOT NULL,
  transaction_at TIMESTAMPTZ NOT NULL,
  effective_date DATE NOT NULL,
  transaction_type TEXT NOT NULL,
  debit_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (debit_amount >= 0),
  credit_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  balance NUMERIC(18,2),
  channel TEXT,
  description TEXT,
  source_fingerprint TEXT NOT NULL,
  raw_data JSONB,
  reconciliation_status TEXT NOT NULL DEFAULT 'unmatched'
    CHECK (reconciliation_status IN ('unmatched', 'matched', 'ambiguous', 'ignored')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ac_bank_statement_transactions_amount_check CHECK (debit_amount > 0 OR credit_amount > 0),
  CONSTRAINT ac_bank_statement_transactions_source_row_unique UNIQUE (import_id, source_row_number),
  CONSTRAINT ac_bank_statement_transactions_fingerprint_unique UNIQUE (bank_setting_id, source_fingerprint)
);

CREATE TABLE IF NOT EXISTS public.ac_bank_reconciliation_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES public.ac_bank_statement_transactions(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES public.or_orders(id) ON DELETE RESTRICT,
  verified_slip_id UUID REFERENCES public.ac_verified_slips(id) ON DELETE SET NULL,
  manual_slip_check_id UUID REFERENCES public.ac_manual_slip_checks(id) ON DELETE SET NULL,
  allocated_amount NUMERIC(18,2) NOT NULL CHECK (allocated_amount > 0),
  match_method TEXT NOT NULL CHECK (match_method IN ('exact_verified_slip', 'exact_manual_slip', 'manual_bill')),
  matched_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  matched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT,
  CONSTRAINT ac_bank_reconciliation_allocation_source_check CHECK (
    num_nonnulls(verified_slip_id, manual_slip_check_id) <= 1
  ),
  CONSTRAINT ac_bank_reconciliation_transaction_order_unique UNIQUE (transaction_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_ac_bank_imports_uploaded
  ON public.ac_bank_statement_imports(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_ac_bank_transactions_import
  ON public.ac_bank_statement_transactions(import_id, transaction_at, id);
CREATE INDEX IF NOT EXISTS idx_ac_bank_transactions_match
  ON public.ac_bank_statement_transactions(bank_setting_id, transaction_at, credit_amount)
  WHERE credit_amount > 0;
CREATE INDEX IF NOT EXISTS idx_ac_bank_allocations_transaction
  ON public.ac_bank_reconciliation_allocations(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ac_bank_allocations_order
  ON public.ac_bank_reconciliation_allocations(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ac_bank_allocations_verified_slip
  ON public.ac_bank_reconciliation_allocations(verified_slip_id)
  WHERE verified_slip_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ac_bank_allocations_manual_slip
  ON public.ac_bank_reconciliation_allocations(manual_slip_check_id)
  WHERE manual_slip_check_id IS NOT NULL;

ALTER TABLE public.ac_bank_statement_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ac_bank_statement_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ac_bank_reconciliation_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY ac_bank_statement_imports_account_access
  ON public.ac_bank_statement_imports FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account')
  ));

CREATE POLICY ac_bank_statement_transactions_account_access
  ON public.ac_bank_statement_transactions FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account')
  ));

CREATE POLICY ac_bank_reconciliation_allocations_account_access
  ON public.ac_bank_reconciliation_allocations FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'admin', 'account')
  ));

CREATE OR REPLACE FUNCTION public.bank_statement_auto_match(p_import_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_tx RECORD;
  v_candidate_count INTEGER;
  v_source_kind TEXT;
  v_source_id UUID;
  v_order_id UUID;
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
    SELECT t.*, b.bank_code, b.account_number
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
    SELECT
      COUNT(*),
      (array_agg(source_kind))[1],
      (array_agg(source_id))[1],
      (array_agg(order_id))[1]
    INTO v_candidate_count, v_source_kind, v_source_id, v_order_id
    FROM (
      SELECT 'verified'::TEXT AS source_kind, s.id AS source_id, s.order_id
      FROM public.ac_verified_slips s
      JOIN public.or_orders o ON o.id = s.order_id
      WHERE COALESCE(s.is_deleted, false) = false
        AND COALESCE(o.status, '') NOT IN ('รอลงข้อมูล', 'ลงข้อมูลผิด', 'ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ', 'ยกเลิก')
        AND s.easyslip_date >= date_trunc('minute', v_tx.transaction_at)
        AND s.easyslip_date < date_trunc('minute', v_tx.transaction_at) + INTERVAL '1 minute'
        AND ABS(s.verified_amount - v_tx.credit_amount) <= 0.01
        AND (NULLIF(trim(s.easyslip_receiver_bank_id), '') IS NULL OR trim(s.easyslip_receiver_bank_id) = v_tx.bank_code)
        AND (
          NULLIF(regexp_replace(COALESCE(s.easyslip_receiver_account, ''), '\D', '', 'g'), '') IS NULL
          OR right(regexp_replace(s.easyslip_receiver_account, '\D', '', 'g'), 4)
             = right(regexp_replace(v_tx.account_number, '\D', '', 'g'), 4)
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.ac_bank_reconciliation_allocations used
          WHERE used.verified_slip_id = s.id
        )
      UNION ALL
      SELECT 'manual'::TEXT AS source_kind, m.id AS source_id, m.order_id
      FROM public.ac_manual_slip_checks m
      JOIN public.or_orders o ON o.id = m.order_id
      WHERE m.status = 'approved'
        AND COALESCE(o.status, '') <> 'ยกเลิก'
        AND CASE
              WHEN m.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
               AND m.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
              THEN (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
              ELSE NULL
            END
              >= date_trunc('minute', v_tx.transaction_at)
        AND CASE
              WHEN m.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
               AND m.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
              THEN (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
              ELSE NULL
            END
              < date_trunc('minute', v_tx.transaction_at) + INTERVAL '1 minute'
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
    ) candidates;

    IF v_candidate_count = 1 THEN
      INSERT INTO public.ac_bank_reconciliation_allocations (
        transaction_id, order_id, verified_slip_id, manual_slip_check_id,
        allocated_amount, match_method, matched_by
      ) VALUES (
        v_tx.id,
        v_order_id,
        CASE WHEN v_source_kind = 'verified' THEN v_source_id ELSE NULL END,
        CASE WHEN v_source_kind = 'manual' THEN v_source_id ELSE NULL END,
        v_tx.credit_amount,
        CASE WHEN v_source_kind = 'verified' THEN 'exact_verified_slip' ELSE 'exact_manual_slip' END,
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

  RETURN jsonb_build_object('matched', v_matched, 'ambiguous', v_ambiguous);
END;
$$;

CREATE OR REPLACE FUNCTION public.bank_statement_import(
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

  v_match_result := public.bank_statement_auto_match(v_import_id);
  RETURN jsonb_build_object(
    'import_id', v_import_id,
    'source_count', v_source_count,
    'inserted_count', v_inserted_count,
    'duplicate_count', v_source_count - v_inserted_count,
    'match_result', v_match_result
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.bank_reconciliation_set_manual_match(
  p_transaction_id UUID,
  p_bill_no TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_tx public.ac_bank_statement_transactions;
  v_order public.or_orders;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ผลกระทบยอด';
  END IF;
  SELECT * INTO v_tx FROM public.ac_bank_statement_transactions WHERE id = p_transaction_id FOR UPDATE;
  IF NOT FOUND OR v_tx.credit_amount <= 0 THEN RAISE EXCEPTION 'ไม่พบรายการเงินเข้า'; END IF;
  SELECT * INTO v_order FROM public.or_orders
  WHERE upper(trim(bill_no)) = upper(trim(p_bill_no)) AND status <> 'ยกเลิก'
  LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิล หรือบิลถูกยกเลิก'; END IF;

  DELETE FROM public.ac_bank_reconciliation_allocations WHERE transaction_id = v_tx.id;
  INSERT INTO public.ac_bank_reconciliation_allocations (
    transaction_id, order_id, allocated_amount, match_method, matched_by
  ) VALUES (v_tx.id, v_order.id, v_tx.credit_amount, 'manual_bill', auth.uid());
  UPDATE public.ac_bank_statement_transactions SET reconciliation_status = 'matched' WHERE id = v_tx.id;
  RETURN jsonb_build_object('transaction_id', v_tx.id, 'order_id', v_order.id, 'bill_no', v_order.bill_no);
END;
$$;

CREATE OR REPLACE FUNCTION public.bank_reconciliation_clear_match(p_transaction_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ผลกระทบยอด';
  END IF;
  DELETE FROM public.ac_bank_reconciliation_allocations WHERE transaction_id = p_transaction_id;
  UPDATE public.ac_bank_statement_transactions SET reconciliation_status = 'unmatched'
  WHERE id = p_transaction_id;
END;
$$;

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
DECLARE
  v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดูกระทบยอดธนาคาร';
  END IF;

  RETURN QUERY
  WITH selected_import AS (
    SELECT i.*, b.bank_code, b.account_number
    FROM public.ac_bank_statement_imports i
    JOIN public.bank_settings b ON b.id = i.bank_setting_id
    WHERE i.id = p_import_id
  ), missing AS (
  SELECT
    'verified_slip'::TEXT AS source_type,
    s.id AS source_id,
    s.order_id,
    o.bill_no,
    s.easyslip_date AS payment_at,
    s.verified_amount AS paid_amount,
    o.total_amount AS bill_amount,
    s.verified_amount - o.total_amount AS difference
  FROM selected_import i
  JOIN public.ac_verified_slips s
    ON s.easyslip_date >= i.period_start::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
   AND s.easyslip_date < (i.period_end + 1)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
  JOIN public.or_orders o ON o.id = s.order_id
  WHERE COALESCE(s.is_deleted, false) = false
    AND COALESCE(o.status, '') NOT IN ('รอลงข้อมูล', 'ลงข้อมูลผิด', 'ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ', 'ยกเลิก')
    AND (NULLIF(trim(s.easyslip_receiver_bank_id), '') IS NULL OR trim(s.easyslip_receiver_bank_id) = i.bank_code)
    AND (
      NULLIF(regexp_replace(COALESCE(s.easyslip_receiver_account, ''), '\D', '', 'g'), '') IS NULL
      OR right(regexp_replace(s.easyslip_receiver_account, '\D', '', 'g'), 4)
         = right(regexp_replace(i.account_number, '\D', '', 'g'), 4)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.ac_bank_reconciliation_allocations a WHERE a.verified_slip_id = s.id
    )
  UNION ALL
  SELECT
    'manual_slip'::TEXT AS source_type,
    m.id AS source_id,
    m.order_id,
    o.bill_no,
    (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok' AS payment_at,
    m.transfer_amount AS paid_amount,
    o.total_amount AS bill_amount,
    m.transfer_amount - o.total_amount AS difference
  FROM selected_import i
  JOIN public.ac_manual_slip_checks m
    ON CASE
         WHEN m.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN m.transfer_date::DATE
         ELSE NULL
       END BETWEEN i.period_start AND i.period_end
  JOIN public.or_orders o ON o.id = m.order_id
  WHERE m.status = 'approved'
    AND m.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND COALESCE(o.status, '') <> 'ยกเลิก'
    AND EXISTS (
      SELECT 1 FROM public.bank_settings_channels bsc
      WHERE bsc.bank_setting_id = i.bank_setting_id AND bsc.channel_code = o.channel_code
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.ac_bank_reconciliation_allocations a WHERE a.manual_slip_check_id = m.id
    )
  )
  SELECT
    missing.source_type,
    missing.source_id,
    missing.order_id,
    missing.bill_no,
    missing.payment_at,
    missing.paid_amount,
    missing.bill_amount,
    missing.difference
  FROM missing
  ORDER BY missing.payment_at, missing.bill_no;
END;
$$;

REVOKE ALL ON FUNCTION public.bank_statement_auto_match(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_statement_import(UUID, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_reconciliation_set_manual_match(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_reconciliation_clear_match(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_reconciliation_missing_payments(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_statement_auto_match(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_statement_import(UUID, TEXT, TEXT, JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_set_manual_match(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_clear_match(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_missing_payments(UUID) TO authenticated;

INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access, updated_at)
VALUES
  ('admin', 'account-bank-reconciliation', 'บัญชี · กระทบยอดธนาคาร', TRUE, now()),
  ('account', 'account-bank-reconciliation', 'บัญชี · กระทบยอดธนาคาร', TRUE, now()),
  ('sales-tr', 'account-bank-reconciliation', 'บัญชี · กระทบยอดธนาคาร', FALSE, now()),
  ('sales-pump', 'account-bank-reconciliation', 'บัญชี · กระทบยอดธนาคาร', FALSE, now())
ON CONFLICT (role, menu_key) DO UPDATE
SET menu_name = EXCLUDED.menu_name,
    has_access = EXCLUDED.has_access,
    updated_at = now();

NOTIFY pgrst, 'reload schema';
COMMIT;
