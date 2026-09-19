-- Flag tracking numbers that have appeared in an earlier delivery-check import.
-- Repeated rows remain importable because a carrier may genuinely re-pick up a parcel.
BEGIN;

ALTER TABLE public.tr_delivery_check_rows
  ADD COLUMN IF NOT EXISTS has_previous_import BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS previous_import_id UUID REFERENCES public.tr_delivery_check_imports(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS previous_file_name TEXT,
  ADD COLUMN IF NOT EXISTS previous_carrier TEXT,
  ADD COLUMN IF NOT EXISTS previous_imported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS previous_pickup_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tr_delivery_rows_previous_import
  ON public.tr_delivery_check_rows(previous_import_id)
  WHERE previous_import_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tr_delivery_check_mark_previous_import()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_previous RECORD;
BEGIN
  IF NEW.source_kind <> 'carrier' OR coalesce(NEW.tracking_no_normalized, '') = '' THEN
    RETURN NEW;
  END IF;

  SELECT
    old_row.import_id,
    old_row.pickup_at,
    old_import.file_name,
    old_import.carrier,
    old_import.uploaded_at
  INTO v_previous
  FROM public.tr_delivery_check_rows old_row
  JOIN public.tr_delivery_check_imports old_import ON old_import.id = old_row.import_id
  WHERE old_row.source_kind = 'carrier'
    AND old_row.import_id <> NEW.import_id
    AND old_row.tracking_no_normalized = NEW.tracking_no_normalized
  ORDER BY old_import.uploaded_at DESC, old_row.created_at DESC
  LIMIT 1;

  IF v_previous.import_id IS NOT NULL THEN
    NEW.has_previous_import := true;
    NEW.previous_import_id := v_previous.import_id;
    NEW.previous_file_name := v_previous.file_name;
    NEW.previous_carrier := v_previous.carrier;
    NEW.previous_imported_at := v_previous.uploaded_at;
    NEW.previous_pickup_at := v_previous.pickup_at;
    NEW.match_detail := concat_ws(' / ', NEW.match_detail, 'Tracking นี้เคยนำเข้าแล้ว');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tr_delivery_check_mark_previous_import ON public.tr_delivery_check_rows;
CREATE TRIGGER trg_tr_delivery_check_mark_previous_import
BEFORE INSERT ON public.tr_delivery_check_rows
FOR EACH ROW EXECUTE FUNCTION public.tr_delivery_check_mark_previous_import();

-- Backfill existing import history in chronological order.
WITH previous_matches AS (
  SELECT
    current_row.id AS current_row_id,
    old_row.import_id AS previous_import_id,
    old_row.pickup_at AS previous_pickup_at,
    old_import.file_name AS previous_file_name,
    old_import.carrier AS previous_carrier,
    old_import.uploaded_at AS previous_imported_at,
    row_number() OVER (
      PARTITION BY current_row.id
      ORDER BY old_import.uploaded_at DESC, old_row.created_at DESC
    ) AS sequence_no
  FROM public.tr_delivery_check_rows current_row
  JOIN public.tr_delivery_check_imports current_import ON current_import.id = current_row.import_id
  JOIN public.tr_delivery_check_rows old_row
    ON old_row.source_kind = 'carrier'
   AND old_row.tracking_no_normalized = current_row.tracking_no_normalized
   AND old_row.import_id <> current_row.import_id
  JOIN public.tr_delivery_check_imports old_import ON old_import.id = old_row.import_id
  WHERE current_row.source_kind = 'carrier'
    AND current_row.tracking_no_normalized <> ''
    AND (
      old_import.uploaded_at < current_import.uploaded_at
      OR (old_import.uploaded_at = current_import.uploaded_at AND old_import.id::TEXT < current_import.id::TEXT)
    )
)
UPDATE public.tr_delivery_check_rows current_row
SET has_previous_import = true,
    previous_import_id = previous.previous_import_id,
    previous_file_name = previous.previous_file_name,
    previous_carrier = previous.previous_carrier,
    previous_imported_at = previous.previous_imported_at,
    previous_pickup_at = previous.previous_pickup_at,
    match_detail = concat_ws(' / ', current_row.match_detail, 'Tracking นี้เคยนำเข้าแล้ว'),
    updated_at = now()
FROM previous_matches previous
WHERE previous.sequence_no = 1
  AND current_row.id = previous.current_row_id;

CREATE OR REPLACE FUNCTION public.tr_delivery_check_refresh_import_counts()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  SELECT
    count(*) FILTER (WHERE source_kind = 'carrier'),
    count(*) FILTER (WHERE match_status IN ('matched', 'manual_match')),
    count(*) FILTER (
      WHERE match_status NOT IN ('matched', 'manual_match', 'consignment')
         OR has_duplicate
         OR has_previous_import
    ),
    count(*) FILTER (WHERE match_status = 'consignment'),
    count(*) FILTER (WHERE match_status = 'system_only')
  INTO
    NEW.source_row_count,
    NEW.matched_count,
    NEW.issue_count,
    NEW.consignment_count,
    NEW.system_only_count
  FROM public.tr_delivery_check_rows
  WHERE import_id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tr_delivery_check_refresh_import_counts ON public.tr_delivery_check_imports;
CREATE TRIGGER trg_tr_delivery_check_refresh_import_counts
BEFORE UPDATE ON public.tr_delivery_check_imports
FOR EACH ROW EXECUTE FUNCTION public.tr_delivery_check_refresh_import_counts();

-- Refresh counts for historical imports after the backfill.
UPDATE public.tr_delivery_check_imports SET updated_at = now();

COMMIT;
