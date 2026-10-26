// Apply only migration 671. Never imports statements or invokes matching against live rows.
// node scripts/apply-bank-import-671.mjs audit|rehearse|apply
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'
pg.types.setTypeParser(1082,s=>s)
const mode=process.argv[2]||'audit';assert.ok(['audit','rehearse','apply'].includes(mode))
let dump;try{dump=execFileSync('supabase',['db','dump','--linked','--dry-run'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:25000})}catch{throw new Error('Supabase linked connection unavailable. No changes made.')}
const vars={};for(const m of dump.matchAll(/^export (PG\w+)=(.*)$/gm))vars[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'')
assert.ok(vars.PGHOST&&vars.PGPASSWORD,'Linked credentials unavailable')
const db=new pg.Client({host:vars.PGHOST,port:Number(vars.PGPORT),user:vars.PGUSER,password:vars.PGPASSWORD,database:vars.PGDATABASE,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000})
const fingerprint=async()=> (await db.query(`SELECT
 (SELECT md5(coalesce(string_agg(row_to_json(a)::text,',' ORDER BY a.id),'')) FROM ac_bank_reconciliation_allocations a) allocations,
 (SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY t.id),'')) FROM ac_bank_statement_transactions t) bank_transactions,
 (SELECT md5(coalesce(string_agg(row_to_json(i)::text,',' ORDER BY i.id),'')) FROM ac_bank_statement_imports i) imports,
 (SELECT md5(coalesce(string_agg(row_to_json(c)::text,',' ORDER BY c.id),'')) FROM ac_order_receipt_certifications c) certifications`)).rows[0]
const normalize=s=>s.replace(/\s+/g,' ').trim()
const body=(sql,name)=>{const m=sql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`));assert.ok(m,`Function source ${name}`);return m[1]}
const functions=['bank_statement_auto_match_authorized_impl','bank_workspace_auto_match','bank_statement_import_authorized_impl','bank_sales_workspace']
try{
 await db.connect();await db.query('SET ROLE postgres');await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 await db.query("SET LOCAL lock_timeout='10s';SET LOCAL statement_timeout='90s'")
 await db.query("SELECT pg_advisory_xact_lock(hashtext('bank-import-migration-671'))")
 const before=await fingerprint()
 const oldPair=(await db.query(`SELECT a.id,a.allocated_amount,a.transaction_id,a.verified_slip_id,a.match_method,t.transaction_at,i.file_name FROM ac_bank_reconciliation_allocations a JOIN or_orders o ON o.id=a.order_id JOIN ac_bank_statement_transactions t ON t.id=a.transaction_id JOIN ac_bank_statement_imports i ON i.id=t.import_id WHERE o.bill_no='OATR26090010' ORDER BY a.id`)).rows
 assert.equal(oldPair.length,1,'Expected original OATR pair');assert.equal(Number(oldPair[0].allocated_amount),280)
 const installed=(await db.query("SELECT name FROM supabase_migrations.schema_migrations WHERE version='671'")).rows
 const name='bank_import_matching_isolation_and_coverage'
 if(installed.length)assert.equal(installed[0].name,name,'Migration 671 belongs to another change')
 console.log(JSON.stringify({mode,already_installed:installed.length>0,original_pair:{allocated_amount:oldPair[0].allocated_amount,file_name:oldPair[0].file_name}}))
 const migration=await fs.readFile('supabase/migrations/671_bank_import_matching_isolation_and_coverage.sql','utf8')
 if(mode==='audit'){await db.query('ROLLBACK')}
 else{
  if(!installed.length){
   const live=(await db.query("SELECT proname,prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])",[functions])).rows
   assert.equal(live.length,4)
   const originals={
    bank_statement_auto_match_authorized_impl:['636_certified_receipt_matching_guards','bank_statement_auto_match_authorized_impl'],
    bank_workspace_auto_match:['636_certified_receipt_matching_guards','bank_workspace_auto_match'],
    bank_statement_import_authorized_impl:['561_bank_statement_reconciliation','bank_statement_import'],
    bank_sales_workspace:['664_approved_claim_receivable','bank_sales_workspace']}
   for(const row of live){const [file,fn]=originals[row.proname];assert.equal(normalize(row.prosrc),normalize(body(await fs.readFile(`supabase/migrations/${file}.sql`,'utf8'),fn)),`Live ${row.proname} differs; review before replacing`)}
   const sql=migration.replace(/^BEGIN;\s*$/gm,'').replace(/^COMMIT;\s*$/gm,'')
   await db.query(sql)
   await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[])',['671',name,[sql]])
  }
  const definitions=(await db.query("SELECT proname,prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])",[functions])).rows
  for(const row of definitions)assert.equal(normalize(row.prosrc),normalize(body(migration,row.proname)),`Unexpected deployed definition ${row.proname}`)
  const actor=(await db.query("SELECT id FROM us_users WHERE role IN ('superadmin','account') AND is_active IS TRUE ORDER BY id LIMIT 1")).rows[0];assert.ok(actor)
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[actor.id])
  assert.equal((await db.query("SELECT bank_auto_match_order_has_capacity(id,50) capacity FROM or_orders WHERE bill_no='OATR26090010'")).rows[0].capacity,false)
  const verified=[]
  for(const bill of ['FBTR26100001','FBTR26100003','FBTR26100004','FBTR26100005','FBTR26100046']){
   const result=(await db.query("SELECT bank_sales_workspace(NULL,NULL,'all',$1,'','',0) result",[bill])).rows[0].result
   assert.equal(result.rows.length,1,`Expected ${bill}`)
   assert.notEqual(result.rows[0].statement_coverage,'unknown',`Expected account resolved for ${bill}`)
   verified.push({bill,statement_coverage:result.rows[0].statement_coverage,bank_received:result.rows[0].bank_received})
  }
  const banks=(await db.query("SELECT id,is_active FROM bank_settings WHERE bank_code='004' AND right(regexp_replace(account_number,'[^0-9]','','g'),4)='9552'")).rows
  assert.equal(banks.length,1);assert.equal(banks[0].is_active,true)
  const periods=(await db.query("SELECT file_name,period_start,period_end,imported_row_count FROM ac_bank_statement_imports WHERE bank_setting_id=$1 AND period_start<='2026-09-30' AND period_end>='2026-09-19' ORDER BY period_start",[banks[0].id])).rows
  assert.deepEqual(await fingerprint(),before,'Existing financial data changed; rollback')
  if(mode==='apply'){
   await fs.mkdir('.tmp/bank-import-671-review',{recursive:true})
   await fs.writeFile('.tmp/bank-import-671-review/before.json',JSON.stringify({recorded_at:new Date().toISOString(),protected_fingerprints:before,original_pair:oldPair},null,2),{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e})
   await db.query('COMMIT')
  }else await db.query('ROLLBACK')
  assert.deepEqual(await fingerprint(),before,'Financial data changed after verification')
  console.log(JSON.stringify({mode,committed:mode==='apply',original_pair_preserved:true,all_allocations_and_statement_data_unchanged:true,verified,existing_period_imports:periods,ready_bank_suffix:'9552'}))
 }
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.error(e.shortMessage||e.message);process.exitCode=1}finally{await db.end()}
