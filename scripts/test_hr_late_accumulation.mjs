// Run: node scripts/test_hr_late_accumulation.mjs [path to installed @electric-sql/pglite]
// Uses an isolated in-memory PostgreSQL instance; never connects to Supabase.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
process.on('uncaughtException', error => { console.error(error.message, error.detail ?? '', error.hint ?? '', error.where?.slice(0, 300) ?? ''); process.exit(1) })
const packagePath = process.argv[2] ?? '.tmp/late-accumulation-validation/node_modules/@electric-sql/pglite/dist/index.js'
const { PGlite } = await import(pathToFileURL(path.resolve(packagePath)).href)
const db = new PGlite()
await db.exec(await fs.readFile('scripts/fixtures/hr_late_accumulation.sql','utf8'))
await db.exec(await fs.readFile('supabase/migrations/653_hr_late_accumulation.sql','utf8'))
const employee = '00000000-0000-0000-0000-000000000011'
const hr = '00000000-0000-0000-0000-000000000001'
const ordinary = '00000000-0000-0000-0000-000000000002'
const today = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date::text d")).rows[0].d
const date = offset => new Date(Date.parse(`${today}T00:00:00Z`) + offset*86400000).toISOString().slice(0,10)
const query = (sql,params=[]) => db.query(sql,params)
const reset = async () => {
  await db.exec(`TRUNCATE hr_warnings,hr_time_entries,hr_time_certifications,hr_leave_requests,hr_late_exceptions,
    hr_late_audit,hr_warning_approvals,hr_employee_work_calendar,hr_wfh_requests,hr_company_holidays;
    UPDATE us_users SET role='hr' WHERE id='${hr}'; SELECT set_config('request.jwt.claim.sub','${hr}',false);`)
  await query('SELECT hr_late_set_start_date($1::date)',[date(-1000)])
}
const entry = async (offset,time='08:36:00') => query("INSERT INTO hr_time_entries(employee_id,work_date,entry_type,entry_time) VALUES($1,$2,'clock_in',$3)",[employee,date(offset),`${date(offset)}T${time}+07:00`])
const summary = async () => (await query('SELECT hr_late_accumulation() data')).rows[0].data
const row = async () => (await summary()).rows.find(x=>x.employee_id===employee)
const create = async () => (await query('SELECT hr_late_create_warning($1) id',[employee])).rows[0].id
const transition = async (id,action,note=null) => query('SELECT hr_warning_workflow($1,$2,$3)',[id,action,note])
const approve = async id => { await transition(id,'submit_review'); await transition(id,'send_approval'); await transition(id,'approve') }
const acknowledge = async (id,offset=-1) => query("UPDATE hr_warnings SET status='acknowledged',acknowledged_at=$2::timestamptz WHERE id=$1",[id,`${date(offset)}T18:00:00+07:00`])
const leave = async (offset,status='approved',mode='hourly',start='08:30',end='10:00',emergency=true) => query(
  'INSERT INTO hr_leave_requests(employee_id,start_date,end_date,status,leave_mode,start_time,end_time,is_emergency) VALUES($1,$2,$2,$3,$4,$5,$6,$7)',
  [employee,date(offset),status,mode,start,end,emergency])
