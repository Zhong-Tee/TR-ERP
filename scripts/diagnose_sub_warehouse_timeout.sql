-- Read-only investigation of the warehouse/sub daily-sheet timeout.
-- Run A-C independently in Supabase SQL Editor. No application data changes.
-- D-F execute reports: run ONE block at a time, preferably off peak.
-- On any timeout run ROLLBACK before continuing.

-- A. Deployed definitions (a local migration does not prove deployment).
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT p.proname, pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN (
  'rpc_get_sub_warehouse_daily_stock_sheet',
  'rpc_get_wms_usage_breakdown_by_product',
  'rpc_get_wms_correct_qty_by_product'
) ORDER BY p.proname;
ROLLBACK;

-- B. Volume and the actual expression indexes available to these lookups.
-- In particular, ordinary order_id/name indexes do not match BTRIM expressions.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT relname, n_live_tup, seq_scan, idx_scan, last_analyze, last_autoanalyze
FROM pg_stat_user_tables WHERE schemaname='public' AND relname IN (
  'wms_orders','wms_order_summaries','wms_requisitions','or_orders',
  'or_work_orders','wh_sub_warehouse_stock_moves'
) ORDER BY relname;
SELECT tablename,indexname,indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename IN (
  'wms_orders','wms_order_summaries','wms_requisitions','or_orders',
  'or_work_orders','wh_sub_warehouse_stock_moves'
) ORDER BY tablename,indexname;
SELECT s.id,s.name,count(p.product_id) AS assigned_products
FROM public.wh_sub_warehouses s
LEFT JOIN public.wh_sub_warehouse_products p ON p.sub_warehouse_id=s.id
GROUP BY s.id ORDER BY assigned_products DESC;
ROLLBACK;

-- C. Other concurrent queries or blockers while the error occurs.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT pid,usename,state,wait_event_type,wait_event,
  clock_timestamp()-query_start AS query_age,pg_blocking_pids(pid) AS blockers
FROM pg_stat_activity
WHERE datname=current_database() AND pid<>pg_backend_pid()
  AND state IS DISTINCT FROM 'idle'
ORDER BY query_start LIMIT 30;
ROLLBACK;

-- D. Daily-sheet timing. Replace the UUID with the affected warehouse from B.
-- EXPLAIN ANALYZE runs the read-only report; timeout is capped at 8 seconds.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '8s';
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)
SELECT * FROM public.rpc_get_sub_warehouse_daily_stock_sheet(
  '00000000-0000-0000-0000-000000000000'::uuid, DATE '2026-10-30'
);
ROLLBACK;

-- E. WMS breakdown timing, isolated from D (the UI needs both to succeed).
BEGIN READ ONLY;
SET LOCAL statement_timeout = '8s';
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)
SELECT * FROM public.rpc_get_wms_usage_breakdown_by_product(
  TIMESTAMPTZ '2026-10-30 00:00:00+07',
  TIMESTAMPTZ '2026-10-30 23:59:59.999+07'
);
ROLLBACK;

-- F. Legacy fallback timing. The UI currently attempts this after ANY breakdown
-- error, including timeout; this may add another expensive full-history scan.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '8s';
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)
SELECT * FROM public.rpc_get_wms_correct_qty_by_product(
  TIMESTAMPTZ '2026-10-30 00:00:00+07',
  TIMESTAMPTZ '2026-10-30 23:59:59.999+07'
);
ROLLBACK;
