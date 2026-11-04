// Compare new read RPCs with the previous client calculations under real RLS.
// Isolated PostgreSQL only; no live connection, credentials or customer records.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'

const db = new PGlite()
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
let checks = 0
function check(actual, expected, description) { assert.deepEqual(actual, expected, description); checks++ }
await db.exec(`
  CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
  $$;
  CREATE TABLE or_orders(id uuid PRIMARY KEY, owner_id uuid, work_order_id uuid, status text);
  CREATE TABLE or_order_items(id uuid PRIMARY KEY, order_id uuid, product_id uuid,
    quantity numeric, is_detail_row boolean, cancellation_stock_action text);
  CREATE TABLE pr_products(id uuid PRIMARY KEY, owner_id uuid, product_category text, is_active boolean);
  CREATE VIEW v_cost_safe_pr_products WITH(security_invoker=true,security_barrier=true) AS
    SELECT id, product_category FROM pr_products;
  CREATE TABLE or_work_orders(id uuid PRIMARY KEY, owner_id uuid, work_order_name text);
  CREATE TABLE wms_orders(id uuid PRIMARY KEY, owner_id uuid, work_order_id uuid,
    order_id text, fulfillment_mode text, status text);
  ALTER TABLE or_orders ENABLE ROW LEVEL SECURITY;
  ALTER TABLE or_order_items ENABLE ROW LEVEL SECURITY;
  ALTER TABLE pr_products ENABLE ROW LEVEL SECURITY;
  ALTER TABLE or_work_orders ENABLE ROW LEVEL SECURITY;
  ALTER TABLE wms_orders ENABLE ROW LEVEL SECURITY;
  CREATE POLICY own_orders ON or_orders FOR SELECT TO authenticated USING(owner_id=auth.uid());
  CREATE POLICY own_items ON or_order_items FOR SELECT TO authenticated USING(
    EXISTS(SELECT 1 FROM or_orders o WHERE o.id=order_id));
  CREATE POLICY own_products ON pr_products FOR SELECT TO authenticated USING(owner_id=auth.uid() AND is_active);
  CREATE POLICY own_work_orders ON or_work_orders FOR SELECT TO authenticated USING(owner_id=auth.uid());
  CREATE POLICY own_wms ON wms_orders FOR SELECT TO authenticated USING(owner_id=auth.uid());
  GRANT USAGE ON SCHEMA public,auth TO authenticated;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;

  INSERT INTO pr_products VALUES
    ('${uuid(201)}','${uuid(1)}','A',true),
    ('${uuid(202)}','${uuid(1)}',E'\\t B \\n',true),
    ('${uuid(203)}','${uuid(1)}','INACTIVE',false),
    ('${uuid(204)}','${uuid(2)}','PRIVATE',true),
    ('${uuid(205)}','${uuid(1)}','',true);
  INSERT INTO or_orders VALUES
    ('${uuid(11)}','${uuid(1)}','${uuid(101)}','จัดส่งแล้ว'),
    ('${uuid(12)}','${uuid(1)}','${uuid(101)}','ยกเลิก'),
    ('${uuid(13)}','${uuid(1)}','${uuid(102)}',NULL),
    ('${uuid(14)}','${uuid(2)}','${uuid(103)}','ใบสั่งงาน');
  INSERT INTO or_work_orders VALUES
    ('${uuid(101)}','${uuid(1)}','REUSED'),
    ('${uuid(102)}','${uuid(1)}','REUSED'),
    ('${uuid(103)}','${uuid(2)}','PRIVATE'),
    ('${uuid(104)}','${uuid(1)}',' TRIM '),
    ('${uuid(105)}','${uuid(1)}','NO ROWS');
  INSERT INTO or_order_items VALUES
    ('${uuid(301)}','${uuid(11)}','${uuid(201)}',2,false,NULL),
    ('${uuid(302)}','${uuid(11)}','${uuid(202)}',1.5,false,NULL),
    ('${uuid(303)}','${uuid(11)}','${uuid(201)}',0,true,'recalled'),
    ('${uuid(304)}','${uuid(11)}','${uuid(201)}',-2,false,NULL),
    ('${uuid(305)}','${uuid(12)}','${uuid(201)}',3,false,NULL),
    ('${uuid(306)}','${uuid(13)}','${uuid(202)}',NULL,false,NULL),
    ('${uuid(307)}','${uuid(13)}','${uuid(201)}','NaN',false,NULL),
    ('${uuid(308)}','${uuid(13)}','${uuid(201)}','Infinity',false,NULL),
    ('${uuid(309)}','${uuid(11)}','${uuid(203)}',99,false,NULL),
    ('${uuid(310)}','${uuid(11)}','${uuid(204)}',99,false,NULL),
    ('${uuid(311)}','${uuid(11)}',NULL,99,false,NULL),
    ('${uuid(312)}','${uuid(11)}','${uuid(205)}',99,false,NULL),
    ('${uuid(313)}','${uuid(14)}','${uuid(204)}',8,false,NULL);
  INSERT INTO or_orders
    SELECT ('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'${uuid(1)}','${uuid(101)}','ใบสั่งงาน'
    FROM generate_series(1,1205) n;
  INSERT INTO or_order_items
    SELECT ('20000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
      ('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'${uuid(201)}',2,false,NULL
    FROM generate_series(1,1205) n;
  INSERT INTO wms_orders VALUES
    ('${uuid(401)}','${uuid(1)}','${uuid(101)}','legacy-name','warehouse_pick','correct'),
    ('${uuid(402)}','${uuid(1)}',NULL,' LEGACY ',NULL,'pending'),
    ('${uuid(403)}','${uuid(1)}','${uuid(102)}','CANCELLED','warehouse_pick','cancelled'),
    ('${uuid(404)}','${uuid(1)}','${uuid(102)}','AUTO','system_complete','correct'),
    ('${uuid(405)}','${uuid(2)}','${uuid(103)}','PRIVATE','warehouse_pick','pending'),
    ('${uuid(406)}','${uuid(1)}','${uuid(104)}',' TRIM ',NULL,'picked'),
    ('${uuid(407)}','${uuid(1)}','${uuid(103)}','VISIBLE LEGACY','warehouse_pick','correct');
`)
const migration = await fs.readFile('supabase/legacy-migrations/pre-baseline-20261104/691_plan_read_summaries.sql','utf8')
await db.exec(migration)
await db.exec(migration)
const requested = [101,102,103,104,105,101].map(uuid)