let passed=0
async function test(name,run) { await reset(); await run(); passed++; console.log(`PASS ${name}`) }
await test('grace is a threshold, seconds are floored, duplicate entries count once',async()=>{
  await entry(-3,'08:35:59'); await entry(-2,'08:36:00'); await entry(-2,'09:00:00')
  const r=await row(); assert.equal(r.late_count,1); assert.equal(r.late_minutes,6)
})
await test('three occurrences carry across months, create verbal draft and prevent duplicates',async()=>{
  await entry(-65); await entry(-35); await entry(-1)
  assert.equal((await summary()).ready_count,1)
  const id=await create(); const w=(await query('SELECT * FROM hr_warnings WHERE id=$1',[id])).rows[0]
  assert.equal(w.warning_level,'verbal'); assert.equal(w.status,'draft'); assert.equal(w.incident_date.toISOString().slice(0,10),date(-65))
  assert.equal(w.late_incidents_snapshot.length,3); assert.equal((await summary()).ready_count,0)
  await assert.rejects(create,/เคส|เกณฑ์/)
  await assert.rejects(query('SELECT hr_late_set_start_date($1)',[date(-50)]),/วันเริ่ม/)
  await assert.rejects(query('DELETE FROM hr_warnings WHERE id=$1',[id]),/ยกเลิก/)
})
await test('one arrival over two hours qualifies, both thresholds still produce one case',async()=>{
  await entry(-1,'10:35:00'); assert.equal((await row()).late_minutes,125); assert.equal((await row()).eligible,true)
  await create(); assert.equal((await row()).pending_status,'draft')
})
await test('full workflow, extra incidents before acknowledgement consumed once, then next stage',async()=>{
  for(const day of [-50,-45,-40]) await entry(day)
  const id=await create(); await approve(id); await entry(-35)
  assert.equal((await row()).eligible,false); await acknowledge(id,-30)
  assert.equal((await row()).late_count,0)
  assert.equal((await query('SELECT jsonb_array_length(late_incidents_snapshot) n FROM hr_warnings WHERE id=$1',[id])).rows[0].n,4)
  for(const day of [-20,-15,-10]) await entry(day)
  assert.equal((await row()).next_level,'written_1'); const next=await create()
  assert.equal((await query('SELECT warning_level FROM hr_warnings WHERE id=$1',[next])).rows[0].warning_level,'written_1')
})
await test('120 clean days resets counters and preserves history',async()=>{
  await entry(-122); await entry(-121); await entry(-120)
  const r=await row(); assert.equal(r.clean_days,120); assert.equal(r.late_count,0); assert.equal(r.late_minutes,0); assert.equal(r.history.length,3)
})
await test('119 days does not reset, a 120-day gap starts a new round',async()=>{
  await entry(-121); await entry(-120); await entry(-119); assert.equal((await row()).late_count,3)
  await reset(); await entry(-160); await entry(-159); await entry(-39); assert.equal((await row()).late_count,1)
})
await test('approved hourly leave shifts start, unrelated afternoon leave does not erase morning lateness',async()=>{
  await leave(-3); await entry(-3,'10:06:00'); await leave(-2,'approved','hourly','13:00','14:00'); await entry(-2)
  await leave(-1,'approved','full_day',null,null); await entry(-1)
  const r=await row(); assert.equal(r.late_count,2); assert.equal(r.late_minutes,12); assert.equal(r.history.filter(x=>x.status==='exempt').length,1)
})
await test('multiple contiguous approved leave ranges, approved cancellation restores incident',async()=>{
  await leave(-1,'approved','hourly','08:30','09:00'); await leave(-1,'approved','hourly','09:00','10:00'); await entry(-1,'10:05:59')
  assert.equal((await row()).late_count,0)
  await query("UPDATE hr_leave_requests SET status='cancelled'"); assert.equal((await row()).late_minutes,95)
})
await test('pending emergency holds issuance; approval excludes only its time range',async()=>{
  for(const day of [-4,-3,-2]) await entry(day)
  await entry(-1); await leave(-1,'pending')
  assert.equal((await row()).pending_emergency_count,1); assert.equal((await row()).eligible,false)
  await assert.rejects(create,/เกณฑ์|ฉุกเฉิน/)
  await query("UPDATE hr_leave_requests SET status='approved'")
  assert.equal((await row()).late_count,3); assert.equal((await row()).eligible,true)
})
await test('pending afternoon emergency does not hold an unrelated morning incident',async()=>{
  for(const day of [-3,-2,-1]) await entry(day)
  await leave(-1,'pending','hourly','13:00','14:00'); assert.equal((await row()).eligible,true)
})
await test('cancellation requires reason and restores badge, exception removes occurrence',async()=>{
  for(const day of [-3,-2,-1]) await entry(day)
  const id=await create(); await assert.rejects(transition(id,'cancel'),/เหตุผล/)
  await transition(id,'cancel','เอกสารผิด'); assert.equal((await summary()).ready_count,1)
  await query('SELECT hr_late_set_exception($1,$2,true,$3)',[employee,date(-1),'เหตุสุดวิสัย'])
  assert.equal((await row()).late_count,2); assert.equal((await summary()).ready_count,0)
  assert.equal((await query("SELECT count(*)::int n FROM hr_late_audit WHERE action='exception'")).rows[0].n,1)
})
await test('correction blocks approval; explicit review updates evidence and restarts review',async()=>{
  for(const day of [-4,-3,-2]) await entry(day)
  const id=await create(); await transition(id,'submit_review'); await transition(id,'send_approval')
  await query("UPDATE hr_time_entries SET entry_time=work_date::timestamp+interval '8 hours 30 minutes'-interval '7 hours' WHERE work_date=$1",[date(-4)])
  assert.equal((await row()).review_required,true); await assert.rejects(transition(id,'approve'),/เกณฑ์|ทบทวน/)
  await entry(-1); await query('SELECT hr_late_review_warning($1)',[id])
  assert.equal((await row()).review_required,false); assert.equal((await row()).pending_status,'changes_requested')
  await approve(id)
})
await test('one-year validity uses offense date; previous expiry does not invalidate latest stage',async()=>{
  await db.exec('ALTER TABLE hr_warnings DISABLE TRIGGER trg_hr_late_warning_guard')
  for (const [level,incident,ack] of [['verbal',-500,-490],['written_1',-100,-90]]) {
    await query("INSERT INTO hr_warnings(employee_id,late_generated,warning_level,status,incident_date,acknowledged_at,approved_at) VALUES($1,true,$2,'acknowledged',$3,$4,$4)",[employee,level,date(incident),`${date(ack)}T18:00:00+07:00`])
  }
  await db.exec('ALTER TABLE hr_warnings ENABLE TRIGGER trg_hr_late_warning_guard')
  for(const day of [-30,-20,-10]) await entry(day)
  assert.equal((await row()).current_level,'written_1'); assert.equal((await row()).next_level,'final'); await create()
})
await test('expired current warning resets both stage and pre-expiry balances',async()=>{
  await db.exec('ALTER TABLE hr_warnings DISABLE TRIGGER trg_hr_late_warning_guard')
  await query("INSERT INTO hr_warnings(employee_id,late_generated,warning_level,status,incident_date,acknowledged_at,approved_at) VALUES($1,true,'verbal','acknowledged',$2,$3,$3)",[employee,date(-400),`${date(-390)}T18:00:00+07:00`])
  await db.exec('ALTER TABLE hr_warnings ENABLE TRIGGER trg_hr_late_warning_guard')
  for(const day of [-80,-70,-20,-10]) await entry(day)
  const r=await row(); assert.equal(r.current_level,null); assert.equal(r.next_level,'verbal'); assert.equal(r.late_count,2)
})
await test('120 days does not erase an active verbal warning',async()=>{
  for(const day of [-140,-130,-120]) await entry(day)
  // Seed the issued warning: live counters have already reset by today's date.
  await db.exec('ALTER TABLE hr_warnings DISABLE TRIGGER trg_hr_late_warning_guard')
  await query("INSERT INTO hr_warnings(employee_id,late_generated,warning_level,status,incident_date,acknowledged_at,approved_at) VALUES($1,true,'verbal','acknowledged',$2,$3,$3)",[employee,date(-140),`${date(-119)}T18:00:00+07:00`])
  await db.exec('ALTER TABLE hr_warnings ENABLE TRIGGER trg_hr_late_warning_guard')
  const r=await row(); assert.equal(r.late_count,0); assert.equal(r.current_level,'verbal'); assert.equal(r.next_level,'written_1')
})
await test('reset does not erase evidence of an open case',async()=>{
  for(const day of [-140,-130,-119]) await entry(day)
  const id=await create()
  // Move the latest incident to day 120 and refresh its evidence before checking the workflow.
  await db.exec('ALTER TABLE hr_warnings DISABLE TRIGGER trg_hr_late_warning_guard')
  await query("UPDATE hr_time_entries SET work_date=$1,entry_time=$2 WHERE work_date=$3",[date(-120),`${date(-120)}T08:36:00+07:00`,date(-119)])
  const history=(await row()).history.slice().reverse()
  await query('UPDATE hr_warnings SET late_incidents_snapshot=$2 WHERE id=$1',[id,JSON.stringify(history)])
  await db.exec('ALTER TABLE hr_warnings ENABLE TRIGGER trg_hr_late_warning_guard')
  assert.equal((await row()).late_count,0); await approve(id); await acknowledge(id,0)
  assert.equal((await row()).current_level,'verbal')
})
await test('all four stages and termination review use the existing approval workflow',async()=>{
  let previous=null
  for(const [index,level] of ['verbal','written_1','final','termination_review'].entries()) {
    const first=-80+index*15
    for(const offset of [first,first+1,first+2]) await entry(offset)
    const id=await create(); await approve(id)
    assert.equal((await query('SELECT warning_level FROM hr_warnings WHERE id=$1',[id])).rows[0].warning_level,level)
    if(level!=='termination_review') await acknowledge(id,first+3)
    else { assert.equal((await row()).pending_status,'termination_review'); await assert.rejects(create,/เกณฑ์|เคส/) }
    previous=id
  }
  await transition(previous,'close'); assert.equal((await row()).eligible,false)
  await transition(previous,'cancel','เพิกถอนผลพิจารณา'); assert.equal((await row()).current_level,'final')
})
await test('calendar holidays and WFH schedules are respected',async()=>{
  await entry(-3); await query("INSERT INTO hr_company_holidays(holiday_date) VALUES($1)",[date(-3)])
  await entry(-2); await query("INSERT INTO hr_employee_work_calendar(employee_id,work_date,day_type) VALUES($1,$2,'weekly_off')",[employee,date(-2)])
  await entry(-1,'10:06:00'); await query("INSERT INTO hr_wfh_requests(employee_id,status,start_date,end_date,start_time,end_time) VALUES($1,'approved',$2,$2,'10:00','18:00')",[employee,date(-1)])
  assert.equal((await row()).late_count,1); assert.equal((await row()).late_minutes,6)
})
await test('start date excludes earlier events; future start returns no rows',async()=>{
  await entry(-2); await entry(-1); await query('SELECT hr_late_set_start_date($1)',[date(-1)])
  assert.equal((await row()).late_count,1)
  await query('SELECT hr_late_set_start_date($1)',[date(1)]); assert.equal((await summary()).rows.length,0)
})
await test('unauthorized access denied, account role can use the same workflow',async()=>{
  await query("SELECT set_config('request.jwt.claim.sub',$1,false)",[ordinary])
  await assert.rejects(summary,/สิทธิ์/); await assert.rejects(create,/สิทธิ์/)
  await query("SELECT set_config('request.jwt.claim.sub',$1,false)",[hr]); await query("UPDATE us_users SET role='account' WHERE id=$1",[hr])
  for(const day of [-3,-2,-1]) await entry(day)
  assert.equal((await row()).eligible,true); await create()
  assert.equal((await query("SELECT has_function_privilege('authenticated','hr_late_summary_internal()','EXECUTE') allowed")).rows[0].allowed,false)
})
await test('employee acknowledges own warning but cannot change evidence or another employee case',async()=>{
  for(const day of [-3,-2,-1]) await entry(day)
  const id=await create(); await approve(id)
  await query("SELECT set_config('request.jwt.claim.sub',$1,false)",[ordinary])
  await assert.rejects(query("UPDATE hr_warnings SET status='acknowledged',subject='changed' WHERE id=$1",[id]),/เฉพาะ/)
  await query("UPDATE hr_warnings SET status='acknowledged',acknowledged_at=now(),employee_response='รับทราบ' WHERE id=$1",[id])
  await assert.rejects(query("UPDATE hr_warnings SET status='cancelled',resolution_note='cancel' WHERE id=$1",[id]),/สิทธิ์/)
  await query("SELECT set_config('request.jwt.claim.sub',$1,false)",[hr])
  assert.equal((await row()).current_level,'verbal'); assert.equal((await row()).late_count,0)
  assert.equal((await query("SELECT has_function_privilege('authenticated','hr_late_attendance_facts(date,date,uuid)','EXECUTE') allowed")).rows[0].allowed,false)
})
console.log(`${passed} PostgreSQL integration cases passed`)
await db.close()
