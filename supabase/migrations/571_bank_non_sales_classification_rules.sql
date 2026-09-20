-- Configurable rules for incoming bank movements that are not sales-bill
-- payments (marketplace payouts, interest, refunds, owner transfers, etc.).
BEGIN;

CREATE TABLE IF NOT EXISTS public.ac_bank_transaction_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name TEXT NOT NULL,
  match_keyword TEXT NOT NULL,
  classification_name TEXT NOT NULL,
  bank_setting_id UUID REFERENCES public.bank_settings(id) ON DELETE CASCADE,
  direction TEXT NOT NULL DEFAULT 'credit' CHECK (direction IN ('credit', 'debit', 'both')),
  priority INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ac_bank_transaction_rules_keyword_length CHECK (length(btrim(match_keyword)) >= 3),
  CONSTRAINT ac_bank_transaction_rules_unique UNIQUE NULLS NOT DISTINCT (
    bank_setting_id, direction, match_keyword
  )
);

ALTER TABLE public.ac_bank_statement_transactions
  ADD COLUMN IF NOT EXISTS classification_rule_id UUID REFERENCES public.ac_bank_transaction_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS classification_name TEXT,
  ADD COLUMN IF NOT EXISTS classified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS classified_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bank_transaction_rules_active
  ON public.ac_bank_transaction_rules(bank_setting_id, direction, priority)
  WHERE is_active = TRUE;

ALTER TABLE public.ac_bank_transaction_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ac_bank_transaction_rules_account_access ON public.ac_bank_transaction_rules;
CREATE POLICY ac_bank_transaction_rules_account_access
  ON public.ac_bank_transaction_rules FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.us_users actor
      WHERE actor.id = auth.uid() AND actor.role IN ('superadmin', 'account')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.us_users actor
      WHERE actor.id = auth.uid() AND actor.role IN ('superadmin', 'account')
    )
  );

