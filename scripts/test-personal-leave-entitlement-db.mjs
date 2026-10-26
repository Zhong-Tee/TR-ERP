// Isolated PostgreSQL test engine: no production connection.
import { PGlite } from '../.tmp/production-actual-tests/node_modules/@electric-sql/pglite/dist/index.js'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const db=new PGlite();const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
await db.exec(`CREATE TABLE hr_leave_types(id uuid primary key,name text,max_days_per_year numeric);
CREATE TABLE hr_employee_opening_leave_balances(id uuid default gen_random_uuid(),employee_id uuid,leave_type_id uuid,year int,effective_date date,opening_remaining_days numeric);
CREATE TABLE hr_leave_requests(id uuid primary key default gen_random_uuid(),employee_id uuid,leave_type_id uuid,start_date date,end_date date,total_days numeric,status text,leave_mode text,start_time time,end_time time,total_hours numeric,reason text,medical_cert_url text,created_at timestamptz default now());`)
await db.exec(await fs.readFile('supabase/migrations/670_personal_leave_entitlement_consistency.sql','utf8'))
const q=async(sql,args=[])=>(await db.query(sql,args)).rows
async function seed(quota=2){await db.exec(`TRUNCATE hr_leave_requests,hr_leave_types,hr_employee_opening_leave_balances;
INSERT INTO hr_leave_types VALUES('${id(1)}','ลาพักร้อน',6),('${id(2)}','ลาป่วย',30);
INSERT INTO hr_employee_opening_leave_balances(employee_id,leave_type_id,year,effective_date,opening_remaining_days) VALUES('${id(3)}','${id(1)}',2026,'2026-10-01',${quota});`)}
const request=(days=1,status='pending',type=id(1),employee=id(3),start='2026-12-03',end=start)=>q('INSERT INTO hr_leave_requests(employee_id,leave_type_id,start_date,end_date,total_days,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[employee,type,start,end,days,status])
let passed=0;async function test(name,fn){await fn();console.log('PASS '+name);passed++}
await test('EMP00023 zero overrides company default and blocks pending requests',async()=>{await seed(0);await assert.rejects(()=>request(2),/คงเหลือที่ขอได้ 0/);assert.equal((await q('SELECT * FROM hr_leave_requests')).length,0)})
await test('pending requests reserve rights and prevent a second overbooking',async()=>{await seed(2);await request(1.5);await assert.rejects(()=>request(1),/ไม่เพียงพอ/);await request(0.5)})
await test('approval excludes the same request from reserved usage',async()=>{await seed(2);const r=await request(2);await q("UPDATE hr_leave_requests SET status='approved' WHERE id=$1",[r[0].id]);assert.equal((await q('SELECT status FROM hr_leave_requests'))[0].status,'approved')})
await test('approval revalidates a legacy over-quota request without deleting it',async()=>{await seed(2);const r=await request(2);await db.exec('UPDATE hr_employee_opening_leave_balances SET opening_remaining_days=0');await assert.rejects(()=>q("UPDATE hr_leave_requests SET status='approved' WHERE id=$1",[r[0].id]),/ไม่เพียงพอ/);assert.equal((await q('SELECT status FROM hr_leave_requests'))[0].status,'pending')})
await test('legacy request may still be cancelled when its quota is now zero',async()=>{await seed(2);const r=await request(2);await db.exec('UPDATE hr_employee_opening_leave_balances SET opening_remaining_days=0');await q("UPDATE hr_leave_requests SET status='cancelled' WHERE id=$1",[r[0].id]);await request(0,'rejected')})
await test('unrelated edits do not invalidate legacy pending requests',async()=>{await seed(2);const r=await request(2);await db.exec('UPDATE hr_employee_opening_leave_balances SET opening_remaining_days=0');await q("UPDATE hr_leave_requests SET reason='แนบรายละเอียดเพิ่ม' WHERE id=$1",[r[0].id])})
await test('cancelled and rejected leave release reserved rights',async()=>{await seed(2);const r=await request(2);await q("UPDATE hr_leave_requests SET status='rejected' WHERE id=$1",[r[0].id]);await request(2)})
await test('direct approved insertion cannot bypass the guard',async()=>{await seed(0);await assert.rejects(()=>request(1,'approved'),/ไม่เพียงพอ/)})
await test('cross-year vacation must be split, while next year uses its own rights',async()=>{await seed(0);await assert.rejects(()=>request(2,'pending',id(1),id(3),'2026-12-31','2027-01-01'),/แยกใบลา/);await request(2,'pending',id(1),id(3),'2027-01-01')})
await test('another employee is not charged against this employee quota',async()=>{await seed(0);await request(2,'pending',id(1),id(4))})
await test('other leave categories retain their approval and overage workflow',async()=>{await seed(0);await request(31,'approved',id(2))})
await test('October personal basis ignores approved leave before transition',async()=>{await seed(2);await request(5,'approved',id(1),id(3),'2026-09-01');await request(2,'approved');const summary=(await q('SELECT get_employee_leave_summary($1,2026) summary',[id(3)]))[0].summary;const vacation=summary.balances.find(r=>r.leave_type_name==='ลาพักร้อน');assert.equal(vacation.entitled_days,2);assert.equal(vacation.used_days,2);assert.equal(vacation.remaining,0)})
await test('approved usage is counted, but pending usage is separate from used days',async()=>{await seed(2);await request(2);const s=(await q('SELECT get_employee_leave_summary($1,2026) summary',[id(3)]))[0].summary;assert.equal(s.pending_count,1);assert.equal(s.balances.find(r=>r.leave_type_name==='ลาพักร้อน').used_days,0)})
await db.close();console.log(`${passed} isolated database scenarios passed`)
