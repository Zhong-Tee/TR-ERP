-- Read-only, RLS-preserving packing lists. Deploy before the matching client.
BEGIN;

CREATE OR REPLACE FUNCTION public.pk_list_search_key(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  SELECT lower(regexp_replace(p_value,
    U&'[[:space:]\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]', '', 'g'));
$$;

CREATE OR REPLACE FUNCTION public.pk_shipped_work_orders_page(
  p_page integer DEFAULT 1, p_page_size integer DEFAULT 50,
  p_date_from date DEFAULT NULL, p_date_to date DEFAULT NULL,
  p_channel text DEFAULT NULL, p_packer text DEFAULT NULL, p_search text DEFAULT ''
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  WITH history AS MATERIALIZED (
    SELECT id, work_order_id, work_order_name, shipped_time, channel_code, shipped_by,
      bill_no, customer_name, tracking_number, express_receipt_number
    FROM public.or_orders
    WHERE status = 'จัดส่งแล้ว' AND work_order_name IS NOT NULL
  ), filtered AS (
    SELECT * FROM history
    -- Preserve the existing UTC calendar-date filtering, including undated rows.
    WHERE work_order_name <> ''
      AND (p_date_from IS NULL OR (shipped_time AT TIME ZONE 'UTC')::date >= p_date_from)
      AND (p_date_to IS NULL OR shipped_time IS NULL OR (shipped_time AT TIME ZONE 'UTC')::date <= p_date_to)
      AND (nullif(p_channel, '') IS NULL OR channel_code = p_channel)
      AND (nullif(p_packer, '') IS NULL OR shipped_by = p_packer)
  ), grouped AS MATERIALIZED (
    SELECT work_order_id, work_order_name, count(*) AS order_count,
      max(shipped_time) AS shipped_time,
      coalesce(jsonb_agg(DISTINCT channel_code) FILTER (WHERE nullif(channel_code, '') IS NOT NULL), '[]') AS channels,
      coalesce(jsonb_agg(DISTINCT shipped_by) FILTER (WHERE nullif(shipped_by, '') IS NOT NULL), '[]') AS packers
    FROM filtered
    GROUP BY work_order_id, work_order_name
    -- Search selects whole groups, not just the bill that matched.
    HAVING btrim(coalesce(p_search, '')) = '' OR bool_or(
      strpos(lower(coalesce(bill_no, '')), lower(btrim(p_search))) > 0
      OR strpos(lower(coalesce(customer_name, '')), lower(btrim(p_search))) > 0
      OR (public.pk_list_search_key(p_search) <> '' AND (
        strpos(public.pk_list_search_key(coalesce(tracking_number, '')), public.pk_list_search_key(p_search)) > 0
        OR strpos(public.pk_list_search_key(coalesce(express_receipt_number, '')), public.pk_list_search_key(p_search)) > 0
      ))
    )
  ), bounds AS (
    SELECT count(*) AS total, greatest(1, least(coalesce(p_page_size, 50), 100)) AS size
    FROM grouped
  ), pagination AS (
    SELECT *, greatest(1, least(greatest(coalesce(p_page, 1), 1),
      greatest(1, ceil(total::numeric / size)::integer))) AS page FROM bounds
  ), page_rows AS (
    SELECT * FROM grouped
    ORDER BY shipped_time ASC NULLS FIRST, work_order_name, work_order_id NULLS FIRST
    LIMIT (SELECT size FROM pagination)
    OFFSET (SELECT (page - 1)::bigint * size FROM pagination)
  )
  SELECT jsonb_build_object(
    'rows', coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.shipped_time ASC NULLS FIRST, r.work_order_name, r.work_order_id NULLS FIRST) FROM page_rows r), '[]'),
    'total', total, 'page', page,
    'channels', coalesce((SELECT jsonb_agg(v ORDER BY v) FROM (SELECT DISTINCT channel_code AS v FROM history WHERE nullif(btrim(channel_code), '') IS NOT NULL) f), '[]'),
    'packers', coalesce((SELECT jsonb_agg(v ORDER BY v) FROM (SELECT DISTINCT shipped_by AS v FROM history WHERE nullif(btrim(shipped_by), '') IS NOT NULL) f), '[]')
  ) FROM pagination;
$$;

