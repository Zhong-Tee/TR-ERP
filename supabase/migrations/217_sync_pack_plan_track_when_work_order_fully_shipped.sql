-- When every non-cancelled bill under a work_order_name is "จัดส่งแล้ว", stamp PACK on plan_jobs
-- (same intent as Packing.tsx checkAndMarkPackEnd). Covers OFFICE auto-ship, manual DB fixes, and future flows.

CREATE OR REPLACE FUNCTION tr_or_orders_sync_pack_plan_when_wo_shipped()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo text;
  v_pending int;
  v_now timestamptz;
  v_patch jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM 'จัดส่งแล้ว'
       OR OLD.status IS NOT DISTINCT FROM NEW.status THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'จัดส่งแล้ว' THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  v_wo := NULLIF(trim(both FROM coalesce(NEW.work_order_name, '')), '');
  IF v_wo IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::int INTO v_pending
  FROM or_orders o
  WHERE o.work_order_name = v_wo
    AND o.status IS DISTINCT FROM 'ยกเลิก'
    AND o.status IS DISTINCT FROM 'จัดส่งแล้ว';

  IF v_pending > 0 THEN
    RETURN NEW;
  END IF;

  v_now := COALESCE(NEW.shipped_time, now());
  v_patch := jsonb_build_object(
    'เริ่มแพ็ค', jsonb_build_object(
      'start_if_null', to_jsonb(v_now),
      'end', to_jsonb(v_now)
    ),
    'เสร็จแล้ว', jsonb_build_object(
      'start_if_null', to_jsonb(v_now),
      'end', to_jsonb(v_now)
    )
  );

  PERFORM merge_plan_tracks_by_name(v_wo, 'PACK', v_patch);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS or_orders_sync_pack_plan_on_ship ON or_orders;

CREATE TRIGGER or_orders_sync_pack_plan_on_ship
  AFTER INSERT OR UPDATE OF status ON or_orders
  FOR EACH ROW
  EXECUTE FUNCTION tr_or_orders_sync_pack_plan_when_wo_shipped();

COMMENT ON FUNCTION tr_or_orders_sync_pack_plan_when_wo_shipped() IS
  'After a bill becomes จัดส่งแล้ว, if all non-cancelled bills in that work order are shipped, set PACK เริ่มแพ็ค+เสร็จแล้ว on latest plan_jobs row.';
