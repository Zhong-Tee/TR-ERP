-- Read-only checks. Run while a work-order request is slow, using a DBA session.
-- No work-order creation, stock changes, or EXPLAIN ANALYZE on write functions.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';

-- Distinguish lock waits from active execution; query text may contain bill IDs.
SELECT pid, state, wait_event_type, wait_event,
       now() - query_start AS duration, pg_blocking_pids(pid) AS blocking_pids,
       left(query, 500) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid()
  AND state <> 'idle'
ORDER BY query_start;

SELECT rolname, rolconfig FROM pg_roles
WHERE rolname IN ('authenticated', 'authenticator', 'anon');

-- Verify the deployed functions and triggers, rather than assuming local migrations match.
SELECT p.proname, pg_get_functiondef(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (
  'rpc_create_work_order_with_plan', 'rpc_next_work_order_name',
  'fn_wms_try_auto_consume_non_pick', 'trg_or_orders_try_auto_non_pick',
  'fn_sync_document_reservations', 'or_work_order_refund_blocks'
);

SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid)
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname = 'public'
  AND c.relname IN ('or_orders', 'or_work_orders', 'wms_orders')
ORDER BY c.relname, t.tgname;

-- In particular check wms_orders(source_order_item_id) and
-- inv_stock_movements(ref_type,ref_id), including equivalent/partial indexes.
SELECT tablename, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename IN (
  'or_orders', 'or_order_items', 'or_work_orders', 'wms_orders',
  'inv_stock_movements', 'ac_refunds', 'ac_verified_slips'
) ORDER BY tablename, indexname;

SELECT relname, n_live_tup, n_dead_tup, last_analyze, last_autoanalyze
FROM pg_stat_user_tables WHERE schemaname = 'public' AND relname IN (
  'or_orders', 'or_order_items', 'or_work_orders', 'wms_orders',
  'inv_stock_movements', 'inv_stock_lots'
);
ROLLBACK;

-- Also retrieve the failed request's Postgres log entry, including CONTEXT.
-- The UI error alone cannot identify which RPC or nested statement timed out.
