// Reviewable maintenance only. No production execution is part of authoring
// this script. Every mutation is hard-scoped to EMP00024 / October 2026.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { connectHrRepairDatabase } from './lib/hr-repair-db.mjs'

const mode = process.argv[2] || 'help'
if (mode === 'help' || mode === '--help') {
  console.log(`Privileged EMP00024 / 2026-10 repair; requires separate database authorization.
node scripts/repair-emp00024-appeal-payroll.mjs audit
  Reads the target data and writes .tmp/hr-appeal-review/plan-<hash>.json. No DB writes.
Review that plan, choose 0.5 or 1 for each date, and enter supporting evidence.
node scripts/repair-emp00024-appeal-payroll.mjs rehearse <reviewed-plan.json>
  Installs migration 680 and rehearses the repair inside a ROLLBACK transaction.
node scripts/repair-emp00024-appeal-payroll.mjs apply <reviewed-plan.json>
  Re-checks the snapshot, saves a backup, installs 680, grants the selected wages,
  recalculates OPEN scores, and opens any confirmed DAILY payroll with a revision.
  Payroll is left DRAFT for slip review/reconfirmation in the application.
Locked score periods require a separately reviewed correction; this script stops.
No employee salary/contract, clock entry, or other employee's payroll item is changed.`)
  process.exit(0)
}
assert.ok(['audit', 'rehearse', 'apply'].includes(mode), 'Expected audit, rehearse, or apply')
const planPath = process.argv[3]
assert.ok(mode === 'audit' || planPath, 'A reviewed plan is required')
const plan = planPath ? JSON.parse(await fs.readFile(planPath, 'utf8')) : null
if (plan) {
  assert.equal(plan.employee_code, 'EMP00024'); assert.equal(plan.month, '2026-10')
  assert.ok(typeof plan.reason === 'string' && plan.reason.trim(), 'Enter the repair reason/evidence')
  assert.deepEqual(Object.keys(plan.payable_days).sort(), ['2026-10-19', '2026-10-20'])
  for (const day of Object.values(plan.payable_days)) assert.ok([0.5, 1].includes(day), 'Choose explicit full/half days')
  assert.match(plan.as_of_date, /^\d{4}-\d{2}-\d{2}$/)
}
const root = path.resolve('.tmp/hr-appeal-review')
await fs.mkdir(root, { recursive: true })
const require = createRequire(import.meta.url)
const ts = require('typescript')
function loadTs(file, dependencies = {}) {
  const code = ts.transpileModule(file, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => dependencies[name] || require(name), module, module.exports)
  return module.exports
}
const late = loadTs(await fs.readFile('src/lib/lateDuration.ts', 'utf8'))
const engine = loadTs(await fs.readFile('src/lib/workScore.ts', 'utf8'), { './lateDuration': late })
const asOf = plan?.as_of_date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const until = engine.scoringEndDate('2026-10', asOf)
assert.ok(until && until >= '2026-10-20', 'The two target dates must be completed')
const db = await connectHrRepairDatabase()
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const rows = async (sql, args = []) => (await db.query(sql, args)).rows
try {
  await db.query(mode === 'audit' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN ISOLATION LEVEL SERIALIZABLE')
  await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='45s'")
  if (mode !== 'audit') await db.query("SELECT pg_advisory_xact_lock(hashtext('emp00024-october-2026-appeal-repair'))")
  const employees = await rows(`SELECT id,employee_code,company_id,contract_type,salary,employment_status,
    hire_date,contract_end_date,work_schedule_id,work_mode FROM hr_employees WHERE employee_code='EMP00024'`)
  assert.equal(employees.length, 1)
  const employee = employees[0]
  const id = employee.id
  if (mode !== 'audit') {
    await rows('SELECT id FROM hr_employees WHERE id=$1 FOR UPDATE', [id])
    await rows("SELECT id FROM hr_score_appeals WHERE employee_id=$1 AND event_date BETWEEN '2026-10-01' AND '2026-10-31' FOR UPDATE", [id])
    await rows("SELECT id FROM hr_payroll_runs WHERE company_id=$1 AND payroll_month='2026-10-01' ORDER BY id FOR UPDATE", [employee.company_id])
  }
  const appeals = await rows("SELECT * FROM hr_score_appeals WHERE employee_id=$1 AND event_date BETWEEN '2026-10-01' AND '2026-10-31' ORDER BY id", [id])
  const events = await rows("SELECT * FROM hr_score_events WHERE employee_id=$1 AND event_date BETWEEN '2026-10-01' AND '2026-10-31' ORDER BY id", [id])
  const periods = await rows("SELECT * FROM hr_score_periods WHERE employee_id=$1 AND period='2026-10-01' ORDER BY id", [id])
  const rules = await rows('SELECT * FROM hr_score_rules ORDER BY id')
  const categories = await rows("SELECT * FROM hr_score_categories WHERE code='discipline'")
  assert.equal(categories.length, 1)
  const category = Object.fromEntries(Object.entries(categories[0]).map(([key, value]) => [key, ['base_points', 'min_points'].includes(key) ? Number(value) : value]))
  const openings = await rows('SELECT * FROM hr_employee_opening_attendance WHERE employee_id=$1 AND year=2026 ORDER BY id', [id])
  const histories = await rows('SELECT * FROM hr_salary_history WHERE employee_id=$1 ORDER BY effective_date DESC,id', [id])
  const payroll = await rows("SELECT i.*,r.status run_status,r.payroll_month FROM hr_payroll_items i JOIN hr_payroll_runs r ON r.id=i.payroll_run_id WHERE i.employee_id=$1 AND r.payroll_month='2026-10-01' ORDER BY i.id", [id])
  const protectedBefore = await rows(`SELECT i.id,md5(row_to_json(i)::text) fingerprint FROM hr_payroll_items i JOIN hr_payroll_runs r ON r.id=i.payroll_run_id
    WHERE r.company_id=$1 AND r.payroll_month='2026-10-01' AND i.employee_id<>$2 ORDER BY i.id`, [employee.company_id, id])

  // Read the same underlying fact SELECT as the application, with the employee
  // parameter fixed. Do not impersonate an app user or modify any DB function.
  const factSource = await fs.readFile('supabase/migrations/334_hr_wfh_time_range.sql','utf8')
  const functionSource = factSource.slice(factSource.indexOf('CREATE OR REPLACE FUNCTION hr_attendance_facts('))
  const expectedBody = functionSource.match(/AS \$\$([\s\S]*?)\$\$/)[1]
  const liveBody = await rows("SELECT prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='hr_attendance_facts'")
  const normalize = value => value.replace(/\s+/g,' ').trim()
  assert.equal(liveBody.length, 1)
  assert.equal(normalize(liveBody[0].prosrc), normalize(expectedBody), 'Attendance fact definition changed; review the script before proceeding')
  const names = [...functionSource.match(/RETURNS TABLE \(([\s\S]*?)\)\s*LANGUAGE/)[1].matchAll(/^\s*(\w+)\s+\w+,?\s*$/gm)].map(match => match[1])
  let query = expectedBody.match(/RETURN QUERY([\s\S]*?);\s*END;/)[1]
  query = query.replace(/\bp_from\b/g,'$1::date').replace(/\bp_to\b/g,'$2::date').replace(/\bp_employee\b/g,'$3::uuid')
  const facts = await rows(`SELECT * FROM (${query}) AS facts(${names.join(',')})`, ['2026-10-01', until, id])
  const hasApprovals = (await rows("SELECT to_regclass('public.hr_daily_wage_approvals') IS NOT NULL present"))[0].present
  const existingApprovals = hasApprovals ? await rows("SELECT * FROM hr_daily_wage_approvals WHERE employee_id=$1 AND work_date BETWEEN '2026-10-01' AND '2026-10-31' ORDER BY id", [id]) : []
  const snapshot = { as_of_date: asOf, employee, appeals, events, periods, rules, category, openings, histories, payroll, facts, existingApprovals }
  const snapshotHash = digest(snapshot)
  const proposed = {
    employee_code: 'EMP00024', month: '2026-10', as_of_date: asOf, expected_employee_id: id,
    expected_snapshot_hash: snapshotHash, reason: '', payable_days: { '2026-10-19': null, '2026-10-20': null },
  }
  const index = engine.indexRules(rules.filter(rule => rule.category_id === category.id).map(rule => ({ ...rule, points: Number(rule.points), points_step: Number(rule.points_step), cap_per_month: rule.cap_per_month === null ? null : Number(rule.cap_per_month) })))
  const daily = engine.buildMonthlyScores(facts, category, [...index.values()]).get(id)?.events || []
  const manual = events.filter(event => event.source === 'manual').map(event => ({
    ...event, rule_id: event.rule_id || '', points: Number(event.points), group_code: index.get(engine.baseEventCode(event.event_code))?.group_code || 'manual',
    label: event.note || event.event_code,
  }))
  const opening = openings.find(row => row.effective_date.slice(0,7) === '2026-10')
  const summary = engine.summarizeMonth(id, [...daily, ...engine.buildOpeningAttendanceEvents(opening, category, [...index.values()]), ...manual], category, index)
  console.log(JSON.stringify({ mode, employee: employee.employee_code, proposed_score: summary.total_points,
    payroll: payroll.map(item => ({ id: item.id, status: item.run_status, base_salary: item.base_salary })),
    snapshot_hash: snapshotHash, existing_approvals: existingApprovals.length }))
  if (mode === 'audit') {
    const outputPlan = path.join(root,`plan-${snapshotHash}.json`)
    await fs.writeFile(outputPlan, JSON.stringify(proposed,null,2), { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
    console.log(JSON.stringify({ plan_to_review: outputPlan }))
    await fs.writeFile(path.join(root,`audit-${snapshotHash}.json`), JSON.stringify({ snapshot, proposed_summary: summary },null,2))
    await db.query('ROLLBACK')
  } else {
    assert.equal(plan.expected_employee_id, id)
    assert.equal(plan.expected_snapshot_hash, snapshotHash, 'Data changed after audit; review a fresh plan')
    assert.ok(periods.every(period => period.status !== 'locked'), 'A score period is locked; obtain a separate reviewed score correction before proceeding')
    // The agreed correction is specifically the two accepted base absences.
    const targets = Object.entries(plan.payable_days).map(([date, payableDay]) => {
      const matches = appeals.filter(appeal => appeal.event_date === date && appeal.status === 'accepted' && ['absent','absent_pending_leave'].includes(appeal.event_code))
      assert.equal(matches.length,1, `Expected one accepted base absence on ${date}`)
      assert.equal(Number(matches[0].points),-20)
      assert.ok(!existingApprovals.some(row => row.work_date === date), `${date} already has a wage approval`)
      const compensation = histories.find(row => row.effective_date <= date)
      assert.ok(compensation && compensation.pay_type === 'daily', `Historical daily rate required for ${date}`)
      assert.equal(Number(compensation.salary),600, 'Unexpected historical rate; review before changing wages')
      return { date, payableDay, appeal: matches[0], amount: 600 * payableDay }
    })
    const migration = await fs.readFile('supabase/migrations/680_hr_appeal_wages_and_payroll_revisions.sql','utf8')
    const installed = await rows("SELECT name FROM supabase_migrations.schema_migrations WHERE version='680'")
    if (installed.length) assert.equal(installed[0].name,'hr_appeal_wages_and_payroll_revisions')
    else {
      await db.query(migration.replace(/^BEGIN;\s*$/gm,'').replace(/^COMMIT;\s*$/gm,''))
      await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[])', ['680','hr_appeal_wages_and_payroll_revisions',[migration]])
    }
    await fs.writeFile(path.join(root,`before-${snapshotHash}.json`), JSON.stringify(snapshot,null,2), { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
    for (const target of targets) {
      await db.query(`INSERT INTO hr_daily_wage_approvals(employee_id,work_date,appeal_id,payable_day,note)
        VALUES($1,$2,$3,$4,$5)`, [id,target.date,target.appeal.id,target.payableDay,`Maintenance EMP00024/2026-10: ${plan.reason.trim()}`])
    }
    await db.query('INSERT INTO hr_score_correction_audit(employee_id,period,reason,before_data,after_data) VALUES($1,$2,$3,$4,$5)', [id,'2026-10-01',plan.reason,JSON.stringify({ periods, events }),JSON.stringify(summary)])
    await db.query(`UPDATE hr_score_periods SET base_points=$3,raw_deduction=$4,total_points=$5,updated_at=now()
      WHERE employee_id=$1 AND period='2026-10-01' AND category_id=$2 AND status='open'`, [id,category.id,summary.base_points,summary.raw_deduction,summary.total_points])
    const dailyRuns = await rows("SELECT * FROM hr_payroll_runs WHERE company_id=$1 AND payroll_month='2026-10-01' AND payroll_type='daily' FOR UPDATE", [employee.company_id])
    assert.equal(dailyRuns.length,1, 'Expected an existing daily payroll; use the UI to create it if absent')
    const run = dailyRuns[0]
    assert.ok(payroll.some(item => item.payroll_run_id === run.id), 'Employee is not part of the original daily run')
    if (run.status === 'confirmed') {
      const items = await rows('SELECT * FROM hr_payroll_items WHERE payroll_run_id=$1 ORDER BY employee_code', [run.id])
      await db.query('INSERT INTO hr_payroll_revisions(payroll_run_id,reason,run_before,items_before) VALUES($1,$2,$3,$4)', [run.id,plan.reason,JSON.stringify(run),JSON.stringify(items)])
      await db.query("UPDATE hr_payroll_runs SET status='draft',confirmed_at=NULL,confirmed_by=NULL,updated_at=now() WHERE id=$1", [run.id])
    }
    // Leave other employees' item snapshots intact. The UI recomputes the draft
    // and invalidates any reviews whose amounts change before saving.
    await db.query('UPDATE hr_payroll_items SET reviewed_at=NULL,reviewed_by=NULL WHERE payroll_run_id=$1 AND employee_id=$2', [run.id,id])
    const protectedAfter = await rows(`SELECT i.id,md5(row_to_json(i)::text) fingerprint FROM hr_payroll_items i JOIN hr_payroll_runs r ON r.id=i.payroll_run_id
      WHERE r.company_id=$1 AND r.payroll_month='2026-10-01' AND i.employee_id<>$2 ORDER BY i.id`, [employee.company_id,id])
    assert.deepEqual(protectedAfter,protectedBefore,'Another employee payroll item changed')
    const verified = await rows('SELECT work_date,payable_day FROM hr_daily_wage_approvals WHERE employee_id=$1 AND work_date=ANY($2::date[]) ORDER BY work_date', [id,targets.map(target => target.date)])
    assert.equal(verified.length,2)
    if (mode === 'apply') await db.query('COMMIT'); else await db.query('ROLLBACK')
    console.log(JSON.stringify({ mode, committed: mode === 'apply', score: summary.total_points, approved_days: verified,
      target_wages: targets.reduce((sum,target) => sum+target.amount,0), payroll_left_draft: true, other_employee_items_unchanged: true }))
  }
} catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error }
finally { await db.end() }
