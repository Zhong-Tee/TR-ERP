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
const names = ['or_guard_sales_discount', 'or_validate_sales_discount']
const source = await fs.readFile('supabase/migrations/674_sales_discount_approval.sql', 'utf8')
const patch = await fs.readFile('supabase/migrations/675_sales_discount_optional_web_snapshot.sql', 'utf8')
const body = (sql, name) => {
  const start = sql.indexOf(`FUNCTION public.${name}()`)
  assert.ok(start >= 0)
  const begin = sql.indexOf('AS $$', start) + 5
  return sql.slice(begin, sql.indexOf('$$;', begin)).replace(/\s+/g, ' ').trim()
}
const definitions = async () => (await db.query(`SELECT proname,prosrc FROM pg_proc
  WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])`, [names])).rows
try {
  await db.connect()
  await db.query('SET ROLE postgres')
  const installed = (await db.query("SELECT version,name FROM supabase_migrations.schema_migrations WHERE version IN ('607','674','675') ORDER BY version")).rows
  const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='or_orders' AND column_name IN ('web_import_snapshot','discount_approval_enabled')")).rows
  const live = await definitions()
  assert.equal(live.length, 2)
  console.log(JSON.stringify({ mode, project: ref, installed, columns,
    functions: live.map(r => ({ name: r.proname, matches674: r.prosrc.replace(/\s+/g,' ').trim() === body(source,r.proname), matches675: r.prosrc.replace(/\s+/g,' ').trim() === body(patch,r.proname) })) }))
  if (mode === 'audit') {
    console.log(JSON.stringify({
      triggers: (await db.query("SELECT tgname,pg_get_triggerdef(oid) definition FROM pg_trigger WHERE tgrelid='public.or_orders'::regclass AND NOT tgisinternal")).rows,
      required_columns: (await db.query("SELECT column_name,data_type,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='or_orders' AND is_nullable='NO' ORDER BY ordinal_position")).rows,
    }))
  } else if (mode === 'apply') {
    await db.query('BEGIN')
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='45s'")
    await db.query("SELECT pg_advisory_xact_lock(hashtext('sales-discount-migration-675'))")
    const latest = await definitions()
    for (const row of latest) assert.ok([body(source,row.proname), body(patch,row.proname)].includes(row.prosrc.replace(/\s+/g,' ').trim()), `Live ${row.proname} differs; aborting`)
    const existing = (await db.query("SELECT name FROM supabase_migrations.schema_migrations WHERE version='675'")).rows
    if (existing.length) assert.equal(existing[0].name, 'sales_discount_optional_web_snapshot')
    const sql = patch.replace(/^BEGIN;\s*$/gm, '').replace(/^COMMIT;\s*$/gm, '')
    await db.query(sql)
    if (!existing.length) await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[])', ['675','sales_discount_optional_web_snapshot',[sql]])
    for (const row of await definitions()) assert.equal(row.prosrc.replace(/\s+/g,' ').trim(), body(patch,row.proname))
    await db.query("NOTIFY pgrst, 'reload schema'")
    await db.query('COMMIT')
    console.log(JSON.stringify({ migration675_committed: true, functions_verified: true }))
  } else {
    for (const row of live) assert.equal(row.prosrc.replace(/\s+/g,' ').trim(), body(patch,row.proname))
    assert.ok(installed.some(r => r.version === '675'))
    console.log(JSON.stringify({ deployed_migration_verified: true }))
  }
} catch (error) {
  await db.query('ROLLBACK').catch(() => {})
  console.error(error.message)
  process.exitCode = 1
} finally {
  await db.end()
}