async function referenceMetrics(ids) {
  const orders = (await db.query('SELECT id,work_order_id,status FROM or_orders WHERE work_order_id=ANY($1)',[ids])).rows
  const items = (await db.query('SELECT order_id,product_id,quantity FROM or_order_items WHERE order_id=ANY($1)',[orders.map(o=>o.id)])).rows
  const products = (await db.query('SELECT id,product_category FROM v_cost_safe_pr_products')).rows
  const categories = new Map(products.map(p=>[p.id,String(p.product_category||'').trim()]))
  const result = Object.fromEntries([...new Set(ids)].map(id=>[id,{bill_count:0,category_qty:{}}]))
  const ordersById = new Map(orders.map(o=>[o.id,o]))
  for (const order of orders) if (order.status != null && order.status!=='ยกเลิก') result[order.work_order_id].bill_count++
  for (const item of items) {
    const category = categories.get(item.product_id)
    if (!category) continue
    const qty = Number(item.quantity)
    const map = result[ordersById.get(item.order_id).work_order_id].category_qty
    map[category]=(map[category]||0)+(Number.isFinite(qty)&&qty>0?qty:1)
  }
  return result
}
async function assignedReference(names) {
  const rows = (await db.query("SELECT work_order_id,order_id FROM wms_orders WHERE status<>'cancelled' AND (fulfillment_mode='warehouse_pick' OR fulfillment_mode IS NULL)")).rows
  const assigned = new Set(rows.map(row=>String(row.order_id||'').trim()).filter(Boolean))
  const headers=(await db.query('SELECT work_order_name FROM or_work_orders WHERE id=ANY($1)',[rows.map(r=>r.work_order_id).filter(Boolean)])).rows
  headers.forEach(row=>{if(row.work_order_name?.trim())assigned.add(row.work_order_name.trim())})
  return [...new Set(names)].filter(name=>assigned.has(name)).sort()
}
const requestedNames=['REUSED','LEGACY','TRIM',' TRIM ','NO ROWS','PRIVATE','CANCELLED','AUTO','VISIBLE LEGACY']
for (const identity of [1,2,99]) {
  await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${uuid(identity)}',false)`)
  const actual=(await db.query('SELECT rpc_plan_work_order_metrics($1) data',[requested])).rows[0].data
  check(actual,await referenceMetrics(requested),`metrics match original calculations with RLS for user ${identity}`)
  const names=(await db.query('SELECT rpc_wms_assigned_names($1) data',[requestedNames])).rows[0].data
  check(names,await assignedReference(requestedNames),`assigned names preserve ID/legacy behavior with RLS for user ${identity}`)
  await db.exec('RESET ROLE')
}
await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${uuid(1)}',false)`)
const data=(await db.query('SELECT rpc_plan_work_order_metrics($1) data',[requested])).rows[0].data
check(data[uuid(101)].bill_count,1206,'bill counts include every page beyond 1,000')
check(data[uuid(101)].category_qty,{A:2417,B:1.5},'retain cancelled/detail/recalled rows and positive/fallback quantity rules')
check(data[uuid(102)],{bill_count:0,category_qty:{A:2,B:1}},'null status excludes bill count but not category quantities')
check(data[uuid(103)],{bill_count:0,category_qty:{}},'hidden order/product data never leak through metrics')
check(data[uuid(105)],{bill_count:0,category_qty:{}},'requested empty work orders receive explicit zeros')
check((await db.query('SELECT rpc_plan_work_order_metrics(ARRAY[]::uuid[]) data')).rows[0].data,{},'empty input')
check((await db.query('SELECT rpc_wms_assigned_names(ARRAY[]::text[]) data')).rows[0].data,[],'empty name input')
await db.exec('BEGIN READ ONLY')
check((await db.query('SELECT rpc_plan_work_order_metrics($1) data',[requested])).rows[0].data,data,'RPC operates in a read-only transaction')
await db.exec('ROLLBACK; RESET ROLE; SET ROLE anon')
await assert.rejects(()=>db.query('SELECT rpc_plan_work_order_metrics($1)',[requested]),/permission denied/); checks++
await assert.rejects(()=>db.query('SELECT rpc_wms_assigned_names($1)',[requestedNames]),/permission denied/); checks++
await db.exec('RESET ROLE')
const properties=(await db.query("SELECT prosecdef,provolatile FROM pg_proc WHERE proname IN ('rpc_plan_work_order_metrics','rpc_wms_assigned_names')")).rows
check(properties.every(p=>!p.prosecdef && p.provolatile==='s'),true,'summary RPCs remain STABLE SECURITY INVOKER')
check((await db.query('SELECT count(*)::int n FROM or_orders')).rows[0].n,1209,'source orders not changed by any read')
check((await db.query('SELECT count(*)::int n FROM wms_orders')).rows[0].n,7,'source WMS rows not changed by any read')
console.log(`PASS ${checks} phase 2 SQL checks (isolated PostgreSQL; no live DB)`)
await db.close()
