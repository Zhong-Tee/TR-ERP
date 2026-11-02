// Isolated PostgreSQL regression tests. No live connection or customer data.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'

const db = new PGlite()
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
let checks = 0
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  checks++
}
await db.exec(`
  CREATE ROLE authenticated; CREATE ROLE anon;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
  $$;
  CREATE TABLE public.or_orders (
    id uuid PRIMARY KEY, owner_id uuid, work_order_id uuid, work_order_name text,
    shipped_time timestamptz, channel_code text, shipped_by text, bill_no text,
    customer_name text, tracking_number text, express_receipt_number text, status text
  );
  CREATE TABLE public.pk_packing_upload_queue_reports (
    id uuid PRIMARY KEY, user_id uuid, recorded_by text, device_id text, device_name text,
    folder_name text, folder_path text, work_order_name text, tracking_number text,
    channel_order_no text, filename text, storage_path text, file_size_bytes bigint,
    duration_seconds numeric, status text, retry_count int, last_error text,
    local_deleted boolean, client_created_at timestamptz, client_updated_at timestamptz,
    uploaded_at timestamptz, reported_at timestamptz, quality_profile text,
    requested_width int, requested_height int, requested_fps numeric, requested_bitrate numeric,
    actual_width int, actual_height int, actual_fps numeric, mime_type text, codec text,
    recorder_bitrate numeric, actual_bitrate numeric, dismissed_at timestamptz
  );
  CREATE TABLE public.pk_packing_devices (
    device_id text PRIMARY KEY, user_id uuid, device_name text, last_username text,
    is_active boolean, quality_profile text, folder_name text, folder_path text,
    pending_count int, uploading_count int, failed_count int, last_seen_at timestamptz
  );
  ALTER TABLE public.pk_packing_devices ENABLE ROW LEVEL SECURITY;
  CREATE POLICY own_devices ON public.pk_packing_devices FOR SELECT TO authenticated USING (user_id = auth.uid());
  ALTER TABLE public.or_orders ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.pk_packing_upload_queue_reports ENABLE ROW LEVEL SECURITY;
  CREATE POLICY own_orders ON public.or_orders FOR SELECT TO authenticated USING (owner_id = auth.uid());
  CREATE POLICY own_reports ON public.pk_packing_upload_queue_reports FOR SELECT TO authenticated USING (user_id = auth.uid());
  GRANT USAGE ON SCHEMA public, auth TO authenticated;
  GRANT SELECT ON public.or_orders, public.pk_packing_upload_queue_reports, public.pk_packing_devices TO authenticated;
`)
const migration = await fs.readFile('supabase/migrations/690_packing_history_and_report_pagination.sql', 'utf8')
await db.exec(migration)
await db.exec(migration) // repeatable deployment, no grant changes

