// Isolated PostgreSQL tests. This script never reads production credentials.
// Setup: npm install --prefix .tmp/hr-appeal-db-test --no-audit --no-fund --save-exact @electric-sql/pglite@0.5.13
import { PGlite } from '../../.tmp/hr-appeal-db-test/node_modules/@electric-sql/pglite/dist/index.js'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'

const db = new PGlite()
const ids = {
  hr: '10000000-0000-0000-0000-000000000001', account: '10000000-0000-0000-0000-000000000002',
  employee: '20000000-0000-0000-0000-000000000024', other: '20000000-0000-0000-0000-000000000025',
  run: '30000000-0000-0000-0000-000000000001', category: '40000000-0000-0000-0000-000000000001',
}
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  CREATE TABLE us_users(id uuid PRIMARY KEY,role text);
  INSERT INTO us_users VALUES('${ids.hr}','hr'),('${ids.account}','account'),('${ids.employee}','employee'),('${ids.other}','employee');
  CREATE TABLE hr_employees(id uuid PRIMARY KEY,user_id uuid);
  INSERT INTO hr_employees VALUES('${ids.employee}','${ids.employee}'),('${ids.other}','${ids.other}');
  CREATE FUNCTION hr_is_admin() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public AS
    $$ SELECT EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role IN ('hr','superadmin','admin')) $$;
  CREATE FUNCTION hr_payroll_role_allowed() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public AS
    $$ SELECT EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role IN ('account','superadmin')) $$;
  CREATE FUNCTION hr_my_employee_id() RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=public AS
    $$ SELECT id FROM hr_employees WHERE user_id=auth.uid() $$;
  CREATE TABLE hr_score_appeals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),employee_id uuid,event_date date,event_code text,
    points numeric,category_id uuid,status text,reviewed_by uuid,reviewed_at timestamptz,decision_note text);
  CREATE TABLE hr_score_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),employee_id uuid,event_date date,category_id uuid,
    event_code text,points numeric,source text,ref_table text,ref_id uuid,detail jsonb,note text,created_by uuid);
  CREATE TABLE hr_score_periods(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),base_points numeric,total_points numeric);
  CREATE TABLE hr_payroll_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),status text,payroll_type text,
    confirmed_at timestamptz,confirmed_by uuid,updated_at timestamptz,payment_date date);
  CREATE TABLE hr_payroll_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),payroll_run_id uuid REFERENCES hr_payroll_runs(id),
    employee_id uuid,employee_code text,base_salary numeric,other_deduction numeric DEFAULT 0,
    net_pay numeric GENERATED ALWAYS AS(base_salary-other_deduction) STORED,reviewed_at timestamptz,reviewed_by uuid);
  GRANT USAGE ON SCHEMA public,auth TO authenticated;
  GRANT ALL ON hr_payroll_runs,hr_payroll_items TO authenticated;
