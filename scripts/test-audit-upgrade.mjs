import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'

const dump = execFileSync('supabase', ['db', 'dump', '--linked', '--dry-run'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const vars = {}
for (const m of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
const client = new pg.Client({ host: vars.PGHOST, port: Number(vars.PGPORT), user: vars.PGUSER, password: vars.PGPASSWORD, database: vars.PGDATABASE, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 })
const migration = (await fs.readFile('supabase/migrations/643_audit_movement_and_separate_safety.sql', 'utf8')).replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, '')
const checks = []
async function asUser(user) {
  await client.query('SET LOCAL ROLE postgres')
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.role','authenticated',true)", [JSON.stringify({ sub: user.id, role: 'authenticated' }), user.id])
  await client.query('SET LOCAL ROLE authenticated')
}
async function denied(label, sql, params, pattern) {
  await client.query('SAVEPOINT audit_denied')
  try {
    await client.query(sql, params)
    throw new Error(`Unexpected success: ${label}`)
  } catch (error) {
    if (error.message.startsWith('Unexpected success:')) throw error
    if (pattern) assert.match(error.message, pattern)
    checks.push(label)
  } finally { await client.query('ROLLBACK TO SAVEPOINT audit_denied') }
}
try {
  await client.connect()
  await client.query('SET ROLE postgres')
  await client.query('BEGIN')
  await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'")
  const open = (await client.query("select count(*)::int n from inv_audits where status in ('draft','in_progress','review')")).rows[0].n
  assert.equal(open, 0, 'An open audit exists; stop migration')
  const installed = (await client.query("select exists(select 1 from information_schema.columns where table_name='inv_audit_items' and column_name='count_mode') installed")).rows[0].installed
  if (!installed) {
    await client.query(migration)
    assert.equal((await client.query("select count(*)::int n from inv_audit_items where count_mode <> 'legacy'")).rows[0].n, 0)
  }
  checks.push(installed ? 'Installed migration is available' : 'Migration applies; existing records remain legacy')
  const store = (await client.query("select id from us_users where role='store' and is_active limit 1")).rows[0]
  const admin = (await client.query("select id from us_users where role in ('superadmin','admin') and is_active limit 1")).rows[0]
  assert.ok(store && admin, 'Need store and admin accounts to test RLS')
  const product = (await client.query("select p.id from pr_products p where p.is_active and not exists(select 1 from roll_material_configs c where c.fg_product_id=p.id) and not exists(select 1 from wh_sub_wms_map_spares s where s.product_id=p.id) limit 1")).rows[0]
  const derived = (await client.query('select fg_product_id id from roll_material_configs limit 1')).rows[0]
  const oldStock = (await client.query('select on_hand,safety_stock,reserved from inv_stock_balances where product_id=$1', [product.id])).rows
  await asUser(store)
  await client.query('select fg_product_id from roll_material_configs limit 1')
  await client.query('select product_id,on_hand,safety_stock,reserved from inv_stock_balances limit 1')
  await client.query('select id,role,mobile_access from us_users limit 1')
  checks.push('Store can read the product mapping, stock snapshot and auditor picker dependencies')
  const audit = (await client.query("insert into inv_audits(audit_no,status,created_by,assigned_to,show_system_qty) values('TEST-AUDIT-'||gen_random_uuid(),'in_progress',$1,ARRAY[$1::uuid],false) returning id", [store.id])).rows[0]
  const insertItem = "insert into inv_audit_items(audit_id,product_id,system_qty,counted_qty,variance,is_counted,system_safety_stock,count_mode) values($1,$2,100,0,0,false,20,'separate') returning id"
  const item = (await client.query(insertItem, [audit.id, product.id])).rows[0]
  await client.query('update inv_audits set total_items=1 where id=$1', [audit.id])
  checks.push('Store creates header/items and finalizes own creation')
  await denied('Store cannot close Audit directly', "update inv_audits set status='closed' where id=$1", [audit.id], /Store/)
  await denied('Store cannot mark Audit completed directly', "update inv_audits set status='completed',reviewed_by=$2 where id=$1", [audit.id,store.id], /Store/)
  await denied('Store cannot call adjustment approval RPC', 'select rpc_approve_inventory_adjustment(gen_random_uuid())', [], /Not authorized/)
  await denied('Store cannot spoof creator', "insert into inv_audits(audit_no,status,created_by) values('TEST-'||gen_random_uuid(),'in_progress',$1)", [admin.id], /row-level security/)
  if (derived) await denied('Derived FG cannot be added even by direct insert', insertItem, [audit.id,derived.id], /FG/)
  const moved = (await client.query("select product_id from rpc_audit_movement_products(now()-interval '30 days',now())")).rows
  assert.equal(new Set(moved.map(row => row.product_id)).size, moved.length)
  if (derived) assert.ok(!moved.some(row => row.product_id===derived.id))
  checks.push('Movement preview is distinct and excludes derived FG')
  await asUser(admin)
  await client.query('SET LOCAL ROLE postgres')
  const other = (await client.query("select p.id from pr_products p where p.is_active and p.id<>$1 and not exists(select 1 from roll_material_configs c where c.fg_product_id=p.id) and not exists(select 1 from wh_sub_wms_map_spares s where s.product_id=p.id) limit 1", [product.id])).rows[0]
  assert.ok(other)
  const from = '2099-10-07T17:00:00Z'
  const to = '2099-10-08T17:00:00Z'
  await client.query("insert into inv_stock_movements(product_id,movement_type,qty,created_at,note) values($1,'adjust',1,$3,'Audit test start'),($1,'adjust',1,$3,'Audit test duplicate'),($2,'adjust',1,$4,'Audit test next midnight')", [product.id,other.id,from,to])
  await asUser(store)
  const boundary = (await client.query('select product_id from rpc_audit_movement_products($1,$2)', [from,to])).rows.map(row => row.product_id)
  assert.ok(boundary.includes(product.id))
  assert.ok(!boundary.includes(other.id))
  assert.equal(boundary.filter(id => id===product.id).length,1)
  checks.push('Movement uses inclusive start, exclusive next midnight and deduplicates repeated movements')
  await client.query('SET LOCAL ROLE postgres')
  const pair = (await client.query('select source.product_id source_id,s.product_id spare_id from wh_sub_wms_map_sources source join wh_sub_wms_map_spares s using(group_id) join pr_products p on p.id=s.product_id where p.is_active limit 1')).rows[0]
  if (pair) {
    await client.query("insert into inv_stock_movements(product_id,movement_type,qty,created_at,note) values($1,'adjust',1,$2,'Audit test ST source')", [pair.source_id,from])
    await asUser(store)
    assert.ok((await client.query('select product_id from rpc_audit_movement_products($1,$2)', [from,to])).rows.some(row => row.product_id===pair.spare_id))
    checks.push('ST enters movement Audit when its linked production SKU moves')
    await client.query('SET LOCAL ROLE postgres')
  }
  const locations = (await client.query("insert into wh_storage_locations(code,name) values('AUDIT-TEST-'||gen_random_uuid(),'Audit test'),('AUDIT-TEST-'||gen_random_uuid(),'Audit test') returning id")).rows
  const transfer = (await client.query("insert into wh_stock_transfers(transfer_no,from_location_id,to_location_id,status,created_by,posted_at) values('AUDIT-TEST-'||gen_random_uuid(),$1,$2,'posted',$3,$4) returning id", [locations[0].id,locations[1].id,admin.id,from])).rows[0]
  await client.query('insert into wh_stock_transfer_items(transfer_id,product_id,qty) values($1,$2,1)', [transfer.id,other.id])
  await asUser(store)
  assert.ok((await client.query('select product_id from rpc_audit_movement_products($1,$2)', [from,to])).rows.some(row => row.product_id===other.id))
  checks.push('Posted location transfers enter movement Audit')
  await asUser(admin)
  await denied('Safety is required for products with safety stock', 'update inv_audit_items set counted_qty=100,is_counted=true where id=$1', [item.id], /Safety/)
  await denied('Negative quantity is rejected by database', 'update inv_audit_items set counted_qty=-1,counted_safety_stock=20,is_counted=true where id=$1', [item.id], /จำนวน/)
  await client.query('update inv_audit_items set counted_qty=100,counted_safety_stock=15,is_counted=true,variance=999 where id=$1', [item.id])
  const counted = (await client.query('select variance,safety_stock_match from inv_audit_items where id=$1', [item.id])).rows[0]
  assert.equal(Number(counted.variance),0)
  assert.equal(counted.safety_stock_match,false)
  checks.push('Safety-only discrepancy is recorded; variance is calculated by DB')
  await denied('Audit snapshot cannot be changed', 'update inv_audit_items set system_qty=123 where id=$1', [item.id], /snapshot/)
  const adjustment = (await client.query("select rpc_create_inventory_adjustment('stocktake_reconcile','audit_count','Audit upgrade rollback test',$1::jsonb) result", [JSON.stringify([{ product_id: product.id, target_on_hand: 100, target_safety: 15 }])])).rows[0].result
  const target = (await client.query('select after_on_hand,after_safety_stock from inv_adjustment_items where adjustment_id=$1', [adjustment.adjustment_id])).rows[0]
  assert.equal(Number(target.after_on_hand),100)
  assert.equal(Number(target.after_safety_stock),15)
  assert.deepEqual((await client.query('select on_hand,safety_stock,reserved from inv_stock_balances where product_id=$1',[product.id])).rows,oldStock)
  checks.push('Adjustment keeps normal/safety targets separate and leaves live stock unchanged before approval')
  await asUser(store)
  await denied('Store cannot approve adjustment via direct UPDATE', "update inv_adjustments set status='approved',approved_by=$2 where id=$1", [adjustment.adjustment_id,store.id])
  await asUser(admin)
  await client.query("update inv_audits set status='closed',reviewed_by=$2,reviewed_at=now(),completed_at=now() where id=$1", [audit.id,admin.id])
  assert.equal((await client.query('select status from inv_audits where id=$1',[audit.id])).rows[0].status,'closed')
  checks.push('Existing administrator review/close capability remains available')
  await client.query('ROLLBACK')
  console.log(JSON.stringify({ passed: checks, rollback: true }, null, 2))
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  console.error(error.message)
  process.exitCode = 1
} finally { await client.end() }
