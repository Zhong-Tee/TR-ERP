import {execFileSync} from 'node:child_process'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'
pg.types.setTypeParser(1082,s=>s)
const mode=process.argv[2]||'audit';if(!['audit','rehearse','apply'].includes(mode))throw new Error('Expected audit, rehearse or apply')
let dump;try{dump=execFileSync('supabase',['db','dump','--linked','--dry-run'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:25000})}catch{throw new Error('Linked Supabase connection unavailable; no changes made')}
const vars={};for(const m of dump.matchAll(/^export (PG\w+)=(.*)$/gm))vars[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'')
if(!vars.PGHOST||!vars.PGPASSWORD)throw new Error('Connection details unavailable')
const db=new pg.Client({host:vars.PGHOST,port:Number(vars.PGPORT),user:vars.PGUSER,password:vars.PGPASSWORD,database:vars.PGDATABASE,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000})
const fingerprints=async()=> (await db.query(`SELECT
 (SELECT md5(coalesce(string_agg(row_to_json(i)::text,',' ORDER BY i.id),'')) FROM hr_payroll_items i JOIN hr_payroll_runs r ON r.id=i.payroll_run_id WHERE r.status='confirmed') confirmed_items,
 (SELECT md5(coalesce(string_agg(row_to_json(r)::text,',' ORDER BY r.id),'')) FROM hr_payroll_runs r) all_payroll_runs,
 (SELECT md5(coalesce(string_agg(row_to_json(i)::text,',' ORDER BY i.id),'')) FROM hr_payroll_items i) all_payroll_items,
 (SELECT md5(coalesce(string_agg(row_to_json(r)::text,',' ORDER BY r.id),'')) FROM hr_leave_requests r) all_leave_requests,
 (SELECT md5(coalesce(string_agg(row_to_json(b)::text,',' ORDER BY b.id),'')) FROM hr_employee_opening_leave_balances b JOIN hr_employees e ON e.id=b.employee_id WHERE e.employee_code='EMP00023') emp23_entitlements`)).rows[0]
