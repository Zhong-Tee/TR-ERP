-- Align existing tracking-number consumers with the rule introduced in 600:
-- cancelled ERP bills retain audit history but are not active match candidates.
BEGIN;

CREATE OR REPLACE FUNCTION public.pk_fill_packing_upload_report_channel_order_no()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.channel_order_no IS NULL THEN
    NEW.channel_order_no := OLD.channel_order_no;
  END IF;

  IF NEW.channel_order_no IS NULL THEN
    SELECT orders.channel_order_no
      INTO NEW.channel_order_no
    FROM public.or_orders orders
    WHERE orders.work_order_name = NEW.work_order_name
      AND COALESCE(orders.status, '') <> 'ยกเลิก'
      AND LOWER(REGEXP_REPLACE(COALESCE(orders.tracking_number, ''), '[[:space:]]+', '', 'g'))
          = LOWER(REGEXP_REPLACE(COALESCE(NEW.tracking_number, ''), '[[:space:]]+', '', 'g'))
      AND orders.channel_order_no IS NOT NULL
    ORDER BY orders.updated_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  RETURN NEW;
END;
$$;

-- These functions are large and may receive independent additions. Patch only
-- their duplicate-candidate predicates so this migration composes with the
-- latest installed definition instead of replacing unrelated logic.
DO $$
DECLARE
  v_before TEXT;
  v_after TEXT;
BEGIN
  SELECT pg_get_functiondef('public.rpc_update_order_limited_fields(uuid,jsonb,text,text,text,text)'::regprocedure)
  INTO v_before;
  v_after := replace(
    v_before,
    'WHERE id <> p_order_id AND tracking_number = v_tracking_number',
    'WHERE id <> p_order_id
      AND COALESCE(status, '''') <> ''ยกเลิก''
      AND upper(regexp_replace(COALESCE(tracking_number, ''''), ''[[:space:]]+'', '''', ''g''))
          = upper(regexp_replace(v_tracking_number, ''[[:space:]]+'', '''', ''g''))'
  );
  IF v_after = v_before THEN
    RAISE EXCEPTION 'Unable to patch rpc_update_order_limited_fields tracking predicate';
  END IF;
  EXECUTE v_after;

  SELECT pg_get_functiondef('public.rpc_plan_import_tracking_batch(text,jsonb)'::regprocedure)
  INTO v_before;
  v_after := replace(
    v_before,
    'WHERE other.id IS DISTINCT FROM v_order.id
        AND upper(btrim(other.tracking_number)) = v_tracking_normalized',
    'WHERE other.id IS DISTINCT FROM v_order.id
        AND COALESCE(other.status, '''') <> ''ยกเลิก''
        AND upper(btrim(other.tracking_number)) = v_tracking_normalized'
  );
  IF v_after = v_before THEN
    RAISE EXCEPTION 'Unable to patch rpc_plan_import_tracking_batch tracking predicate';
  END IF;
  EXECUTE v_after;

  SELECT pg_get_functiondef('public.tr_delivery_check_import(text,text,text,text,date,date,jsonb,jsonb)'::regprocedure)
  INTO v_before;
  v_after := replace(
    v_before,
    'WHERE public.tr_normalize_delivery_key(o.tracking_number) = v_tracking_key',
    'WHERE COALESCE(o.status, '''') <> ''ยกเลิก''
        AND public.tr_normalize_delivery_key(o.tracking_number) = v_tracking_key'
  );
  v_after := replace(
    v_after,
    'WHERE v_order_key <> '''' AND v_order_key IN (',
    'WHERE COALESCE(o.status, '''') <> ''ยกเลิก''
          AND v_order_key <> '''' AND v_order_key IN ('
  );
  IF v_after = v_before THEN
    RAISE EXCEPTION 'Unable to patch tr_delivery_check_import active-order predicates';
  END IF;
  EXECUTE v_after;
END;
$$;

COMMIT;
