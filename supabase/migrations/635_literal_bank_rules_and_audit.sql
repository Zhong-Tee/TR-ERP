BEGIN;
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
    AND strpos(lower(concat_ws(' ', p_transaction_type, p_channel, p_description)), lower(btrim(rule.match_keyword))) > 0
  ORDER BY
    CASE WHEN rule.bank_setting_id IS NOT NULL THEN 0 ELSE 1 END,
    rule.priority,
    length(rule.match_keyword) DESC,
    rule.created_at,
    rule.id
  LIMIT 1;
$$;


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

  IF v_rule.id IS NOT NULL THEN
    NEW.reconciliation_status := 'ignored';
    NEW.classification_rule_id := v_rule.id;
    NEW.classification_name := v_rule.classification_name;
    NEW.classified_at := now();
    NEW.classified_by := auth.uid();
  ELSIF NEW.reconciliation_status='ignored' THEN
    NEW.reconciliation_status := 'unmatched';
    NEW.classification_rule_id := NULL;
    NEW.classification_name := NULL;
    NEW.classified_at := NULL;
    NEW.classified_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;


CREATE TABLE public.ac_bank_classification_audit (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), transaction_id UUID NOT NULL,
 old_rule_id UUID, old_name TEXT, old_status TEXT, new_rule_id UUID, new_name TEXT, new_status TEXT,
 actor_id UUID, changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.ac_bank_classification_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY classification_audit_read ON public.ac_bank_classification_audit FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND role IN ('superadmin','account')));
CREATE FUNCTION public.tr_audit_bank_classification() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF ROW(OLD.classification_rule_id,OLD.classification_name,OLD.reconciliation_status) IS DISTINCT FROM
 ROW(NEW.classification_rule_id,NEW.classification_name,NEW.reconciliation_status) AND (OLD.reconciliation_status='ignored' OR NEW.reconciliation_status='ignored') THEN
 INSERT INTO public.ac_bank_classification_audit(transaction_id,old_rule_id,old_name,old_status,new_rule_id,new_name,new_status,actor_id)
 VALUES(NEW.id,OLD.classification_rule_id,OLD.classification_name,OLD.reconciliation_status,NEW.classification_rule_id,NEW.classification_name,NEW.reconciliation_status,auth.uid());
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER trg_audit_bank_classification AFTER UPDATE ON public.ac_bank_statement_transactions
 FOR EACH ROW EXECUTE FUNCTION public.tr_audit_bank_classification();

CREATE OR REPLACE FUNCTION public.tr_sync_bank_rule_classification_name() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.ac_bank_statement_transactions t
 SET reconciliation_status='unmatched',classification_rule_id=NULL,classification_name=NULL,classified_at=NULL,classified_by=NULL
 WHERE t.classification_rule_id=NEW.id AND t.reconciliation_status='ignored'
 AND (NOT NEW.is_active OR (NEW.bank_setting_id IS NOT NULL AND NEW.bank_setting_id<>t.bank_setting_id)
 OR NOT (NEW.direction='both' OR NEW.direction='credit' AND t.credit_amount>0 OR NEW.direction='debit' AND t.debit_amount>0)
 OR strpos(lower(concat_ws(' ',t.transaction_type,t.channel,t.description)),lower(btrim(NEW.match_keyword)))=0)
 AND NOT EXISTS(SELECT 1 FROM public.ac_bank_reconciliation_allocations a WHERE a.transaction_id=t.id);
 UPDATE public.ac_bank_statement_transactions SET classification_name=NEW.classification_name
 WHERE classification_rule_id=NEW.id AND reconciliation_status='ignored' AND classification_name IS DISTINCT FROM NEW.classification_name;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_sync_bank_rule_classification_name ON public.ac_bank_transaction_rules;
CREATE TRIGGER trg_sync_bank_rule_classification_name AFTER UPDATE ON public.ac_bank_transaction_rules
 FOR EACH ROW EXECUTE FUNCTION public.tr_sync_bank_rule_classification_name();

-- Return invalid historical classifications to the review queue, retaining audit.
UPDATE public.ac_bank_statement_transactions t
SET reconciliation_status='unmatched',classification_rule_id=NULL,classification_name=NULL,classified_at=NULL,classified_by=NULL
WHERE t.reconciliation_status='ignored' AND NOT EXISTS(
 SELECT 1 FROM public.ac_bank_transaction_rules r WHERE r.id=t.classification_rule_id AND r.is_active
 AND (r.bank_setting_id IS NULL OR r.bank_setting_id=t.bank_setting_id)
 AND (r.direction='both' OR r.direction='credit' AND t.credit_amount>0 OR r.direction='debit' AND t.debit_amount>0)
 AND strpos(lower(concat_ws(' ',t.transaction_type,t.channel,t.description)),lower(btrim(r.match_keyword)))>0)
 AND NOT EXISTS(SELECT 1 FROM public.ac_bank_reconciliation_allocations a WHERE a.transaction_id=t.id);
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

  IF COALESCE(p_apply_existing, TRUE) AND EXISTS (SELECT 1 FROM public.ac_bank_transaction_rules WHERE id=v_rule_id AND is_active) THEN
    UPDATE public.ac_bank_statement_transactions transaction
    SET reconciliation_status = 'ignored',
        classification_rule_id = v_rule_id,
        classification_name = btrim(p_classification_name),
        classified_at = now(),
        classified_by = auth.uid()
    WHERE transaction.credit_amount > 0
      AND transaction.reconciliation_status IN ('unmatched', 'ambiguous')
      AND (p_bank_setting_id IS NULL OR transaction.bank_setting_id = p_bank_setting_id)
      AND strpos(lower(concat_ws(' ', transaction.transaction_type, transaction.channel, transaction.description)), lower(btrim(p_match_keyword))) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.ac_bank_reconciliation_allocations allocation
        WHERE allocation.transaction_id = transaction.id
      );
    GET DIAGNOSTICS v_applied = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('rule_id', v_rule_id, 'applied_count', v_applied);
END;
$$;


NOTIFY pgrst, 'reload schema';
COMMIT;