CREATE OR REPLACE FUNCTION public.bank_matching_rule(
  p_bank_setting_id UUID,
  p_transaction_type TEXT,
  p_channel TEXT,
  p_description TEXT,
  p_debit_amount NUMERIC,
  p_credit_amount NUMERIC
)
RETURNS public.ac_bank_transaction_rules
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT rule.*
  FROM public.ac_bank_transaction_rules rule
  WHERE rule.is_active = TRUE
    AND (rule.bank_setting_id IS NULL OR rule.bank_setting_id = p_bank_setting_id)
    AND (
      rule.direction = 'both'
      OR (rule.direction = 'credit' AND COALESCE(p_credit_amount, 0) > 0)
      OR (rule.direction = 'debit' AND COALESCE(p_debit_amount, 0) > 0)
    )
    AND concat_ws(' ', p_transaction_type, p_channel, p_description)
        ILIKE '%' || btrim(rule.match_keyword) || '%'
  ORDER BY
    CASE WHEN rule.bank_setting_id IS NOT NULL THEN 0 ELSE 1 END,
    rule.priority,
    length(rule.match_keyword) DESC,
    rule.created_at,
    rule.id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.bank_matching_rule(UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tr_classify_bank_statement_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rule public.ac_bank_transaction_rules;
BEGIN
  IF NEW.reconciliation_status = 'matched' THEN RETURN NEW; END IF;

  SELECT * INTO v_rule
  FROM public.bank_matching_rule(
    NEW.bank_setting_id,
    NEW.transaction_type,
    NEW.channel,
    NEW.description,
    NEW.debit_amount,
    NEW.credit_amount
  );

  IF FOUND THEN
    NEW.reconciliation_status := 'ignored';
    NEW.classification_rule_id := v_rule.id;
    NEW.classification_name := v_rule.classification_name;
    NEW.classified_at := now();
    NEW.classified_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_classify_bank_statement_transaction ON public.ac_bank_statement_transactions;
CREATE TRIGGER trg_classify_bank_statement_transaction
BEFORE INSERT OR UPDATE OF transaction_type, channel, description, debit_amount, credit_amount, bank_setting_id
ON public.ac_bank_statement_transactions
FOR EACH ROW EXECUTE FUNCTION public.tr_classify_bank_statement_transaction();

CREATE OR REPLACE FUNCTION public.bank_reconciliation_save_rule(
  p_rule_id UUID,
  p_rule_name TEXT,
  p_match_keyword TEXT,
  p_classification_name TEXT,
  p_bank_setting_id UUID,
  p_apply_existing BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_rule_id UUID;
  v_applied INTEGER := 0;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตั้งค่าการจำแนกรายการธนาคาร';
  END IF;
  IF length(btrim(COALESCE(p_match_keyword, ''))) < 3 THEN
    RAISE EXCEPTION 'คำที่ใช้จับคู่ต้องมีอย่างน้อย 3 ตัวอักษร';
  END IF;
  IF btrim(COALESCE(p_classification_name, '')) = '' THEN
    RAISE EXCEPTION 'กรุณาระบุชื่อประเภทเงินรับ';
  END IF;
  IF p_bank_setting_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.bank_settings WHERE id = p_bank_setting_id AND is_active = TRUE)
  THEN
    RAISE EXCEPTION 'ไม่พบบัญชีธนาคารที่เปิดใช้งาน';
  END IF;

  IF p_rule_id IS NULL THEN
    INSERT INTO public.ac_bank_transaction_rules (
      rule_name, match_keyword, classification_name, bank_setting_id,
      direction, created_by, updated_at
    ) VALUES (
      COALESCE(NULLIF(btrim(p_rule_name), ''), btrim(p_classification_name)),
      btrim(p_match_keyword),
      btrim(p_classification_name),
      p_bank_setting_id,
      'credit',
      auth.uid(),
      now()
    )
    RETURNING id INTO v_rule_id;
  ELSE
    UPDATE public.ac_bank_transaction_rules
    SET rule_name = COALESCE(NULLIF(btrim(p_rule_name), ''), btrim(p_classification_name)),
        match_keyword = btrim(p_match_keyword),
        classification_name = btrim(p_classification_name),
        bank_setting_id = p_bank_setting_id,
        updated_at = now()
    WHERE id = p_rule_id
    RETURNING id INTO v_rule_id;
    IF v_rule_id IS NULL THEN RAISE EXCEPTION 'ไม่พบกฎที่ต้องการแก้ไข'; END IF;
  END IF;

  IF COALESCE(p_apply_existing, TRUE) THEN
    UPDATE public.ac_bank_statement_transactions transaction
    SET reconciliation_status = 'ignored',
        classification_rule_id = v_rule_id,
        classification_name = btrim(p_classification_name),
        classified_at = now(),
        classified_by = auth.uid()
    WHERE transaction.credit_amount > 0
      AND transaction.reconciliation_status IN ('unmatched', 'ambiguous')
      AND (p_bank_setting_id IS NULL OR transaction.bank_setting_id = p_bank_setting_id)
      AND concat_ws(' ', transaction.transaction_type, transaction.channel, transaction.description)
          ILIKE '%' || btrim(p_match_keyword) || '%'
      AND NOT EXISTS (
        SELECT 1 FROM public.ac_bank_reconciliation_allocations allocation
        WHERE allocation.transaction_id = transaction.id
      );
    GET DIAGNOSTICS v_applied = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('rule_id', v_rule_id, 'applied_count', v_applied);
END;
$$;

CREATE OR REPLACE FUNCTION public.bank_reconciliation_unclassify_transaction(p_transaction_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();
  UPDATE public.ac_bank_statement_transactions
  SET reconciliation_status = 'unmatched',
      classification_rule_id = NULL,
      classification_name = NULL,
      classified_at = NULL,
      classified_by = NULL
  WHERE id = p_transaction_id
    AND reconciliation_status = 'ignored'
    AND NOT EXISTS (
      SELECT 1 FROM public.ac_bank_reconciliation_allocations allocation
      WHERE allocation.transaction_id = p_transaction_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.bank_reconciliation_save_rule(UUID, TEXT, TEXT, TEXT, UUID, BOOLEAN)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_save_rule(UUID, TEXT, TEXT, TEXT, UUID, BOOLEAN)
  TO authenticated;
REVOKE ALL ON FUNCTION public.bank_reconciliation_unclassify_transaction(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_unclassify_transaction(UUID)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
