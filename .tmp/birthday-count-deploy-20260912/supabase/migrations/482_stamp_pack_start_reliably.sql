-- Stamp the actual PACK start time as soon as packing is opened, with scan
-- triggers as database-side fallbacks. All writes use start_if_null so retries
-- never overwrite the original actual start time.

BEGIN;

CREATE OR REPLACE FUNCTION public.pk_start_work_order_packing(
  p_work_order_name TEXT,
  p_started_at TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_name TEXT;
  v_started_at TIMESTAMPTZ;
  v_tracks JSONB;
BEGIN
  SELECT role INTO v_role
  FROM public.us_users
  WHERE id = auth.uid();

  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'production', 'packing_staff') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์เริ่มแพ็ค (role: %)', coalesce(v_role, 'unknown');
  END IF;

  v_name := nullif(trim(coalesce(p_work_order_name, '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'p_work_order_name ห้ามว่าง';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.plan_jobs WHERE name = v_name) THEN
    RAISE EXCEPTION 'ไม่พบใบงาน % ใน Plan', v_name;
  END IF;

  v_started_at := coalesce(p_started_at, now());
  v_tracks := public.merge_plan_tracks_by_name(
    v_name,
    'PACK',
    jsonb_build_object(
      'เริ่มแพ็ค',
      jsonb_build_object('start_if_null', to_jsonb(v_started_at))
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'work_order_name', v_name,
    'started_at', v_started_at,
    'tracks', v_tracks
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pk_start_work_order_packing(TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pk_start_work_order_packing(TEXT, TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION public.pk_start_work_order_packing(TEXT, TIMESTAMPTZ) IS
'บันทึกเวลาเริ่ม PACK ลง Plan เมื่อเปิดใบงานในหน้าแพ็ค โดยไม่เขียนทับเวลาเดิม';

-- Historical triggers skipped admin/superadmin. A real packing action must stamp
-- Plan regardless of the operator role, so keep the compatibility helper but
-- make it consistently permit tracking.
CREATE OR REPLACE FUNCTION public.tr_pack_should_skip_track()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT false;
$$;

-- Fix the parcel transition check. The previous expression returned early for
-- exactly the false -> true transition that should have stamped PACK start.
CREATE OR REPLACE FUNCTION public.tr_or_orders_sync_pack_plan_on_parcel_scan()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo TEXT;
  v_new_scanned BOOLEAN;
  v_old_scanned BOOLEAN;
  v_ts TIMESTAMPTZ;
BEGIN
  v_new_scanned := coalesce((NEW.packing_meta->>'parcelScanned')::boolean, false);
  v_old_scanned := coalesce((OLD.packing_meta->>'parcelScanned')::boolean, false);

  IF NOT v_new_scanned OR v_old_scanned THEN
    RETURN NEW;
  END IF;

  v_wo := nullif(trim(coalesce(NEW.work_order_name, '')), '');
  IF v_wo IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_ts := nullif(NEW.packing_meta->>'scanTime', '')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    v_ts := NULL;
  END;

  PERFORM public.merge_plan_tracks_by_name(
    v_wo,
    'PACK',
    jsonb_build_object(
      'เริ่มแพ็ค',
      jsonb_build_object('start_if_null', to_jsonb(coalesce(v_ts, now())))
    )
  );
  RETURN NEW;
END;
$$;

-- Current packing scans are stored per unit in pk_packing_unit_scans. Stamp on
-- the first insert as another fallback if the client lost its start RPC call.
CREATE OR REPLACE FUNCTION public.tr_pk_unit_scan_sync_pack_plan_start()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo TEXT;
BEGIN
  SELECT nullif(trim(coalesce(o.work_order_name, '')), '')
  INTO v_wo
  FROM public.or_orders o
  WHERE o.id = NEW.order_id;

  IF v_wo IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM public.merge_plan_tracks_by_name(
    v_wo,
    'PACK',
    jsonb_build_object(
      'เริ่มแพ็ค',
      jsonb_build_object('start_if_null', to_jsonb(coalesce(NEW.scanned_at, now())))
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pk_unit_scan_sync_pack_plan_start ON public.pk_packing_unit_scans;
CREATE TRIGGER pk_unit_scan_sync_pack_plan_start
  AFTER INSERT OR UPDATE ON public.pk_packing_unit_scans
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_pk_unit_scan_sync_pack_plan_start();

COMMENT ON FUNCTION public.tr_pk_unit_scan_sync_pack_plan_start() IS
'สำรองการ Stamp เวลาเริ่ม PACK จากการสแกนชิ้นงานแรก';

-- Repair existing Plan rows that missed the stamp. Use the earliest durable
-- packing action available from parcel metadata or per-unit scans.
DO $$
DECLARE
  v_event RECORD;
BEGIN
  FOR v_event IN
    SELECT work_order_name, min(started_at) AS started_at
    FROM (
      SELECT
        nullif(trim(coalesce(o.work_order_name, '')), '') AS work_order_name,
        s.scanned_at AS started_at
      FROM public.pk_packing_unit_scans s
      JOIN public.or_orders o ON o.id = s.order_id

      UNION ALL

      SELECT
        nullif(trim(coalesce(o.work_order_name, '')), '') AS work_order_name,
        CASE
          WHEN coalesce(o.packing_meta->>'scanTime', '')
            ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'
          THEN (o.packing_meta->>'scanTime')::timestamptz
          ELSE NULL
        END AS started_at
      FROM public.or_orders o
      WHERE coalesce((o.packing_meta->>'parcelScanned')::boolean, false)
    ) packing_events
    WHERE work_order_name IS NOT NULL AND started_at IS NOT NULL
    GROUP BY work_order_name
  LOOP
    PERFORM public.merge_plan_tracks_by_name(
      v_event.work_order_name,
      'PACK',
      jsonb_build_object(
        'เริ่มแพ็ค',
        jsonb_build_object('start_if_null', to_jsonb(v_event.started_at))
      )
    );
  END LOOP;
END;
$$;

COMMIT;
