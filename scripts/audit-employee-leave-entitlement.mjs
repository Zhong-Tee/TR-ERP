import {execFileSync} from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'
pg.types.setTypeParser(1082,s=>s)
let dump
try {dump=execFileSync('supabase',['db','dump','--linked','--dry-run'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:25000})} catch(e) {const d=String(e.stderr||'')+String(e.stdout||'');console.error(JSON.stringify({connection_unavailable:true,cli_status:e.status,not_signed_in:/access token|not logged in|login/i.test(d),docker:/docker|engine/i.test(d),password:/password/i.test(d),network:/network|resolve|dial tcp|fetch failed/i.test(d),permission:/permission|denied|EPERM/i.test(d),unsupported_flag:/unknown flag|unknown option/i.test(d)}));process.exit(1)}
const vars={};for(const m of dump.matchAll(/^export (PG\w+)=(.*)$/gm))vars[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'')
if(!vars.PGHOST||!vars.PGPASSWORD){console.error('Linked connection details unavailable');process.exit(1)}
const db=new pg.Client({host:vars.PGHOST,port:Number(vars.PGPORT),user:vars.PGUSER,password:vars.PGPASSWORD,database:vars.PGDATABASE,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000})
try {
await db.connect();await db.query('SET ROLE postgres');await db.query('BEGIN READ ONLY');await db.query("SET LOCAL statement_timeout='30s'")
const history=await db.query(`WITH h AS (SELECT employee_id,effective_date,pay_type,lag(pay_type) OVER(PARTITION BY employee_id ORDER BY effective_date,created_at,id) previous_pay_type FROM hr_salary_history) SELECT e.id,e.employee_code,e.first_name,e.last_name,e.nickname,e.contract_type,h.effective_date,h.pay_type,h.previous_pay_type FROM hr_employees e LEFT JOIN h ON h.employee_id=e.id WHERE e.employee_code IN ('EMP00023','EMP00021','EMP00022') OR (h.effective_date>='2026-10-01' AND h.effective_date<'2026-11-01' AND h.pay_type IS DISTINCT FROM 'daily') ORDER BY e.employee_code,h.effective_date`)
console.log(JSON.stringify({employees_and_history:history.rows}))
const ids=[...new Set(history.rows.map(r=>r.id))]
for(const [label,sql,args] of [
['openings',`SELECT e.employee_code,t.name,b.year,b.effective_date,b.opening_remaining_days,b.note FROM hr_employee_opening_leave_balances b JOIN hr_employees e ON e.id=b.employee_id JOIN hr_leave_types t ON t.id=b.leave_type_id WHERE b.employee_id=ANY($1::uuid[]) AND b.year=2026 ORDER BY e.employee_code,t.name`,[ids]],
['leave_requests',`SELECT e.employee_code,r.id,t.name,r.start_date,r.end_date,r.total_days,r.status,r.leave_mode,r.total_hours FROM hr_leave_requests r JOIN hr_employees e ON e.id=r.employee_id JOIN hr_leave_types t ON t.id=r.leave_type_id WHERE r.employee_id=ANY($1::uuid[]) AND r.start_date>='2026-01-01' ORDER BY e.employee_code,r.start_date`,[ids]],
['types',`SELECT id,name,max_days_per_year,is_paid FROM hr_leave_types ORDER BY name`,[]],

['payroll_records',`SELECT r.id run_id,r.payroll_month,r.status,r.payroll_type,i.employee_code,i.leave_deduction FROM hr_payroll_items i JOIN hr_payroll_runs r ON r.id=i.payroll_run_id WHERE i.employee_id=ANY($1::uuid[]) AND r.payroll_month>='2026-09-01' ORDER BY r.payroll_month,i.employee_code`,[ids]],
['deduction_reviews',`SELECT e.employee_code,d.payroll_month,d.status,d.excess_days,d.deduction_amount FROM hr_leave_payroll_deductions d JOIN hr_employees e ON e.id=d.employee_id WHERE d.employee_id=ANY($1::uuid[]) AND d.payroll_month>='2026-09-01' ORDER BY d.payroll_month,e.employee_code`,[ids]],
['summary_functions',`SELECT proname,md5(prosrc) fingerprint FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='get_employee_leave_summary'`,[]],
['installed',`SELECT version FROM supabase_migrations.schema_migrations WHERE version IN ('670','671')`,[]]
]){console.log(JSON.stringify({[label]:(await db.query(sql,args)).rows}))}
const require=createRequire(import.meta.url);const ts=require('typescript')
await fs.mkdir('.tmp/hr-entitlement-review',{recursive:true})
for(const name of ['leaveEntitlement','payrollLeaveDeduction']){
 let code=ts.transpileModule(await fs.readFile(`src/lib/${name}.ts`,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
 code=code.replace("'./leaveEntitlement'","'./leaveEntitlement.mjs'")
 await fs.writeFile(`.tmp/hr-entitlement-review/${name}.mjs`,code)
}
const {calculateMonthlyLeaveOverage}=await import(pathToFileURL(path.resolve('.tmp/hr-entitlement-review/payrollLeaveDeduction.mjs')).href)
const types=(await db.query('SELECT id,name,max_days_per_year,is_paid FROM hr_leave_types')).rows
const leaves=(await db.query("SELECT id,employee_id,leave_type_id,start_date,total_days,status,created_at FROM hr_leave_requests WHERE employee_id=ANY($1::uuid[]) AND start_date>='2026-01-01'",[ids])).rows
const openings=(await db.query('SELECT employee_id,leave_type_id,year,effective_date,opening_remaining_days FROM hr_employee_opening_leave_balances WHERE employee_id=ANY($1::uuid[]) AND year=2026',[ids])).rows
const overage=calculateMonthlyLeaveOverage('2026-10',leaves.map(r=>({...r,created_at:new Date(r.created_at).toISOString()})),types,openings)
console.log(JSON.stringify({october_current_overage:history.rows.map(e=>({employee:e.employee_code,excess_days:[...(overage.get(e.id)?.values()||[])].reduce((a,b)=>a+b,0)}))}))
await db.query('ROLLBACK')
}catch(e){console.error(e.message);process.exitCode=1}finally{await db.end()}
