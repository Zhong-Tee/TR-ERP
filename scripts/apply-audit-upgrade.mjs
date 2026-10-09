import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'

// Apply this reviewed migration only; other work in the shared checkout is not deployed.
const path = 'supabase/migrations/643_audit_movement_and_separate_safety.sql'
const sql = (await fs.readFile(path, 'utf8')).replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, '')
const dump = execFileSync('supabase', ['db', 'dump', '--linked', '--dry-run'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const vars = {}
for (const m of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
const client = new pg.Client({ host: vars.PGHOST, port: Number(vars.PGPORT), user: vars.PGUSER, password: vars.PGPASSWORD, database: vars.PGDATABASE, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 })
async function fingerprints() {
  return (await client.query(`SELECT
    (SELECT md5(COALESCE(string_agg(to_jsonb(a)::text,'' ORDER BY a.id),'')) FROM inv_audits a) audits,
    (SELECT md5(COALESCE(string_agg((to_jsonb(i)-ARRAY['count_mode','product_type','system_reserved'])::text,'' ORDER BY i.id),'')) FROM inv_audit_items i) items,
    (SELECT md5(COALESCE(string_agg(to_jsonb(b)::text,'' ORDER BY b.product_id),'')) FROM inv_stock_balances b) balances`)).rows[0]
}
try {
  await client.connect()
  await client.query('SET ROLE postgres')
  await client.query('BEGIN')
  await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'")
  await client.query('SELECT pg_advisory_xact_lock(64320261009)')
  assert.equal((await client.query("select count(*)::int n from supabase_migrations.schema_migrations where version='643'")).rows[0].n,0,'Migration 643 is already installed')
  // Lock only Audit records during the cutover. Stock rows are not modified.
  await client.query('LOCK TABLE inv_audits,inv_audit_items IN SHARE ROW EXCLUSIVE MODE')
  assert.equal((await client.query("select count(*)::int n from inv_audits where status in ('draft','in_progress','review')")).rows[0].n,0,'Open audits exist; stop cutover')
  const before = await fingerprints()
  await client.query(sql)
  const after = await fingerprints()
  assert.deepEqual(after,before,'Existing audit records or stock changed during migration')
  await client.query("insert into supabase_migrations.schema_migrations(version,name,statements) values('643','audit_movement_and_separate_safety',$1::text[])",[[sql]])
  await client.query('COMMIT')
  console.log(JSON.stringify({ migration: '643', installed: true, existingAuditsUnchanged: true, stockUnchanged: true }))
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  console.error(error.message)
  process.exitCode=1
} finally { await client.end() }
