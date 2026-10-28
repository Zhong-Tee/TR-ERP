// Uses the existing linked database connection; never logs credentials.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'

const mode = process.argv[2] || 'audit'
assert.ok(['audit', 'apply', 'verify'].includes(mode))
let dump
try {
  dump = execFileSync('supabase', ['db', 'dump', '--linked', '--dry-run'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000,
  })
} catch (error) {
  const diagnostic = String(error.stderr || '') + String(error.stdout || '')
  console.error(JSON.stringify({ connection_unavailable: true, status: error.status,
    login: /access token|not logged in|login/i.test(diagnostic),
    network: /network|resolve|dial tcp|fetch failed/i.test(diagnostic),
    permission: /permission|denied|EPERM/i.test(diagnostic),
    detail: String(error.stderr || '').replace(/sbp_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_.-]+|postgres(?:ql)?:\/\/\S+/g, '[redacted]').slice(0, 1600) }))
  process.exit(1)
}
const vars = {}
for (const m of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
assert.ok(vars.PGHOST && vars.PGPASSWORD, 'Linked credentials unavailable')
const ref = (await fs.readFile('supabase/.temp/project-ref', 'utf8')).trim()
const env = await fs.readFile('.env', 'utf8')
assert.ok(env.includes(`${ref}.supabase.co`), 'App and linked database projects differ')
assert.ok(vars.PGHOST.includes(ref) || vars.PGUSER.includes(ref), 'Unexpected linked target')
const db = new pg.Client({ host: vars.PGHOST, port: Number(vars.PGPORT), user: vars.PGUSER,
  password: vars.PGPASSWORD, database: vars.PGDATABASE, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 })
const names = ['guard_pp_production_status_roles', 'rpc_complete_production_order_actual']
const oldGuard = await fs.readFile('supabase/migrations/620_packing_sub_warehouse_and_internal_production_access.sql','utf8')
const oldReceipt = await fs.readFile('supabase/migrations/668_internal_production_actual_completion.sql','utf8')
const patch = await fs.readFile('supabase/migrations/676_internal_production_store_receipt.sql','utf8')
const body = (sql, name) => {
 const start = sql.indexOf(`FUNCTION public.${name}(`)
 assert.ok(start >= 0)
 const begin = sql.indexOf('AS $$', start) + 5
 return sql.slice(begin, sql.indexOf('$$;', begin)).replace(/\s+/g,' ').trim()
}
const normalize = s => s.replace(/\s+/g,' ').trim()
const original = name => body(name === names[0] ? oldGuard : oldReceipt, name)
const definitions = async () => (await db.query(`SELECT proname,prosrc FROM pg_proc
 WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])`,[names])).rows
try {
 await db.connect()
 await db.query('SET ROLE postgres')
 await db.query('BEGIN')
 await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='45s'")
 await db.query("SELECT pg_advisory_xact_lock(hashtext('production-store-receipt-676'))")
 const live = await definitions()
 assert.equal(live.length,2)
 const installed = (await db.query("SELECT name FROM supabase_migrations.schema_migrations WHERE version='676'")).rows
 if(installed.length) assert.equal(installed[0].name,'internal_production_store_receipt')
 console.log(JSON.stringify({mode,project:ref,installed:installed.length>0,functions:live.map(r=>({
  name:r.proname,original:normalize(r.prosrc)===original(r.proname),patched:normalize(r.prosrc)===body(patch,r.proname)
 }))}))
 if(mode==='audit') { await db.query('ROLLBACK') }
 else {
  for(const row of live) assert.ok([original(row.proname),body(patch,row.proname)].includes(normalize(row.prosrc)),`Unexpected deployed definition: ${row.proname}`)
  if(mode==='apply') {
   const sql=patch.replace(/^BEGIN;\s*$/gm,'').replace(/^COMMIT;\s*$/gm,'')
   await db.query(sql)
   if(!installed.length) await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[])',['676','internal_production_store_receipt',[sql]])
  }
  for(const row of await definitions()) assert.equal(normalize(row.prosrc),body(patch,row.proname))
  // Probe permission gates with a nonexistent order; these calls cannot create inventory.
  const users=(await db.query("SELECT DISTINCT ON(role) id,role FROM us_users WHERE is_active IS TRUE AND role IN ('store','production','packing_staff','admin','superadmin') ORDER BY role,id")).rows
  const checks=[]
  for(const user of users) {
   await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[user.id])
   await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user.id,role:'authenticated'})])
   await db.query('SET LOCAL ROLE authenticated')
   for(const action of ['start','receive']) {
    const allowed=(action==='start'?['production','packing_staff','admin','superadmin']:['store','admin','superadmin']).includes(user.role)
    await db.query('SAVEPOINT permission_probe')
    let message=''
    try {
     await db.query(action==='start'?"SELECT public.rpc_start_production_order(NULL::uuid)":"SELECT public.rpc_complete_production_order_actual(NULL::uuid,'[]'::jsonb)")
    } catch(error) { message=error.message }
    await db.query('ROLLBACK TO SAVEPOINT permission_probe')
    await db.query('RELEASE SAVEPOINT permission_probe')
    assert.match(message,allowed?/ใบแปรรูปไม่ได้อยู่/:/ไม่มีสิทธิ์/,`${user.role} ${action}`)
    checks.push({role:user.role,action,allowed})
   }
   await db.query('SET LOCAL ROLE postgres')
  }
  await db.query(mode==='apply'?'COMMIT':'ROLLBACK')
  console.log(JSON.stringify({committed:mode==='apply',definitions_verified:true,permission_checks:checks,business_rows_written:0}))
 }
} catch(error) {
 await db.query('ROLLBACK').catch(()=>{})
 console.error(error.message)
 process.exitCode=1
} finally { await db.end() }
