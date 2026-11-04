-- QC's flattened bill UID can move when order lines are sorted/edited.
-- Keep results attached to the stable unit, even when display UIDs coincide.
BEGIN;

DROP INDEX IF EXISTS public.qc_records_session_item_uid_key;

-- Stable records remain protected by qc_records_session_stable_unit_key.
-- Preserve duplicate protection for legacy records without guessing identities.
CREATE UNIQUE INDEX IF NOT EXISTS qc_records_session_legacy_uid_key
  ON public.qc_records (session_id, item_uid)
  WHERE order_item_id IS NULL OR unit_index IS NULL;

COMMIT;