`)
const original = await fs.readFile('supabase/migrations/331_hr_score_appeal_by_event_key.sql', 'utf8')
const start = original.indexOf('CREATE OR REPLACE FUNCTION hr_score_accept_appeal(')
const end = original.indexOf('GRANT EXECUTE ON FUNCTION hr_score_accept_appeal', start)
await db.exec(original.slice(start, end))
const migration = await fs.readFile('supabase/migrations/680_hr_appeal_wages_and_payroll_revisions.sql','utf8')
await db.exec(migration)
await db.exec(migration) // Re-running does not erase history or duplicate policies.

let checks = 0
const actor = async id => { await db.exec('RESET ROLE'); await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]); await db.exec('SET ROLE authenticated') }
const count = async table => Number((await db.query(`SELECT count(*) n FROM ${table}`)).rows[0].n)
const reject = async (sql, args, pattern) => {
  await assert.rejects(db.query(sql,args), pattern); checks++
}
const createAppeal = async (date, status='pending', code='absent', employee=ids.employee) => {
  await db.exec('RESET ROLE')
  return (await db.query("INSERT INTO hr_score_appeals(employee_id,event_date,event_code,points,category_id,status) VALUES($1,$2,$3,-20,$4,$5) RETURNING id",[employee,date,code,ids.category,status])).rows[0].id
}
try {
  const scoreOnly = await createAppeal('2026-10-18')
  await actor(ids.hr)
  await db.query('SELECT hr_score_review_appeal_payroll($1,0,NULL)',[scoreOnly])
  await db.exec('RESET ROLE')
  assert.equal(await count('hr_daily_wage_approvals'),0); checks++
  assert.equal(await count('hr_score_events'),1); checks++

  const full = await createAppeal('2026-10-19')
  await actor(ids.hr)
  await reject('SELECT hr_score_review_appeal_payroll($1,1,NULL)',[full],/หลักฐาน/)
  await reject('SELECT hr_score_review_appeal_payroll($1,2,$2)',[full,'evidence'],/กรุณาเลือก/)
  await db.query('SELECT hr_score_review_appeal_payroll($1,1,$2)',[full,'Verified full day'])
  await reject('SELECT hr_score_review_appeal_payroll($1,1,$2)',[full,'Duplicate'],/รับรองค่าจ้างแล้ว/)
  await db.exec('RESET ROLE')
  assert.equal(await count('hr_daily_wage_approvals'),1); checks++
  assert.equal(await count('hr_score_events'),2); checks++
  assert.equal((await db.query('SELECT approved_by FROM hr_daily_wage_approvals')).rows[0].approved_by,ids.hr); checks++

  const half = await createAppeal('2026-10-20','accepted')
  await actor(ids.hr)
  await db.query('SELECT hr_score_review_appeal_payroll($1,0.5,$2)',[half,'Verified half day'])
  await db.exec('RESET ROLE')
  assert.equal(await count('hr_score_events'),2); checks++ // No duplicate score refund for an older accepted appeal.
  assert.equal(await count('hr_daily_wage_approvals'),2); checks++

  const repeat = await createAppeal('2026-10-21','pending','absent_repeat')
  const denied = await createAppeal('2026-10-22','rejected')
  await actor(ids.hr)
  await reject('SELECT hr_score_review_appeal_payroll($1,1,$2)',[repeat,'Repeat is not attendance'],/ต้นทาง/)
  await reject('SELECT hr_score_review_appeal_payroll($1,1,$2)',[denied,'Rejected appeal'],/ปฏิเสธ/)
  await reject('INSERT INTO hr_daily_wage_approvals(employee_id,work_date,appeal_id,payable_day,note) VALUES($1,$2,$3,1,$4)',[ids.employee,'2026-10-22',denied,'Direct write'],/permission denied/)
  await actor(ids.account)
  await reject('SELECT hr_score_review_appeal_payroll($1,1,$2)',[repeat,'Not HR'],/ไม่มีสิทธิ์/)
  await actor(ids.employee)
  assert.equal(await count('hr_daily_wage_approvals'),2); checks++
  await actor(ids.other)
  assert.equal(await count('hr_daily_wage_approvals'),0); checks++

  await db.exec('RESET ROLE')
  await db.query("INSERT INTO hr_payroll_runs(id,status,payroll_type,confirmed_at,confirmed_by,payment_date) VALUES($1,'draft','daily',now(),$2,'2026-10-31')",[ids.run,ids.account])
  await db.query('INSERT INTO hr_payroll_items(payroll_run_id,employee_id,employee_code,base_salary,reviewed_at,reviewed_by) VALUES($1,$2,$3,4800,now(),$4)',[ids.run,ids.employee,'EMP00024',ids.account])
  await db.query("UPDATE hr_payroll_runs SET status='confirmed' WHERE id=$1",[ids.run])
  await actor(ids.account)
  await reject("UPDATE hr_payroll_runs SET status='draft' WHERE id=$1",[ids.run],/ยืนยันแล้ว/)
  await reject('UPDATE hr_payroll_items SET base_salary=6000 WHERE payroll_run_id=$1',[ids.run],/ยืนยันแล้ว/)
  await reject('DELETE FROM hr_payroll_items WHERE payroll_run_id=$1',[ids.run],/ยืนยันแล้ว/)
  await reject('INSERT INTO hr_payroll_items(payroll_run_id,employee_id,base_salary) VALUES($1,$2,1)',[ids.run,ids.other],/ยืนยันแล้ว/)
  await reject('DELETE FROM hr_payroll_runs WHERE id=$1',[ids.run],/ตรวจย้อนหลัง/)
  await reject("SELECT hr_reopen_daily_payroll($1,'  ')",[ids.run],/เหตุผล/)
  await actor(ids.hr)
  await reject("SELECT hr_reopen_daily_payroll($1,'Not payroll staff')",[ids.run],/ไม่มีสิทธิ์/)
  await actor(ids.account)
  await db.query('SELECT hr_reopen_daily_payroll($1,$2)',[ids.run,'Approved attendance correction'])
  const revision = (await db.query('SELECT * FROM hr_payroll_revisions')).rows[0]
  assert.equal(revision.run_before.status,'confirmed'); checks++
  assert.equal(Number(revision.items_before[0].base_salary),4800); checks++
  assert.equal(revision.created_by,ids.account); checks++
  assert.equal((await db.query('SELECT reviewed_at FROM hr_payroll_items')).rows[0].reviewed_at,null); checks++
  await reject("SELECT hr_reopen_daily_payroll($1,'Duplicate reopen')",[ids.run],/เฉพาะงวด/)
  await db.query('UPDATE hr_payroll_items SET base_salary=6000 WHERE payroll_run_id=$1',[ids.run])
  await db.query("UPDATE hr_payroll_runs SET status='confirmed',confirmed_at=now() WHERE id=$1",[ids.run])
  await db.query('SELECT hr_reopen_daily_payroll($1,$2)',[ids.run,'Second correction'])
  assert.equal(await count('hr_payroll_revisions'),2); checks++
  await reject("UPDATE hr_payroll_revisions SET reason='Changed'",[],/permission denied/)

  await db.exec('RESET ROLE')
  await db.exec('INSERT INTO hr_score_periods(base_points,total_points) VALUES(100,105)')
  assert.equal(Number((await db.query('SELECT total_points FROM hr_score_periods')).rows[0].total_points),100); checks++
  // Migration 681 adds snapshots without changing any historical amount.
  await db.exec('ALTER TABLE hr_employees ADD COLUMN social_security_enabled boolean; ALTER TABLE hr_payroll_items ADD COLUMN social_security numeric DEFAULT 0')
  await db.query('UPDATE hr_employees SET social_security_enabled=(id=$1)',[ids.employee])
  const legacyBefore = (await db.query('SELECT id,base_salary,social_security FROM hr_payroll_items ORDER BY id')).rows
  const snapshotMigration = await fs.readFile('supabase/migrations/681_payroll_social_security_snapshot.sql','utf8')
  await db.exec(snapshotMigration)
  await db.exec(snapshotMigration)
  assert.deepEqual((await db.query('SELECT id,base_salary,social_security FROM hr_payroll_items ORDER BY id')).rows,legacyBefore); checks++
  assert.equal((await db.query('SELECT social_security_enabled FROM hr_payroll_items')).rows[0].social_security_enabled,null); checks++
  const monthlyRun = '30000000-0000-0000-0000-000000000002'
  await db.query("INSERT INTO hr_payroll_runs(id,status,payroll_type) VALUES($1,'draft','permanent')",[monthlyRun])
  await db.query('INSERT INTO hr_payroll_items(payroll_run_id,employee_id,employee_code,base_salary,social_security) VALUES($1,$2,$3,18000,875)',[monthlyRun,ids.employee,'EMP00024'])
  await db.query('INSERT INTO hr_payroll_items(payroll_run_id,employee_id,employee_code,base_salary,social_security) VALUES($1,$2,$3,18000,750)',[monthlyRun,ids.other,'EMP00025'])
  const snapshotItems = (await db.query('SELECT employee_id,social_security_enabled,social_security FROM hr_payroll_items WHERE payroll_run_id=$1 ORDER BY employee_id',[monthlyRun])).rows
  assert.equal(snapshotItems[0].social_security_enabled,true); checks++
  assert.equal(snapshotItems[1].social_security_enabled,false); checks++
  assert.equal(Number(snapshotItems[1].social_security),0); checks++
  await db.query("UPDATE hr_payroll_runs SET status='confirmed' WHERE id=$1",[monthlyRun])
  await db.query('UPDATE hr_employees SET social_security_enabled=false WHERE id=$1',[ids.employee])
  assert.equal((await db.query('SELECT social_security_enabled FROM hr_payroll_items WHERE payroll_run_id=$1 AND employee_id=$2',[monthlyRun,ids.employee])).rows[0].social_security_enabled,true); checks++
  await actor(ids.account)
  await reject('UPDATE hr_payroll_items SET social_security_enabled=false WHERE payroll_run_id=$1',[monthlyRun],/ยืนยันแล้ว/)
  await reject("SELECT hr_reopen_monthly_payroll($1,'')",[monthlyRun],/เหตุผล/)
  await db.query('SELECT hr_reopen_monthly_payroll($1,$2)',[monthlyRun,'Enrollment correction across both groups'])
  const monthlyRevision = (await db.query('SELECT items_before FROM hr_payroll_revisions WHERE payroll_run_id=$1',[monthlyRun])).rows[0]
  assert.equal(monthlyRevision.items_before.length,2); checks++
  assert.equal(monthlyRevision.items_before.find(row => row.employee_id===ids.employee).social_security_enabled,true); checks++
  await db.query('UPDATE hr_payroll_items SET social_security_enabled=false,social_security=875 WHERE payroll_run_id=$1',[monthlyRun])
  assert.ok((await db.query('SELECT social_security FROM hr_payroll_items WHERE payroll_run_id=$1',[monthlyRun])).rows.every(row=>Number(row.social_security)===0)); checks++
  await actor(ids.hr)
  await reject('SELECT hr_reopen_monthly_payroll($1,$2)',[monthlyRun,'Unauthorized'],/ไม่มีสิทธิ์/)
  await db.exec('RESET ROLE')
  const company = '50000000-0000-0000-0000-000000000001'
  await db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN company_id uuid DEFAULT '${company}', ADD COLUMN payroll_month date DEFAULT '2026-09-01';
    ALTER TABLE hr_employees ADD COLUMN company_id uuid DEFAULT '${company}';
    ALTER TABLE hr_payroll_items ADD COLUMN pay_type text DEFAULT 'permanent';
    ALTER TABLE hr_payroll_runs ADD CONSTRAINT hr_payroll_runs_payroll_type_check CHECK(payroll_type IN ('permanent','daily'));
    ALTER TABLE hr_payroll_runs ADD CONSTRAINT hr_payroll_runs_month_company_type_key UNIQUE(payroll_month,company_id,payroll_type);`)
  const insuredOctober = '30000000-0000-0000-0000-000000000003'
  const mixedDecember = '30000000-0000-0000-0000-000000000004'
  for (const [id,month] of [[insuredOctober,'2026-10-01'],[mixedDecember,'2026-12-01']]) {
    await db.query("INSERT INTO hr_payroll_runs(id,payroll_month,status,payroll_type,confirmed_at,confirmed_by) VALUES($1,$2,'draft','permanent',now(),$3)",[id,month,ids.account])
    await db.query('INSERT INTO hr_payroll_items(payroll_run_id,employee_id,employee_code,base_salary,social_security,social_security_enabled,reviewed_at) VALUES($1,$2,$3,18000,875,true,now())',[id,ids.employee,'EMP00024'])
    if (id===mixedDecember) await db.query('INSERT INTO hr_payroll_items(payroll_run_id,employee_id,employee_code,base_salary,social_security,social_security_enabled,reviewed_at) VALUES($1,$2,$3,18000,0,false,now())',[id,ids.other,'EMP00025'])
    await db.query("UPDATE hr_payroll_runs SET status='confirmed' WHERE id=$1",[id])
  }
  const moneyBefore = (await db.query('SELECT id,employee_id,base_salary,social_security,other_deduction,net_pay FROM hr_payroll_items ORDER BY id')).rows
  const octoberBefore = (await db.query('SELECT * FROM hr_payroll_runs WHERE id=$1',[insuredOctober])).rows[0]
  const groupsMigration = await fs.readFile('supabase/migrations/682_independent_monthly_payroll_groups.sql','utf8')
  await db.exec(groupsMigration)
  await db.exec(groupsMigration)
  assert.deepEqual((await db.query('SELECT id,employee_id,base_salary,social_security,other_deduction,net_pay FROM hr_payroll_items ORDER BY id')).rows,moneyBefore); checks++
  assert.deepEqual((await db.query('SELECT * FROM hr_payroll_runs WHERE id=$1',[insuredOctober])).rows[0],{...octoberBefore,split_from_run_id:null}); checks++
  assert.equal((await db.query("SELECT count(*) n FROM hr_payroll_runs WHERE payroll_month='2026-10-01' AND payroll_type='monthly_uninsured'")).rows[0].n,0); checks++
  const decemberRuns = (await db.query("SELECT id,status,payroll_type,confirmed_by,split_from_run_id FROM hr_payroll_runs WHERE payroll_month='2026-12-01' ORDER BY payroll_type")).rows
  assert.equal(decemberRuns.length,2); checks++
  assert.ok(decemberRuns.every(row=>row.status==='confirmed' && row.confirmed_by===ids.account)); checks++
  assert.equal(decemberRuns.find(row=>row.payroll_type==='monthly_uninsured').split_from_run_id,mixedDecember); checks++
  const migrationAudit = (await db.query("SELECT items_before FROM hr_payroll_revisions WHERE payroll_run_id=$1 AND reason LIKE 'Migration 682:%'",[mixedDecember])).rows
  assert.equal(migrationAudit[0].items_before.length,2); checks++
  const uninsuredOctober = (await db.query("INSERT INTO hr_payroll_runs(payroll_month,payroll_type,status) VALUES('2026-10-01','monthly_uninsured','draft') RETURNING id")).rows[0].id
  await actor(ids.account)
  await db.query('INSERT INTO hr_payroll_items(payroll_run_id,employee_id,employee_code,base_salary,social_security_enabled) VALUES($1,$2,$3,18000,false)',[uninsuredOctober,ids.other,'EMP00025'])
  assert.equal((await db.query('SELECT status FROM hr_payroll_runs WHERE id=$1',[uninsuredOctober])).rows[0].status,'draft'); checks++
  await reject('INSERT INTO hr_payroll_items(payroll_run_id,employee_id,employee_code,base_salary,social_security_enabled) VALUES($1,$2,$3,18000,false)',[uninsuredOctober,ids.employee,'EMP00024'],/อีกกลุ่มแล้ว/)
  await db.query("UPDATE hr_payroll_runs SET status='confirmed' WHERE id=$1",[uninsuredOctober])
  await db.query('SELECT hr_reopen_monthly_payroll($1,$2)',[uninsuredOctober,'Reopen only uninsured group'])
  assert.equal((await db.query('SELECT status FROM hr_payroll_runs WHERE id=$1',[insuredOctober])).rows[0].status,'confirmed'); checks++
  assert.equal((await db.query('SELECT status FROM hr_payroll_runs WHERE id=$1',[uninsuredOctober])).rows[0].status,'draft'); checks++
  const novemberInsured=(await db.query("INSERT INTO hr_payroll_runs(payroll_month,payroll_type,status) VALUES('2026-11-01','permanent','draft') RETURNING id")).rows[0].id
  const novemberUninsured=(await db.query("INSERT INTO hr_payroll_runs(payroll_month,payroll_type,status) VALUES('2026-11-01','monthly_uninsured','draft') RETURNING id")).rows[0].id
  await db.exec('RESET ROLE')
  await db.query('UPDATE hr_employees SET social_security_enabled=true WHERE id=$1',[ids.other])
  await actor(ids.account)
  await db.query('INSERT INTO hr_payroll_items(payroll_run_id,employee_id,base_salary,other_deduction,social_security_enabled) VALUES($1,$2,18000,123,true)',[novemberInsured,ids.other])
  await db.exec('RESET ROLE')
  await db.query('UPDATE hr_employees SET social_security_enabled=false WHERE id=$1',[ids.other])
  await actor(ids.account)
  await db.query('INSERT INTO hr_payroll_items(payroll_run_id,employee_id,base_salary,other_deduction,social_security_enabled) VALUES($1,$2,18000,123,false)',[novemberUninsured,ids.other])
  assert.equal((await db.query('SELECT count(*) n FROM hr_payroll_items WHERE payroll_run_id=ANY($1::uuid[])',[ [novemberInsured,novemberUninsured] ])).rows[0].n,1); checks++
  assert.equal(Number((await db.query('SELECT other_deduction FROM hr_payroll_items WHERE payroll_run_id=$1',[novemberUninsured])).rows[0].other_deduction),123); checks++
  await reject('INSERT INTO hr_payroll_items(payroll_run_id,employee_id,base_salary,social_security_enabled) VALUES($1,$2,18000,true)',[novemberUninsured,ids.employee],/ไม่ตรงกับกลุ่ม/)
  await db.exec('RESET ROLE; ALTER TABLE hr_payroll_items ADD CONSTRAINT test_salary_nonnegative CHECK(base_salary>=0)')
  await db.query('UPDATE hr_employees SET social_security_enabled=true WHERE id=$1',[ids.other])
  await actor(ids.account)
  await reject('INSERT INTO hr_payroll_items(payroll_run_id,employee_id,base_salary,social_security_enabled) VALUES($1,$2,-1,true)',[novemberInsured,ids.other],/check constraint/)
  assert.equal((await db.query('SELECT count(*) n FROM hr_payroll_items WHERE payroll_run_id=$1',[novemberUninsured])).rows[0].n,1); checks++
  await db.exec(`RESET ROLE;
    ALTER TABLE hr_employees ADD COLUMN employee_code text, ADD COLUMN hire_date date, ADD COLUMN salary numeric,
      ADD COLUMN contract_type text, ADD COLUMN position_allowance numeric;
    ALTER TABLE hr_payroll_items ADD COLUMN daily_wage_details jsonb, ADD COLUMN overtime_pay numeric DEFAULT 0;
    CREATE TABLE hr_salary_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),employee_id uuid REFERENCES hr_employees(id),
      salary numeric NOT NULL,position_allowance numeric,pay_type text NOT NULL,effective_date date NOT NULL,note text,created_at timestamptz DEFAULT now());`)
  await db.query("UPDATE hr_employees SET employee_code='EMP00024',hire_date='2026-10-19',salary=18000,contract_type='permanent',position_allowance=0 WHERE id=$1",[ids.employee])
  await db.query("UPDATE hr_employees SET employee_code='EMP00025',hire_date='2026-10-01',salary=600,contract_type='daily',position_allowance=0 WHERE id=$1",[ids.other])
  await db.query("INSERT INTO hr_salary_history(employee_id,salary,pay_type,effective_date,created_at) VALUES($1,600,'daily','2026-10-19','2026-10-19')",[ids.employee])
  const staleDaily = (await db.query("INSERT INTO hr_payroll_runs(payroll_month,payroll_type,status) VALUES('2026-10-01','daily','draft') RETURNING id")).rows[0].id
  await db.query("INSERT INTO hr_payroll_items(payroll_run_id,employee_id,employee_code,pay_type,base_salary) VALUES($1,$2,'EMP00024','daily',5400)",[staleDaily,ids.employee])
  await db.query("INSERT INTO hr_payroll_items(payroll_run_id,employee_id,employee_code,pay_type,base_salary) VALUES($1,$2,'EMP00025','daily',600)",[staleDaily,ids.other])
  const protectedConfirmed = (await db.query("SELECT i.id,i.base_salary,i.social_security,i.net_pay FROM hr_payroll_items i JOIN hr_payroll_runs r ON r.id=i.payroll_run_id WHERE r.status='confirmed' ORDER BY i.id")).rows
  const compensationMigration = await fs.readFile('supabase/migrations/683_payroll_effective_compensation_and_proration.sql','utf8')
  await db.exec(compensationMigration)
  await db.exec(compensationMigration)
  const effective = (await db.query('SELECT salary,pay_type,effective_date FROM hr_salary_history WHERE employee_id=$1 ORDER BY effective_date DESC,created_at DESC,id DESC LIMIT 1',[ids.employee])).rows[0]
  assert.equal(Number(effective.salary),18000); checks++
  assert.equal(effective.pay_type,'permanent'); checks++
  assert.equal(new Date(effective.effective_date).toISOString().slice(0,10),'2026-10-19'); checks++
  assert.equal((await db.query('SELECT count(*) n FROM hr_salary_history WHERE employee_id=$1',[ids.employee])).rows[0].n,2); checks++
  assert.equal((await db.query('SELECT count(*) n FROM hr_compensation_corrections WHERE employee_id=$1',[ids.employee])).rows[0].n,1); checks++
  assert.deepEqual((await db.query("SELECT i.id,i.base_salary,i.social_security,i.net_pay FROM hr_payroll_items i JOIN hr_payroll_runs r ON r.id=i.payroll_run_id WHERE r.status='confirmed' ORDER BY i.id")).rows,protectedConfirmed); checks++
  assert.equal((await db.query('SELECT count(*) n FROM hr_payroll_items WHERE payroll_run_id=$1 AND employee_id=$2',[staleDaily,ids.employee])).rows[0].n,0); checks++
  assert.equal((await db.query('SELECT count(*) n FROM hr_payroll_items WHERE payroll_run_id=$1 AND employee_id=$2',[staleDaily,ids.other])).rows[0].n,1); checks++
  assert.equal((await db.query("SELECT items_before FROM hr_payroll_revisions WHERE payroll_run_id=$1 AND reason LIKE 'Migration 683:%'",[staleDaily])).rows[0].items_before.length,2); checks++
  const newEmployee='20000000-0000-0000-0000-000000000026'
  await db.query("INSERT INTO hr_employees(id,employee_code,company_id,salary,contract_type,hire_date,social_security_enabled) VALUES($1,'EMP00026',$2,18000,'permanent','2026-09-01',false)",[newEmployee,company])
  assert.equal((await db.query('SELECT count(*) n FROM hr_salary_history WHERE employee_id=$1',[newEmployee])).rows[0].n,1); checks++
  const countBefore=(await db.query('SELECT count(*) n FROM hr_salary_history WHERE employee_id=$1',[newEmployee])).rows[0].n
  await db.query('UPDATE hr_employees SET social_security_enabled=false WHERE id=$1',[newEmployee])
  assert.equal((await db.query('SELECT count(*) n FROM hr_salary_history WHERE employee_id=$1',[newEmployee])).rows[0].n,countBefore); checks++
  await reject("UPDATE hr_employees SET salary=19000,compensation_effective_date=((now() AT TIME ZONE 'Asia/Bangkok')::date+7) WHERE id=$1",[newEmployee],/ล่วงหน้า/)
  assert.equal(Number((await db.query('SELECT salary FROM hr_employees WHERE id=$1',[newEmployee])).rows[0].salary),18000); checks++
  const dailyNovember=(await db.query("INSERT INTO hr_payroll_runs(payroll_month,payroll_type,status) VALUES('2026-11-01','daily','draft') RETURNING id")).rows[0].id
  await actor(ids.account)
  await db.query("INSERT INTO hr_payroll_items(payroll_run_id,employee_id,employee_code,pay_type,base_salary,daily_wage_details) VALUES($1,$2,'EMP00026','daily',600,$3)",[dailyNovember,newEmployee,JSON.stringify([{workDate:'2026-11-18',amount:600,payableDay:1}])])
  await db.query("UPDATE hr_payroll_runs SET status='confirmed' WHERE id=$1",[dailyNovember])
  await db.query("INSERT INTO hr_payroll_items(payroll_run_id,employee_id,employee_code,pay_type,base_salary,monthly_rate,monthly_payable_days,monthly_wage_details,social_security_enabled) VALUES($1,$2,'EMP00026','permanent',7200,18000,12,$3,false)",[novemberUninsured,newEmployee,JSON.stringify([{startDate:'2026-11-19',endDate:'2026-11-30'}])])
  await db.query("UPDATE hr_payroll_runs SET status='confirmed' WHERE id=$1",[novemberUninsured])
  assert.equal((await db.query('SELECT status FROM hr_payroll_runs WHERE id=$1',[novemberUninsured])).rows[0].status,'confirmed'); checks++
  await db.query('SELECT hr_reopen_daily_payroll($1,$2)',[dailyNovember,'Test stale daily overlap after effective contract correction'])
  await db.query('UPDATE hr_payroll_items SET daily_wage_details=$2 WHERE payroll_run_id=$1',[dailyNovember,JSON.stringify([{workDate:'2026-11-19',amount:600,payableDay:1}])])
  await reject("UPDATE hr_payroll_runs SET status='confirmed' WHERE id=$1",[dailyNovember],/ช่วงวันเดียวกัน/)
  assert.equal((await db.query('SELECT status FROM hr_payroll_runs WHERE id=$1',[dailyNovember])).rows[0].status,'draft'); checks++
  assert.equal((await db.query('SELECT status FROM hr_payroll_runs WHERE id=$1',[novemberUninsured])).rows[0].status,'confirmed'); checks++
  await db.exec('RESET ROLE')
  await db.exec(`CREATE TABLE hr_companies(id uuid PRIMARY KEY,name_th text,ewf_enabled boolean DEFAULT false);
    CREATE TABLE hr_social_security_settings(id boolean PRIMARY KEY,contribution_rate numeric,maximum_wage_base numeric);
    INSERT INTO hr_social_security_settings VALUES(true,5,17500);`)
  await db.query("INSERT INTO hr_companies(id,name_th) VALUES($1,'Test company')",[company])
  for(const column of ['monthly_personal_tax','monthly_savings','monthly_student_loan','monthly_company_loan','income_opening_balance','personal_tax_opening_balance','social_security_opening_balance','ewf_opening_balance','student_loan_opening_balance','savings_opening_balance','company_loan_opening_balance','company_loan_opening_installments']) await db.exec(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS ${column} numeric DEFAULT 0`)
  await db.exec('ALTER TABLE hr_employees ADD COLUMN savings_maximum numeric')
  for(const column of ['position_allowance','other_income','personal_tax','ewf','savings','student_loan','company_loan','leave_deduction','ot_normal_hours','ot_holiday_hours','daily_rate','full_days','half_days','paid_holiday_days','unpaid_leave_days','payable_days','unresolved_attendance_days','income_opening_balance','personal_tax_opening_balance','social_security_opening_balance','ewf_opening_balance','student_loan_opening_balance','savings_opening_balance','company_loan_opening_balance','company_loan_opening_installments']) await db.exec(`ALTER TABLE hr_payroll_items ADD COLUMN IF NOT EXISTS ${column} numeric DEFAULT 0`)
  await db.exec(`ALTER TABLE hr_payroll_items ADD COLUMN employee_name text, ADD COLUMN employee_nickname text, ADD COLUMN department_position text,
    ADD COLUMN company_snapshot jsonb DEFAULT '{}';
    ALTER TABLE hr_payroll_items DROP COLUMN net_pay;
    ALTER TABLE hr_payroll_items ADD COLUMN gross_income numeric GENERATED ALWAYS AS(base_salary+position_allowance+overtime_pay+other_income) STORED,
      ADD COLUMN total_deduction numeric GENERATED ALWAYS AS(personal_tax+social_security+ewf+savings+student_loan+company_loan+leave_deduction+other_deduction) STORED,
      ADD COLUMN net_pay numeric GENERATED ALWAYS AS(base_salary+position_allowance+overtime_pay+other_income-personal_tax-social_security-ewf-savings-student_loan-company_loan-leave_deduction-other_deduction) STORED;
    ALTER TABLE hr_payroll_items ADD CONSTRAINT hr_payroll_items_run_employee_unique UNIQUE(payroll_run_id,employee_id);`)
  const scheduleMigration=await fs.readFile('supabase/migrations/684_payroll_schedules_and_atomic_periods.sql','utf8')
  const paymentMigration=await fs.readFile('supabase/migrations/685_payroll_payments_and_adjustments.sql','utf8')
  await db.exec(scheduleMigration)
  await db.exec(paymentMigration)
  const {testPayrollPeriods}=await import('../lib/payroll-period-test-cases.mjs')
  checks+=await testPayrollPeriods(db,{actor,ids,company,employee:newEmployee})
  await db.exec('RESET ROLE')
  const paymentsBefore=(await db.query('SELECT * FROM hr_payroll_payments ORDER BY id')).rows
  const allocationsBefore=(await db.query('SELECT * FROM hr_payroll_effective_monthly_allocations ORDER BY allocation_key')).rows
  await db.exec(scheduleMigration)
  await db.exec(paymentMigration)
  assert.deepEqual((await db.query('SELECT * FROM hr_payroll_payments ORDER BY id')).rows,paymentsBefore);checks++
  assert.deepEqual((await db.query('SELECT * FROM hr_payroll_effective_monthly_allocations ORDER BY allocation_key')).rows,allocationsBefore);checks++
  console.log(JSON.stringify({ database: 'isolated PGlite', migrations: ['680','681','682','683','684','685'], checks, passed: true, production_access: false }))
} finally { await db.close() }
