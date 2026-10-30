-- Performance investigation only. Run blocks A-F individually in Supabase SQL Editor.
-- No schema/data changes. If a block times out, send its label and error; run ROLLBACK.
-- Best captured while users report slowness. No customer names, addresses or tokens selected.

-- A. Load, locks and table statistics (estimates, not exact counts).
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT jsonb_build_object(
  'captured_at', clock_timestamp(),
  'connections', (SELECT jsonb_agg(x) FROM (
    SELECT usename, state, wait_event_type, wait_event, count(*) AS connections
    FROM pg_stat_activity WHERE datname = current_database()
    GROUP BY usename, state, wait_event_type, wait_event
  ) x),
  'active_requests', (SELECT jsonb_agg(x) FROM (
    SELECT pid, usename, state, wait_event_type, wait_event,
      clock_timestamp() - query_start AS query_age,
      clock_timestamp() - xact_start AS transaction_age,
      pg_blocking_pids(pid) AS blockers
    FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND state IS DISTINCT FROM 'idle'
    ORDER BY query_start LIMIT 50
  ) x),
  'table_stats', (SELECT jsonb_agg(x) FROM (
    SELECT relname, n_live_tup, n_dead_tup, seq_scan, idx_scan,
      last_analyze, last_autoanalyze, last_autovacuum,
      pg_size_pretty(pg_total_relation_size(relid)) AS total_size
    FROM pg_stat_user_tables WHERE schemaname = 'public' AND relname IN (
      'or_orders','or_order_items','or_work_orders','qc_records','qc_sessions',
      'qc_skip_logs','pk_packing_unit_scans','pk_packing_upload_queue_reports',
      'wms_orders','plan_jobs','pr_products','inv_stock_movements',
      'inv_document_reservations','inv_stock_balances'
    ) ORDER BY pg_total_relation_size(relid) DESC
  ) x),
  'statement_stats_extension', (SELECT jsonb_agg(x) FROM (
    SELECT e.extname, n.nspname AS extension_schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_stat_statements'
  ) x)
) AS a_runtime_snapshot;
ROLLBACK;

-- B. Actual cardinality behind full-history loads and repeated report polling.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT jsonb_build_object(
  'orders_by_status', (SELECT jsonb_agg(x) FROM (
    SELECT status, count(*) AS rows FROM public.or_orders GROUP BY status
  ) x),
  'active_work_orders', (SELECT count(*) FROM public.or_work_orders WHERE status = 'กำลังผลิต'),
  'shipped_history_rows', (SELECT count(*) FROM public.or_orders
    WHERE status = 'จัดส่งแล้ว' AND work_order_name IS NOT NULL),
  'shipped_history_http_pages_at_1000', (SELECT floor(count(*) / 1000.0) + 1
    FROM public.or_orders WHERE status = 'จัดส่งแล้ว' AND work_order_name IS NOT NULL),
  'report_rows_by_status', (SELECT jsonb_agg(x) FROM (
    SELECT status, count(*) AS rows, min(client_created_at) AS oldest,
      max(client_created_at) AS newest
    FROM public.pk_packing_upload_queue_reports WHERE dismissed_at IS NULL GROUP BY status
  ) x),
  'wms_rows_read_for_assigned_names', (SELECT count(*) FROM public.wms_orders
    WHERE status <> 'cancelled' AND (fulfillment_mode = 'warehouse_pick' OR fulfillment_mode IS NULL)),
  'packing_scan_rows', (SELECT count(*) FROM public.pk_packing_unit_scans)
) AS b_load_volume;
ROLLBACK;

