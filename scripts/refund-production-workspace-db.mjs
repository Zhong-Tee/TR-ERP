// Uses the project's existing linked Supabase CLI credentials without printing them.
// node scripts/refund-production-workspace-db.mjs audit|rehearse|apply
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import pg from '../.tmp/refund-db-runtime/node_modules/pg/lib/index.js'
const mode=process.argv[2] || 'audit'
if (!['audit','rehearse','apply'].includes(mode)) throw new Error('Expected audit, rehearse or apply')
let dump
try { dump=execFileSync('.tmp/refund-db-runtime/node_modules/.bin/supabase',['db','dump','--linked','--dry-run','--output-format','text','--agent','no'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}) }
catch(error) {
  const diagnostic=String(error.stderr || '')+String(error.stdout || '')
  const reason=/access token|not logged in/i.test(diagnostic) ? 'CLI is not signed in' : /keychain|permission|EPERM/i.test(diagnostic) ? 'saved credentials are inaccessible' : /password/i.test(diagnostic) ? 'cached database credentials are unavailable' : /network|dial tcp|no such host|resolve/i.test(diagnostic) ? 'network connection failed' : `CLI exited with status ${error.status ?? 'unknown'}`
  console.error(`Supabase linked connection unavailable: ${reason}. No credentials or database changes were printed/performed.`)
  process.exit(1)
}
const vars={}
for(const match of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[match[1]]=match[2].trim().replace(/^['"]|['"]$/g,'')
if(!vars.PGHOST || !vars.PGPASSWORD) throw new Error('Linked connection details unavailable')
const client=new pg.Client({host:vars.PGHOST,port:Number(vars.PGPORT),user:vars.PGUSER,password:vars.PGPASSWORD,database:vars.PGDATABASE,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:15000})
const name='648_refund_production_gate_and_status_history'
const body=(sql)=>sql.replace(/^BEGIN;\s*$/gm,'').replace(/^COMMIT;\s*$/gm,'')
try {
  await client.connect()
  const installed=(await client.query("SELECT version,name FROM supabase_migrations.schema_migrations WHERE version='648'")).rows
  const bill=(await client.query(`SELECT o.id,o.bill_no,o.status,o.shipped_time,o.transport_meta->>'verified_at' verified_at,
    (SELECT status FROM ac_refunds WHERE order_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1) refund_status,
    (SELECT count(*) FROM pk_packing_reset_logs WHERE order_id=o.id AND reset_at>o.shipped_time) later_resets,
    w.status work_order_status FROM or_orders o LEFT JOIN or_work_orders w ON w.id=o.work_order_id WHERE bill_no='FBTR26100104'`)).rows
  console.log(JSON.stringify({mode,installed,bill}))
  if(mode==='audit') { await client.end(); process.exit(0) }
  await client.query('BEGIN')
  try {
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='45s'")
    await client.query("SELECT pg_advisory_xact_lock(hashtext('refund-production-gate-migration'))")
    const check=(await client.query("SELECT name FROM supabase_migrations.schema_migrations WHERE version='648'")).rows
    if(check.length && check[0].name!==name.slice(4)) throw new Error('Migration 648 belongs to another change')
    if(!check.length) {
      const sql=body(await fs.readFile(`supabase/migrations/${name}.sql`,'utf8'))
      await client.query(sql)
      await client.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[])',['648',name.slice(4),[sql]])
    }
    const fingerprint=(await client.query("SELECT md5(row_to_json(o)::text) value FROM or_orders o WHERE bill_no='FBTR26100104'")).rows[0]?.value
    const repair=body(await fs.readFile('scripts/repair-fbtr26100104-status.sql','utf8'))
    await client.query(repair)
    const verified=(await client.query(`SELECT status,shipped_time,tracking_number,transport_meta->>'verified_at' verified_at FROM or_orders WHERE bill_no='FBTR26100104'`)).rows[0]
    if(verified?.status!=='จัดส่งแล้ว') throw new Error('Repair did not restore shipped status')
    await client.query('SAVEPOINT preserved_status_check')
    await client.query("SELECT set_config('app.order_status_source','overpayment_request',true)")
    await client.query("UPDATE or_orders SET status='รอตรวจคำสั่งซื้อ' WHERE bill_no='FBTR26100104'")
    const status=(await client.query("SELECT status FROM or_orders WHERE bill_no='FBTR26100104'")).rows[0]?.status
    if(status!=='จัดส่งแล้ว') throw new Error('Payment review rewound the shipped bill')
    await client.query('ROLLBACK TO SAVEPOINT preserved_status_check')
    const history=(await client.query(`SELECT event_type,previous_status,resulting_status,source,reason FROM or_order_status_history WHERE order_id=(SELECT id FROM or_orders WHERE bill_no='FBTR26100104') ORDER BY created_at DESC,id DESC LIMIT 5`)).rows
    if(mode==='apply') await client.query('COMMIT')
    else {
      await client.query('ROLLBACK')
      const restored=(await client.query("SELECT md5(row_to_json(o)::text) value FROM or_orders o WHERE bill_no='FBTR26100104'")).rows[0]?.value
      if(restored!==fingerprint) throw new Error('Rehearsal rollback failed to restore the original bill')
    }
    console.log(JSON.stringify({mode,committed:mode==='apply',verified,history}))
  } catch(error) { await client.query('ROLLBACK'); throw error }
} catch(error) { console.error(error.message);process.exitCode=1 }
finally { await client.end() }