CREATE OR REPLACE FUNCTION public.pk_upload_reports_page(
  p_page integer DEFAULT 1, p_page_size integer DEFAULT 50,
  p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL,
  p_device_id text DEFAULT NULL, p_search text DEFAULT '', p_status text DEFAULT NULL
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  WITH visible AS NOT MATERIALIZED (
    SELECT id, user_id, recorded_by, device_id, device_name, folder_name, folder_path,
      work_order_name, tracking_number, channel_order_no, filename, storage_path,
      file_size_bytes, duration_seconds, status, retry_count, last_error, local_deleted,
      client_created_at, client_updated_at, uploaded_at, reported_at, quality_profile,
      requested_width, requested_height, requested_fps, requested_bitrate,
      actual_width, actual_height, actual_fps, mime_type, codec, recorder_bitrate, actual_bitrate
    FROM public.pk_packing_upload_queue_reports WHERE dismissed_at IS NULL
  ), searched AS MATERIALIZED (
    -- Keep the materialized search/summary working set narrow. Fetch wide video
    -- metadata only for the displayed IDs, avoiding temp-file spills on history.
    SELECT id, client_created_at, CASE
      WHEN status IN ('pending', 'uploading') AND (
        reported_at IS NULL OR NOT isfinite(reported_at)
        OR reported_at <= now() - CASE WHEN status = 'pending' THEN interval '30 minutes' ELSE interval '10 minutes' END
      ) THEN 'failed' ELSE status END AS effective_status
    FROM visible r
    WHERE (p_from IS NULL OR client_created_at >= p_from)
      -- JS Date filters have millisecond precision; retain the entire final ms.
      AND (p_to IS NULL OR client_created_at < p_to + interval '1 millisecond')
      AND (nullif(p_device_id, '') IS NULL OR device_id = p_device_id)
      AND (coalesce(public.pk_list_search_key(p_search), '') = '' OR EXISTS (
        SELECT 1 FROM unnest(ARRAY[recorded_by, device_name, folder_path, folder_name,
          work_order_name, tracking_number, channel_order_no, filename]) AS fields(value)
        WHERE strpos(public.pk_list_search_key(coalesce(value, '')), public.pk_list_search_key(p_search)) > 0
      ))
  ), matching AS (
    SELECT * FROM searched WHERE nullif(p_status, '') IS NULL OR effective_status = p_status
  ), bounds AS (
    SELECT count(*) AS total, greatest(1, least(coalesce(p_page_size, 50), 100)) AS size FROM matching
  ), pagination AS (
    SELECT *, greatest(1, least(greatest(coalesce(p_page, 1), 1),
      greatest(1, ceil(total::numeric / size)::integer))) AS page FROM bounds
  ), page_ids AS (
    SELECT id FROM matching ORDER BY client_created_at DESC, id DESC
    LIMIT (SELECT size FROM pagination)
    OFFSET (SELECT (page - 1)::bigint * size FROM pagination)
  ), page_rows AS (
    SELECT v.* FROM visible v JOIN page_ids p ON p.id = v.id
  )
  SELECT jsonb_build_object(
    'rows', coalesce((SELECT jsonb_agg(to_jsonb(r) - 'effective_status' ORDER BY r.client_created_at DESC, r.id DESC) FROM page_rows r), '[]'),
    'total', total, 'page', page, 'as_of', now(),
    'summary', (SELECT jsonb_build_object(
      'pending', count(*) FILTER (WHERE effective_status = 'pending'),
      'uploading', count(*) FILTER (WHERE effective_status = 'uploading'),
      'success', count(*) FILTER (WHERE effective_status = 'success'),
      'failed', count(*) FILTER (WHERE effective_status = 'failed')
    ) FROM searched),
    'stations', coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.last_seen_at DESC, d.device_id) FROM (
      SELECT device_id, user_id, device_name, last_username, is_active, quality_profile,
        folder_name, folder_path, pending_count, uploading_count, failed_count, last_seen_at
      FROM public.pk_packing_devices WHERE is_active = true
    ) d), '[]'),
    'devices', coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.device_id) FROM (
      SELECT DISTINCT ON (device_id) device_id, device_name FROM visible
      ORDER BY device_id, client_created_at DESC, id DESC
    ) d), '[]')
  ) FROM pagination;
$$;

REVOKE ALL ON FUNCTION public.pk_list_search_key(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pk_shipped_work_orders_page(integer,integer,date,date,text,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pk_upload_reports_page(integer,integer,timestamptz,timestamptz,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pk_list_search_key(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pk_shipped_work_orders_page(integer,integer,date,date,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pk_upload_reports_page(integer,integer,timestamptz,timestamptz,text,text,text) TO authenticated;
COMMIT;