const orders = [
  [1, 1, 101, 'REUSED', '2026-10-30T23:30:00Z', 'SHOP', 'A', 'BILL1', 'คุณ ก', 'TH 123', 'EX 456', 'จัดส่งแล้ว'],
  [2, 1, 101, 'REUSED', '2026-10-30T20:00:00Z', 'SHOP', 'B', 'BILL2', 'Other', 'TH789', null, 'จัดส่งแล้ว'],
  [3, 1, 102, 'REUSED', '2026-10-29T20:00:00Z', 'WEB', 'C', 'BILL3', 'Literal % (test)', 'XX', null, 'จัดส่งแล้ว'],
  [4, 1, null, 'REUSED', null, 'OLD', 'D', 'BILL4', 'Legacy', null, null, 'จัดส่งแล้ว'],
  [5, 2, 103, 'OTHER USER', '2026-10-30T10:00:00Z', 'SECRET', 'PRIVATE', 'BILL5', '', null, null, 'จัดส่งแล้ว'],
  [6, 1, 104, 'CANCELLED', '2026-10-30T10:00:00Z', 'CANCELLED', '', 'BILL6', '', null, null, 'ยกเลิก'],
]
for (const row of orders) {
  const [id, owner, wo, ...rest] = row
  await db.query('INSERT INTO or_orders VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [uuid(id), uuid(owner), wo ? uuid(wo) : null, ...rest])
}
// More than 1,000 reports; equal timestamps exercise stable cross-page ordering.
await db.exec(`
  INSERT INTO pk_packing_devices VALUES
    ('active','${uuid(1)}','Active Device','Maprang',true,'standard',NULL,NULL,1,1,4,now()),
    ('retired','${uuid(1)}','Retired','Maprang',false,'standard',NULL,NULL,0,0,0,now()),
    ('private','${uuid(2)}','Private','Other',true,'standard',NULL,NULL,0,0,0,now());
  INSERT INTO pk_packing_upload_queue_reports
    (id,user_id,recorded_by,device_id,device_name,work_order_name,tracking_number,
     filename,status,client_created_at,reported_at)
  SELECT ('00000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
    '${uuid(1)}', 'Map rang', 'historical-device', 'Old Device', 'WO', 'TH 123',
    'clip.mp4', 'success', '2026-10-30T10:00:00Z', now()
  FROM generate_series(1000,2104) n;
  INSERT INTO pk_packing_upload_queue_reports
    (id,user_id,device_id,device_name,status,client_created_at,reported_at,dismissed_at)
  VALUES
    ('${uuid(3001)}','${uuid(1)}','active','Active Device','pending','2026-10-31T00:00:00Z',now(),NULL),
    ('${uuid(3002)}','${uuid(1)}','active','Active Device','uploading','2026-10-31T00:00:00Z',now(),NULL),
    ('${uuid(3003)}','${uuid(1)}','active','Active Device','pending','2026-10-31T00:00:00Z',now()-interval '31 minutes',NULL),
    ('${uuid(3004)}','${uuid(1)}','active','Active Device','uploading','2026-10-31T00:00:00Z',now()-interval '11 minutes',NULL),
    ('${uuid(3005)}','${uuid(1)}','active','Active Device','failed','2026-10-31T00:00:00Z',now(),NULL),
    ('${uuid(3006)}','${uuid(1)}','active','Active Device','pending','2026-10-31T00:00:00Z',NULL,NULL),
    ('${uuid(3007)}','${uuid(1)}','hidden','Hidden Device','failed','2026-10-31T00:00:00Z',now(),now()),
    ('${uuid(3008)}','${uuid(2)}','private','Private Device','failed','2026-10-31T00:00:00Z',now(),NULL);
`)

await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${uuid(1)}',false);`)
const shipped = async (options = {}) => (await db.query(`
  SELECT public.pk_shipped_work_orders_page($1,$2,$3,$4,$5,$6,$7) AS data`,
  [options.page ?? 1, options.size ?? 50, options.from ?? null, options.to ?? null,
    options.channel ?? null, options.packer ?? null, options.search ?? ''])).rows[0].data
const reports = async (options = {}) => (await db.query(`
  SELECT public.pk_upload_reports_page($1,$2,$3,$4,$5,$6,$7) AS data`,
  [options.page ?? 1, options.size ?? 50, options.from ?? null, options.to ?? null,
    options.device ?? null, options.search ?? '', options.status ?? null])).rows[0].data

let result = await shipped({ search: 'BILL1', size: 1 })
check(result.total, 1, 'a matched bill selects one complete work-order group')
check(result.rows[0].order_count, 2, 'search must not truncate the other bills in the group')
check(result.rows[0].packers.sort(), ['A', 'B'], 'all group packers retained')
check((await shipped()).total, 3, 'reused names with distinct or NULL IDs remain separate')
check((await shipped({ search: 'th123' })).rows[0].order_count, 2, 'tracking tolerates whitespace')
check((await shipped({ search: 'eX 456' })).total, 1, 'express receipt search tolerates whitespace/case')
check((await shipped({ search: '% (test)' })).total, 1, 'search punctuation is literal, never an ILIKE wildcard')
check((await shipped({ from: '2026-10-30', to: '2026-10-30' })).rows[0].order_count, 2, 'UTC calendar-day semantics retained')
check((await shipped({ from: '2026-10-31' })).total, 0, 'late UTC time does not move into local next day')
check((await shipped({ to: '2026-10-29' })).total, 2, 'undated legacy rows retained with upper bound only')
check((await shipped({ packer: 'B' })).rows[0].order_count, 1, 'filter precedes grouping as before')
check((await shipped({ from: '2026-10-31', to: '2026-10-29' })).total, 0, 'reversed range is empty')
result = await shipped({ page: 999, size: 1 })
check(result.page, 3, 'out-of-range page clamps after filters/deletion')
check(result.channels.sort(), ['OLD','SHOP','WEB'], 'global filter options preserved without leaking other users')
check(result.packers.sort(), ['A','B','C','D'], 'packer options remain global')

result = await reports()
check(result.total, 1111, 'visible records include all pages, omit dismissed and RLS-hidden rows')
check(result.rows.length, 50, 'response is bounded to the displayed page')
check(result.summary, { pending: 1, uploading: 1, success: 1105, failed: 4 }, 'summary spans entire result; stale/null timestamps are failed')
check(result.devices.map(d => d.device_id).sort(), ['active','historical-device'], 'historical devices remain in dropdown, hidden devices excluded')
check(result.stations.map(d => d.device_id), ['active'], 'live station metadata remains available under caller RLS')
check(result.stations[0].pending_count, 1, 'station queue and heartbeat fields preserved')
result = await reports({ status: 'failed' })
check(result.total, 4, 'failed filter includes pending/uploading stale records')
check(result.summary.success, 1105, 'status cards do not shrink to the selected status or page')
check((await reports({ device: 'historical-device' })).summary.success, 1105, 'device filter applies to both summary and rows')
check((await reports({ search: 'map\u00a0rang' })).total, 1105, 'report search strips Unicode whitespace')
check((await reports({ search: 'TH 123' })).total, 1105, 'report tracking search matches existing normalization')
check((await reports({ search: '%' })).total, 0, 'report wildcard is literal')
check((await reports({ from: '2026-10-30T17:00:00Z', to: '2026-10-31T16:59:59.999Z' })).total, 6, 'client-local date boundaries passed as exact instants')
check((await reports({ page: 999 })).page, 23, 'shrinking result clamps to last report page')
check((await reports({ device: 'missing' })).summary, { pending: 0, uploading: 0, success: 0, failed: 0 }, 'empty summary is zero')
const ids = []
for (let page = 1; page <= 23; page++) ids.push(...(await reports({ page })).rows.map(r => r.id))
check(ids.length, 1111, 'paging returns every visible report, including beyond 1,000')
check(new Set(ids).size, 1111, 'equal timestamp pages have no duplicates or omissions')

await db.exec(`SELECT set_config('request.jwt.claim.sub','${uuid(2)}',false)`)
check((await shipped()).rows[0].work_order_name, 'OTHER USER', 'history RPC obeys caller RLS')
check((await reports()).total, 1, 'report RPC obeys caller RLS')
await db.exec('BEGIN READ ONLY')
check((await reports()).summary.failed, 1, 'RPC runs inside a read-only transaction')
await db.exec('ROLLBACK; RESET ROLE; SET ROLE anon')
await assert.rejects(() => reports(), /permission denied/)
checks++
await db.exec('RESET ROLE')
const functions = (await db.query("SELECT proname,prosecdef,provolatile FROM pg_proc WHERE proname IN ('pk_shipped_work_orders_page','pk_upload_reports_page')")).rows
check(functions.every(f => !f.prosecdef && f.provolatile === 's'), true, 'list RPCs remain STABLE SECURITY INVOKER')
check((await db.query('SELECT count(*)::int n FROM pk_packing_upload_queue_reports')).rows[0].n, 1113, 'reads do not remove any source records')
await db.exec(`
  INSERT INTO pk_packing_upload_queue_reports
    (id,user_id,device_id,status,client_created_at,reported_at)
  VALUES ('${uuid(3050)}','${uuid(1)}','boundary','success','2026-10-31T16:59:59.999999Z',now());
  SET ROLE authenticated;
  SELECT set_config('request.jwt.claim.sub','${uuid(1)}',false);
`)
check((await reports({ from: '2026-10-31T16:59:59.999Z', to: '2026-10-31T16:59:59.999Z' })).total, 1,
  'last fractional millisecond is retained exactly as JS Date comparison')
await db.exec(`RESET ROLE; DELETE FROM pk_packing_upload_queue_reports WHERE id='${uuid(3050)}';`)
await db.exec(`
  INSERT INTO pk_packing_upload_queue_reports
    (id,user_id,device_id,device_name,status,client_created_at,reported_at,folder_path)
  SELECT ('00000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
    '${uuid(1)}','bulk','Bulk Device','success','2026-11-01T00:00:00Z',now(),repeat('folder/',300)
  FROM generate_series(4000,18012) n;
  SET ROLE authenticated;
  SELECT set_config('request.jwt.claim.sub','${uuid(1)}',false);
`)
result = await reports()
check(result.total, 15124, 'production-sized history counted without transferring all metadata')
check(result.rows.length, 50, 'production-sized history still returns only one page')
check((await reports({ page: 999 })).rows.length, 24, 'last page remains correct beyond 14,000 rows')
const plan = (await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT pk_upload_reports_page()')).rows[0]['QUERY PLAN'][0].Plan
check(plan['Temp Written Blocks'], 0, 'wide video metadata is not materialized for the entire report history')
console.log(`PASS ${checks} packing pagination checks (isolated PostgreSQL; no live DB)`)
await db.close()
