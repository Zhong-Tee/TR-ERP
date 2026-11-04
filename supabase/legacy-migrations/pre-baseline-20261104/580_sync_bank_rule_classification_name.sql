-- Keep the displayed classification on existing Statement transactions in
-- sync when an account user renames a classification rule.
BEGIN;

CREATE OR REPLACE FUNCTION public.tr_sync_bank_rule_classification_name()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.classification_name IS DISTINCT FROM OLD.classification_name THEN
    UPDATE public.ac_bank_statement_transactions tx
    SET classification_name = NEW.classification_name
    WHERE tx.classification_rule_id = NEW.id
      AND tx.reconciliation_status = 'ignored';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_bank_rule_classification_name
  ON public.ac_bank_transaction_rules;
CREATE TRIGGER trg_sync_bank_rule_classification_name
AFTER UPDATE OF classification_name
ON public.ac_bank_transaction_rules
FOR EACH ROW EXECUTE FUNCTION public.tr_sync_bank_rule_classification_name();

-- Repair names that became out of sync before this trigger was installed.
UPDATE public.ac_bank_statement_transactions tx
SET classification_name = rule.classification_name
FROM public.ac_bank_transaction_rules rule
WHERE tx.classification_rule_id = rule.id
  AND tx.reconciliation_status = 'ignored'
  AND tx.classification_name IS DISTINCT FROM rule.classification_name;

NOTIFY pgrst, 'reload schema';
COMMIT;
