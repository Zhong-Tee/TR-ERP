BEGIN;

CREATE OR REPLACE FUNCTION public.tr_delivery_is_consignment(p_order_no TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT coalesce(p_order_no, '') ~* '(moshi|โมชิ|ฝากส่ง)'
    OR public.tr_normalize_delivery_key(p_order_no)
      !~ '^[A-Z][A-Z0-9]*[0-9]{2}(0[1-9]|1[0-2])[0-9]{4,}$';
$$;

-- Classify in the database as well as the file preview, including older clients.
CREATE OR REPLACE FUNCTION public.tr_delivery_classify_consignment()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.source_kind = 'carrier'
    AND public.tr_delivery_is_consignment(NEW.order_no) THEN
    NEW.is_consignment := true;
    NEW.match_status := 'consignment';
    NEW.note := coalesce(nullif(btrim(NEW.note), ''), nullif(btrim(NEW.order_no), ''));
    NEW.order_id := NULL;
    NEW.match_method := NULL;
    NEW.match_detail := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tr_delivery_classify_consignment
BEFORE INSERT ON public.tr_delivery_check_rows
FOR EACH ROW EXECUTE FUNCTION public.tr_delivery_classify_consignment();

UPDATE public.tr_delivery_check_rows
SET is_consignment = true,
    match_status = 'consignment',
    note = coalesce(nullif(btrim(note), ''), nullif(btrim(order_no), '')),
    order_id = NULL,
    match_method = NULL,
    match_detail = NULL,
    updated_at = now()
WHERE source_kind = 'carrier'
  AND match_status <> 'manual_match'
  AND public.tr_delivery_is_consignment(order_no);

-- The existing count trigger recalculates matched, consignment and open issues.
UPDATE public.tr_delivery_check_imports SET updated_at = now();

COMMIT;