try{
 await db.connect();await db.query('SET ROLE postgres');await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 await db.query("SET LOCAL lock_timeout='10s';SET LOCAL statement_timeout='60s'")
 await db.query("SELECT pg_advisory_xact_lock(hashtext('hr-october-2026-entitlement-repair'))")
 const before=await fingerprints()
 const rows=(await db.query(`SELECT b.*,e.employee_code,t.name leave_type_name FROM hr_employee_opening_leave_balances b JOIN hr_employees e ON e.id=b.employee_id JOIN hr_leave_types t ON t.id=b.leave_type_id WHERE e.employee_code IN ('EMP00021','EMP00022') AND b.year=2026 AND t.name IN ('ลากิจ','ลาป่วย') ORDER BY e.employee_code,t.name FOR UPDATE OF b`)).rows
 assert.equal(rows.length,4,'Expected four existing personal/sick rights for the two employees HR identified')
 for(const row of rows){assert.ok(['2026-07-31','2026-10-01'].includes(row.effective_date),'Unexpected opening effective date');assert.ok([0,5,30].includes(Number(row.opening_remaining_days)),'Unexpected rights; review before applying')}
 console.log(JSON.stringify({mode,before:rows.map(r=>({employee:r.employee_code,type:r.leave_type_name,effective:r.effective_date,days:r.opening_remaining_days}))}))
 if(mode==='audit'){await db.query('ROLLBACK');process.exitCode=0}
 else {
  const name='personal_leave_entitlement_consistency'
  const installed=(await db.query("SELECT name FROM supabase_migrations.schema_migrations WHERE version='670'")).rows
  if(installed.length)assert.equal(installed[0].name,name,'Migration 670 is already occupied')
  if(!installed.length){
   const original=await fs.readFile('supabase/migrations/353_hr_employee_opening_balances.sql','utf8')
   const expected=original.match(/CREATE OR REPLACE FUNCTION public\.get_employee_leave_summary[\s\S]*?AS \$\$([\s\S]*?)\$\$/)[1]
   const live=(await db.query("SELECT prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='get_employee_leave_summary'")).rows
   const normalize=s=>s.replace(/\s+/g,' ').trim()
   assert.equal(live.length,1);assert.equal(normalize(live[0].prosrc),normalize(expected),'Deployed leave summary differs from migration 353; review before replacing')
   const sql=(await fs.readFile('supabase/migrations/670_personal_leave_entitlement_consistency.sql','utf8')).replace(/^BEGIN;\s*$/gm,'').replace(/^COMMIT;\s*$/gm,'');await db.query(sql);await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[])',['670',name,[sql]])}
  for(const row of rows){const days=row.leave_type_name==='ลากิจ'?5:30
   if(row.effective_date==='2026-10-01'&&Number(row.opening_remaining_days)===days)continue
   await db.query(`UPDATE hr_employee_opening_leave_balances SET effective_date='2026-10-01',opening_remaining_days=$2,note=concat_ws(E'\n',nullif(note,''),'ปรับตาม HR: เริ่มสิทธิ์รายเดือน 1 ต.ค. 2569 ลากิจ 5 วัน / ลาป่วย 30 วัน; ไม่ปรับงวดเงินเดือนที่ยืนยันแล้ว') WHERE id=$1`,[row.id,days])
  }
  const employees=(await db.query("SELECT id,employee_code FROM hr_employees WHERE employee_code IN ('EMP00021','EMP00022','EMP00023') ORDER BY employee_code")).rows
  const verified=[]
  for(const emp of employees){const summary=(await db.query('SELECT get_employee_leave_summary($1,2026) summary',[emp.id])).rows[0].summary
   const remaining=Object.fromEntries(summary.balances.map(b=>[b.leave_type_name,b.remaining]))
   if(emp.employee_code==='EMP00021'){assert.equal(remaining['ลากิจ'],4);assert.equal(remaining['ลาป่วย'],29)}
   if(emp.employee_code==='EMP00022'){assert.equal(remaining['ลากิจ'],5);assert.equal(remaining['ลาป่วย'],30)}
   if(emp.employee_code==='EMP00023'){assert.equal(remaining['ลาพักร้อน'],0);assert.equal(summary.pending_count,1)}
   verified.push({employee:emp.employee_code,remaining,pending:summary.pending_count})
  }
  const actor=(await db.query("SELECT id FROM us_users WHERE is_active IS TRUE AND role IN ('superadmin','admin','hr','account') ORDER BY id LIMIT 1")).rows[0]
  assert.ok(actor,'Need an existing authorized leave approver for a rollback-only guard check')
  await db.query('SAVEPOINT vacation_guard_probe')
  let rejected=false
  try {
   await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[actor.id])
   await db.query("UPDATE hr_leave_requests SET status='approved' WHERE employee_id=(SELECT id FROM hr_employees WHERE employee_code='EMP00023') AND status='pending' AND start_date='2026-12-03'")
  } catch(e) {if(!/สิทธิ์ลาพักร้อนไม่เพียงพอ/.test(e.message))throw e;rejected=true}
  await db.query('ROLLBACK TO SAVEPOINT vacation_guard_probe')
  assert.ok(rejected,'EMP00023 legacy vacation approval must be rejected with zero rights')
  assert.deepEqual(await fingerprints(),before,'Payroll or existing leave/EMP00023 records changed unexpectedly')
  if(mode==='apply'){
   await fs.mkdir('.tmp/hr-entitlement-review',{recursive:true});await fs.writeFile('.tmp/hr-entitlement-review/repair-before.json',JSON.stringify({recorded_at:new Date().toISOString(),before_rows:rows,protected_fingerprints:before},null,2),{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e})
   await db.query('COMMIT')
  }else await db.query('ROLLBACK')
  assert.deepEqual(await fingerprints(),before,'Protected data fingerprints changed')
  console.log(JSON.stringify({mode,committed:mode==='apply',verified,protected_payroll_unchanged:true,existing_leave_requests_unchanged:true}))
 }
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1}finally{await db.end()}
