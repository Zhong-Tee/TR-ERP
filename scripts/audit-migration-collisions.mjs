import {assertLegacyMigrationReplayAllowed} from './lib/legacy-migration-guard.mjs'
if(process.argv.includes('--repair-history'))assertLegacyMigrationReplayAllowed('--repair-history')
// Default: read-only inspection. --repair-history registers verified deployments only.
// Setup: npm install --prefix .tmp/migration-audit-runtime --no-save --package-lock=false pg
// Credentials stay in memory and are never printed. No migration SQL is executed.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import pg from '../.tmp/migration-audit-runtime/node_modules/pg/lib/index.js'

let db
try {
  const output = execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx --yes supabase@2.54.11 db dump --linked --dry-run'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
  })
  const vars = {}
  for (const match of output.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
  const ref = fs.readFileSync('supabase/.temp/project-ref', 'utf8').trim()
  if (!vars.PGHOST || !vars.PGPASSWORD || !(vars.PGHOST.includes(ref) || vars.PGUSER?.includes(ref))) throw new Error('target')
  if (!fs.readFileSync('.env', 'utf8').includes(`${ref}.supabase.co`)) throw new Error('target')
  db = new pg.Client({ host: vars.PGHOST, port: Number(vars.PGPORT), user: vars.PGUSER,
    password: vars.PGPASSWORD, database: vars.PGDATABASE, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 })
  await db.connect()
  await db.query('SET ROLE postgres')
  await db.query('BEGIN READ ONLY')
  await db.query("SET LOCAL statement_timeout = '15s'")
  const history = (await db.query('SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version')).rows
  const files = fs.readdirSync('supabase/legacy-migrations/pre-baseline-20261104').filter(f => /^69\d_.*\.sql$/.test(f)).sort()
  const results = []
  for (const file of files) {
    const sql = fs.readFileSync(`supabase/legacy-migrations/pre-baseline-20261104/${file}`, 'utf8')
    const functions = []
    for (const match of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(/gi)) {
      const rows = (await db.query(`SELECT pg_get_function_identity_arguments(p.oid) AS arguments, p.prosrc AS body
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`, [match[1]])).rows
      const section = sql.slice(match.index)
      const body = section.match(/AS\s+(\$\w*\$)([\s\S]*?)\1/i)?.[2]
      functions.push({ name: match[1], exists: rows.length > 0,
        exactBodyMatch: !!body && rows.some(row => row.body.replace(/\r\n/g, '\n').trim() === body.replace(/\r\n/g, '\n').trim()) })
    }
    results.push({ file, functions })
  }
  const columns = (await db.query("SELECT column_name, is_generated, generation_expression FROM information_schema.columns WHERE table_schema='public' AND table_name='or_orders' AND column_name='receivable_amount'")).rows
  const tables = (await db.query("SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('or_tax_audit','or_tax_invoice_counters','or_tax_invoices')")).rows
  const policies = (await db.query("SELECT schemaname, tablename, policyname, cmd, roles FROM pg_policies WHERE policyname IN ('tax_audit_read','tax_invoice_read','tax_evidence_insert','tax_evidence_read') ORDER BY policyname")).rows
  const bucket = (await db.query("SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id='tax-evidence'")).rows
  const triggers = (await db.query("SELECT t.tgname, t.tgenabled, p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.or_orders'::regclass AND t.tgname='zzzzz_tax_guard'")).rows
  await db.query('ROLLBACK')
  const report = { project: ref, checkedAt: new Date().toISOString(), readOnly: true, history, results, columns, tables, policies, bucket, triggers }
  fs.writeFileSync('.tmp/migration-collision-audit.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, history: history.filter(row => Number(row.version) >= 686) }, null, 2))
  if (process.argv.includes('--repair-history')) {
    // Fail closed: do not label any migration applied if inspection is incomplete.
    const expected = ['690_packing_history_and_report_pagination.sql', '691_plan_read_summaries.sql', '692_packing_write_efficiency.sql',
      '695_tax_workflow.sql', '696_tax_invoice_numbering.sql', '697_tax_receivable_payment_paths.sql', '698_tax_evidence.sql', '699_tax_queue.sql']
    if (results.length !== expected.length || !expected.every(file => results.some(r => r.file === file)) ||
      results.some(r => r.functions.some(f => !f.exists || !f.exactBodyMatch)) ||
      columns[0]?.is_generated !== 'ALWAYS' || !columns[0]?.generation_expression?.includes('or_tax_receivable') ||
      tables.length !== 3 || tables.some(t => !t.relrowsecurity) || policies.length !== 4 ||
      bucket.length !== 1 || bucket[0].public || Number(bucket[0].file_size_limit) !== 10485760 ||
      triggers.length !== 1 || triggers[0].tgenabled !== 'O' || triggers[0].proname !== 'or_tax_guard') throw new Error('schema verification')
    const versions = expected.map(file => file.split('_')[0])
    if (history.some(row => versions.includes(row.version))) throw new Error('history already registered')
    fs.writeFileSync('.tmp/migration-history-before-numbering-repair.json', JSON.stringify(history, null, 2))
    await db.query('BEGIN')
    try {
      await db.query('LOCK TABLE supabase_migrations.schema_migrations IN SHARE ROW EXCLUSIVE MODE')
      const current = (await db.query('SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version')).rows
      if (JSON.stringify(current) !== JSON.stringify(history)) throw new Error('history changed')
      for (const file of expected) {
        const version = file.split('_')[0]
        const name = file.slice(version.length + 1, -4)
        const sql = fs.readFileSync(`supabase/legacy-migrations/pre-baseline-20261104/${file}`, 'utf8')
        // Register existing deployment only. The SQL is stored as metadata, never executed.
        await db.query('INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES ($1,$2,$3)', [version, name, [sql]])
      }
      await db.query('COMMIT')
      const registered = (await db.query('SELECT version, name FROM supabase_migrations.schema_migrations WHERE version=ANY($1::text[]) ORDER BY version', [versions])).rows
      fs.writeFileSync('.tmp/migration-numbering-repair-result.json', JSON.stringify({ project: ref, repairedAt: new Date().toISOString(), registered,
        businessDataChanged: false, migrationsExecuted: false, files: expected.map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(`supabase/legacy-migrations/pre-baseline-20261104/${file}`)).digest('hex') })) }, null, 2))
      console.log(JSON.stringify({ repairedHistoryOnly: true, registered }, null, 2))
    } catch (error) { await db.query('ROLLBACK'); throw error }
  }
} catch (error) {
  console.error(`Read-only migration inspection failed (${error.code || 'connection/configuration'}). Credentials were not logged.`)
  process.exitCode = 1
} finally { if (db) await db.end().catch(() => {}) }
