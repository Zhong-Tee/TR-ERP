-- Stamp PACK start on plan_jobs when packing actually starts.
-- This avoids missing "เริ่มแพ็ค" due to client/network issues in Packing UI.
--
-- We stamp PACK start on the earliest "real action" signals:
-- 1) An order item is scanned: or_order_items.packing_status becomes 'สแกนแล้ว'
-- 2) A parcel is scanned: or_orders.packing_meta.parcelScanned becomes true
--
-- Both triggers call merge_plan_tracks_by_name(work_order_name, 'PACK', { 'เริ่มแพ็ค': { start_if_null: <ts> } })
-- and skip admin/superadmin (to match UI logic).

CREATE OR REPLACE FUNCTION tr_pack_should_skip_track() RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  SELECT u.role INTO v_role
  FROM us_users u
  WHERE u.id = auth.uid()
  LIMIT 1;
  RETURN v_role IN ('admin', 'superadmin');
END;
$$;

-- 1) Item scan -> stamp PACK start
CREATE OR REPLACE FUNCTION tr_or_order_items_sync_pack_plan_on_scan()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo text;
  v_ts timestamptz;
  v_patch jsonb;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF tr_pack_should_skip_track() THEN
    RETURN NEW;
  END IF;

  -- Only when status transitions to "สแกนแล้ว"
  IF NEW.packing_status IS DISTINCT FROM 'สแกนแล้ว'
     OR OLD.packing_status IS NOT DISTINCT FROM NEW.packing_status THEN
    RETURN NEW;
  END IF;

  SELECT NULLIF(trim(both FROM coalesce(o.work_order_name, '')), '')
    INTO v_wo
  FROM or_orders o
  WHERE o.id = NEW.order_id
  LIMIT 1;
  IF v_wo IS NULL THEN
    RETURN NEW;
  END IF;

  v_ts := COALESCE(NEW.item_scan_time, now());
  v_patch := jsonb_build_object(
    'เริ่มแพ็ค', jsonb_build_object('start_if_null', to_jsonb(v_ts))
  );

  PERFORM merge_plan_tracks_by_name(v_wo, 'PACK', v_patch);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS or_order_items_sync_pack_plan_on_scan ON or_order_items;

CREATE TRIGGER or_order_items_sync_pack_plan_on_scan
  AFTER UPDATE OF packing_status ON or_order_items
  FOR EACH ROW
  EXECUTE FUNCTION tr_or_order_items_sync_pack_plan_on_scan();

COMMENT ON FUNCTION tr_or_order_items_sync_pack_plan_on_scan() IS
  'After or_order_items.packing_status becomes สแกนแล้ว, stamp PACK เริ่มแพ็ค.start on latest plan_jobs row for the related work order (skip admin/superadmin).';

-- 2) Parcel scan -> stamp PACK start
CREATE OR REPLACE FUNCTION tr_or_orders_sync_pack_plan_on_parcel_scan()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo text;
  v_new_scanned boolean;
  v_old_scanned boolean;
  v_ts timestamptz;
  v_patch jsonb;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF tr_pack_should_skip_track() THEN
    RETURN NEW;
  END IF;

  v_new_scanned := COALESCE((NEW.packing_meta->>'parcelScanned')::boolean, false);
  v_old_scanned := COALESCE((OLD.packing_meta->>'parcelScanned')::boolean, false);
  IF v_new_scanned IS DISTINCT FROM true OR v_old_scanned IS NOT DISTINCT FROM false THEN
    RETURN NEW;
  END IF;

  v_wo := NULLIF(trim(both FROM coalesce(NEW.work_order_name, '')), '');
  IF v_wo IS NULL THEN
    RETURN NEW;
  END IF;

  -- Prefer scanTime in meta if present
  v_ts := COALESCE((NEW.packing_meta->>'scanTime')::timestamptz, now());
  v_patch := jsonb_build_object(
    'เริ่มแพ็ค', jsonb_build_object('start_if_null', to_jsonb(v_ts))
  );

  PERFORM merge_plan_tracks_by_name(v_wo, 'PACK', v_patch);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS or_orders_sync_pack_plan_on_parcel_scan ON or_orders;

CREATE TRIGGER or_orders_sync_pack_plan_on_parcel_scan
  AFTER UPDATE OF packing_meta ON or_orders
  FOR EACH ROW
  EXECUTE FUNCTION tr_or_orders_sync_pack_plan_on_parcel_scan();

COMMENT ON FUNCTION tr_or_orders_sync_pack_plan_on_parcel_scan() IS
  'After or_orders.packing_meta.parcelScanned becomes true, stamp PACK เริ่มแพ็ค.start on latest plan_jobs row for the related work order (skip admin/superadmin).';

