// Uses the linked connection without printing credentials. Rehearsal always rolls back.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'
const mode = process.argv[2] || 'audit'
if (!['audit', 'rehearse', 'apply'].includes(mode)) throw new Error('Expected audit|rehearse|apply')
let dump
try {
  dump = execFileSync('supabase', ['db','dump','--linked','--dry-run'], {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000})
} catch {
  console.error('Unable to obtain linked database connection within 30 seconds; no database changes made.')
  process.exit(1)
}
const vars = {}
for (const m of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[m[1]] = m[2].trim().replace(/^['"]|['"]$/g,'')
const client = new pg.Client({host:vars.PGHOST,port:Number(vars.PGPORT),user:vars.PGUSER,password:vars.PGPASSWORD,database:vars.PGDATABASE,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000})
const checks = []
try {
  await client.connect()
  await client.query('SET ROLE postgres')
  await client.query("SET lock_timeout='3s'; SET statement_timeout='30s'")
  const installed = (await client.query("SELECT version,name FROM supabase_migrations.schema_migrations WHERE version='644'")).rows
  const guards = (await client.query(`SELECT
    strpos(pg_get_functiondef('public.rpc_create_inventory_adjustment(text,text,text,jsonb)'::regprocedure),'HAVING count(DISTINCT m.config_id) > 1')>0 stocktake_guard,
    strpos(pg_get_functiondef('public.fn_auto_convert_rm_to_fg_on_movement()'::regprocedure),'LIMIT 1')>0 receipt_single_pair`)).rows[0]
  console.log(JSON.stringify({mode,installed,guards}))
  if (mode==='audit') {
    console.log(JSON.stringify({productColumns:(await client.query("SELECT column_name,is_generated FROM information_schema.columns WHERE table_schema='public' AND table_name='pr_products' ORDER BY ordinal_position")).rows}))
  } else {
    const migration = await fs.readFile('supabase/migrations/644_roll_pairing_groups.sql','utf8')
    const sql = migration.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'')
    const fingerprint = async () => (await client.query(`SELECT
      (SELECT md5(string_agg(row_to_json(b)::text,',' ORDER BY product_id)) FROM inv_stock_balances b) balances,
      (SELECT count(*) FROM inv_stock_movements) movements,
      (SELECT md5(string_agg(row_to_json(l)::text,',' ORDER BY id)) FROM inv_stock_lots l) lots,
      (SELECT md5(string_agg(row_to_json(c)::text,',' ORDER BY id)) FROM roll_material_config_rms c) mappings`)).rows[0]
    await client.query('BEGIN')
    const before = await fingerprint()
    const stockFunctions = (await client.query("SELECT pg_get_functiondef('public.fn_auto_convert_rm_to_fg_on_movement()'::regprocedure) receipt, pg_get_functiondef('public.rpc_approve_inventory_adjustment(uuid)'::regprocedure) approval")).rows[0]
    if (!installed.length) await client.query(sql)
    else assert.equal(installed[0].name,'roll_pairing_groups','Migration number occupied')
    await client.query('SAVEPOINT tests')
    const actor = (await client.query("SELECT id FROM us_users WHERE role='superadmin' AND is_active IS TRUE LIMIT 1")).rows[0]
    assert.ok(actor,'Active superadmin required')
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[actor.id])
    const products = []
    for (const type of ['RM','FG','FG','FG']) {
      const row = (await client.query("INSERT INTO pr_products(product_code,product_name,product_type,is_active) VALUES('PAIRTEST-'||gen_random_uuid()::text,'Rollback pairing test',$1,true) RETURNING id",[type])).rows[0]
      products.push(row.id)
    }
    const [rm,...fgs] = products
    await client.query('SELECT rpc_create_roll_pairing_group($1,$2,220)',[rm,fgs])
    const pairs = (await client.query('SELECT id,pairing_group_id,sheets_per_roll FROM roll_material_configs WHERE fg_product_id=ANY($1::uuid[])',[fgs])).rows
    assert.equal(pairs.length,3)
    assert.equal(new Set(pairs.map(p=>p.pairing_group_id)).size,1)
    checks.push('three FG created atomically with shared factor')
    const extra = (await client.query("INSERT INTO pr_products(product_code,product_name,product_type,is_active) VALUES('PAIRTEST-'||gen_random_uuid()::text,'Rollback RM','RM',true) RETURNING id")).rows[0].id
    const freeFg = (await client.query("INSERT INTO pr_products(product_code,product_name,product_type,is_active) VALUES('PAIRTEST-'||gen_random_uuid()::text,'Rollback FG','FG',true) RETURNING id")).rows[0].id
    await client.query('SELECT rpc_update_roll_group_sheets($1,200)',[pairs[0].id])
    assert.equal((await client.query('SELECT count(*)::int n FROM roll_material_configs WHERE fg_product_id=ANY($1::uuid[]) AND sheets_per_roll=200',[fgs])).rows[0].n,3)
    checks.push('factor update reaches whole group')
    async function reject(query,params) {
      await client.query('SAVEPOINT rejected')
      let failed=false
      try { await client.query(query,params) } catch { failed=true }
      await client.query('ROLLBACK TO SAVEPOINT rejected')
      assert.ok(failed,'Expected operation rejection')
    }
    await reject('SELECT rpc_create_roll_pairing_group($1,$2,220)',[rm,fgs])
    await reject('SELECT rpc_create_roll_pairing_group($1,$2,220)',[extra,[freeFg,fgs[0]]])
    assert.equal((await client.query('SELECT count(*)::int n FROM roll_material_configs WHERE fg_product_id=$1',[freeFg])).rows[0].n,0)
    await reject('SELECT rpc_create_roll_pairing_group($1,$2,220)',[extra,[freeFg,freeFg]])
    await reject('SELECT rpc_create_roll_pairing_group($1,$2,220)',[extra,[freeFg,null]])
    checks.push('conflicting batch rolls back completely; duplicate and null FG rejected')
    await reject('SELECT rpc_update_roll_group_sheets($1,-1)',[pairs[0].id])
    await reject('SELECT rpc_update_roll_group_sheets($1,NULL)',[pairs[0].id])
    await client.query("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000000',true)")
    await reject('SELECT rpc_update_roll_group_sheets($1,220)',[pairs[0].id])
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[actor.id])
    checks.push('existing pairs, invalid factors, unauthorized actors rejected')
    await client.query('INSERT INTO inv_stock_balances(product_id,on_hand,reserved,safety_stock) VALUES($1,10,0,0)',[rm])
    for (const [rolls,expected] of [[10,2000],[12,2400],[11,2200]]) {
      await client.query('UPDATE inv_stock_balances SET on_hand=$2 WHERE product_id=$1',[rm,rolls])
      const dash = (await client.query('SELECT rm_on_hand,sheets_per_roll FROM fn_get_roll_calc_dashboard() WHERE fg_product_id=ANY($1::uuid[])',[fgs])).rows
      assert.equal(dash.length,3)
      for (const row of dash) assert.equal(Number(row.rm_on_hand)*Number(row.sheets_per_roll),expected)
    }
    checks.push('calculator uses latest RM balance for all FG')
    const stocktake = (await client.query("SELECT rpc_create_inventory_adjustment('stocktake_reconcile',NULL,'Rollback group test',$1::jsonb) result",[JSON.stringify([{product_id:rm,target_on_hand:11,target_safety:0}])])).rows[0]
    assert.equal(stocktake.result.success,true)
    checks.push('stocktake creation accepts new shared group')
    await client.query('SELECT rpc_approve_inventory_adjustment($1)',[stocktake.result.adjustment_id])
    assert.equal((await client.query('SELECT count(*)::int n FROM inv_stock_balances WHERE product_id=ANY($1::uuid[]) AND on_hand=2200',[fgs])).rows[0].n,3)
    checks.push('stocktake approval derives every FG and reconciles FIFO')
    await client.query('ROLLBACK TO SAVEPOINT tests')
    assert.deepEqual(await fingerprint(),before)
    assert.deepEqual((await client.query("SELECT pg_get_functiondef('public.fn_auto_convert_rm_to_fg_on_movement()'::regprocedure) receipt, pg_get_functiondef('public.rpc_approve_inventory_adjustment(uuid)'::regprocedure) approval")).rows[0],stockFunctions)
    checks.push('existing balances, lots, movements, mappings and stock functions preserved')
    if (mode==='apply') {
      if (!installed.length) await client.query("INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES('644','roll_pairing_groups',$1::text[])",[[sql]])
      await client.query('COMMIT')
    } else await client.query('ROLLBACK')
    console.log(JSON.stringify({mode,checks,committed:mode==='apply'}))
  }
} catch (e) {
  await client.query('ROLLBACK').catch(()=>{})
  console.error(e.message)
  process.exitCode=1
} finally { await client.end() }