-- C. Largest current WOs. Lookup mirrors BOTH ID and name fallback in Packing.
-- A name may be reused; counts can therefore include historical bills.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
WITH current_wo AS (
  SELECT id, work_order_name, created_at FROM public.or_work_orders WHERE status = 'กำลังผลิต'
), linked AS (
  SELECT w.id AS wo_id, o.id AS order_id, o.status, o.work_order_id
  FROM current_wo w JOIN public.or_orders o ON o.work_order_id = w.id
  WHERE o.status <> 'ยกเลิก'
  UNION
  SELECT w.id, o.id, o.status, o.work_order_id
  FROM current_wo w JOIN public.or_orders o ON o.work_order_name = w.work_order_name
  WHERE o.status <> 'ยกเลิก'
), bill_counts AS (
  SELECT wo_id, count(*) AS bills,
    count(*) FILTER (WHERE status = 'จัดส่งแล้ว') AS shipped_bills_still_read,
    count(*) FILTER (WHERE work_order_id IS DISTINCT FROM wo_id) AS name_fallback_bills
  FROM linked GROUP BY wo_id
), item_counts AS (
  SELECT l.wo_id, count(*) AS item_rows,
    sum(greatest(coalesce(i.quantity,1),1)) AS approximate_units
  FROM linked l JOIN public.or_order_items i ON i.order_id = l.order_id
  WHERE NOT coalesce(i.is_detail_row,false)
    AND nullif(btrim(coalesce(i.cancellation_stock_action,'')),'') IS NULL
  GROUP BY l.wo_id
)
SELECT w.id, w.work_order_name, w.created_at, b.bills,
  b.shipped_bills_still_read, b.name_fallback_bills, i.item_rows, i.approximate_units
FROM current_wo w LEFT JOIN bill_counts b ON b.wo_id = w.id
LEFT JOIN item_counts i ON i.wo_id = w.id
ORDER BY i.approximate_units DESC NULLS LAST LIMIT 30;
ROLLBACK;

-- D. Deployed indexes, RLS and triggers: migrations on disk do not prove deployment.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT jsonb_build_object(
  'indexes', (SELECT jsonb_agg(x) FROM (
    SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
      AND tablename IN ('or_orders','or_order_items','or_work_orders','qc_records',
        'qc_sessions','qc_skip_logs','pk_packing_unit_scans','pk_packing_upload_queue_reports',
        'wms_orders','plan_jobs','inv_stock_movements','inv_document_reservations')
    ORDER BY tablename, indexname
  ) x),
  'policies', (SELECT jsonb_agg(x) FROM (
    SELECT tablename, policyname, roles, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = 'public'
      AND tablename IN ('or_orders','or_order_items','or_work_orders','qc_records',
        'qc_sessions','pk_packing_unit_scans','wms_orders','pr_products')
    ORDER BY tablename, policyname
  ) x),
  'triggers', (SELECT jsonb_agg(x) FROM (
    SELECT c.relname AS table_name, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname = 'public'
      AND c.relname IN ('or_orders','or_order_items','pk_packing_unit_scans','inv_stock_balances')
    ORDER BY c.relname, t.tgname
  ) x)
) AS d_deployed_schema;
ROLLBACK;

-- E. Deployed function definitions only; NO function execution.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (
  'get_sidebar_counts','get_orders_sidebar_actionable_count','get_purchase_badge_counts',
  'rpc_get_packing_wms_readiness','rpc_get_packing_wms_item_readiness',
  'fn_wms_item_fulfillment_mode','fn_document_reservation_changed',
  'fn_sync_document_reservations','fn_set_document_reservation',
  'rpc_get_wms_stock_anomalies','get_unread_chat_count',
  'merge_plan_tracks_by_name','merge_plan_tracks','tr_pk_unit_scan_sync_pack_plan_start'
) ORDER BY p.proname;
ROLLBACK;

-- F. Most expensive normalized SQL. Optional; run only if A reports the extension.
-- Supabase commonly installs it under extensions. If A shows another schema,
-- replace extensions.pg_stat_statements below with that schema.
-- Statistics are cumulative since last reset, NOT a measurement of this page alone.
-- Query text can contain identifiers; redact sensitive literal values before sharing.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT queryid, calls, round(total_exec_time::numeric,2) AS total_ms,
  round(mean_exec_time::numeric,2) AS mean_ms,
  round(max_exec_time::numeric,2) AS max_ms, rows,
  shared_blks_hit, shared_blks_read, temp_blks_written,
  left(query,1800) AS normalized_query
FROM extensions.pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND query NOT ILIKE '%pg_stat_statements%'
ORDER BY total_exec_time DESC LIMIT 35;
ROLLBACK;
