// Uses the existing Supabase CLI linked connection. Never prints connection credentials.
// node scripts/reconciliation-workspace-db.mjs audit|rehearse|apply
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'
const mode = process.argv[2] || 'audit'
if (!['audit', 'rehearse', 'apply'].includes(mode)) throw new Error('Expected audit, rehearse or apply')
const dump = execFileSync('supabase', ['db', 'dump', '--linked', '--dry-run'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const vars = {}
for (const match of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
const client = new pg.Client({ host: vars.PGHOST, port: Number(vars.PGPORT), user: vars.PGUSER, password: vars.PGPASSWORD, database: vars.PGDATABASE, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 })
const names = ['634_reconciliation_workspace', '635_literal_bank_rules_and_audit', '636_certified_receipt_matching_guards', '637_bank_workspace_credit_pagination', '638_sales_tracking_start_october', '639_exclude_ecommerce_sales_tracking']
try {
  await client.connect()
  await client.query('SET ROLE postgres')
  const installed = (await client.query("SELECT version,name FROM supabase_migrations.schema_migrations WHERE version IN ('634','635','636','637','638','639') ORDER BY version")).rows
  const counts = (await client.query(`SELECT
    count(*) FILTER(WHERE t.reconciliation_status='ignored') ignored,
    count(*) FILTER(WHERE t.reconciliation_status='ignored' AND t.classification_rule_id IS NULL) ignored_without_rule,
    count(*) FILTER(WHERE t.reconciliation_status='ignored' AND NOT COALESCE(r.is_active AND (r.bank_setting_id IS NULL OR r.bank_setting_id=t.bank_setting_id)
      AND strpos(lower(concat_ws(' ',t.transaction_type,t.channel,t.description)),lower(btrim(r.match_keyword)))>0,false)) invalid_classifications,
    count(*) FILTER(WHERE t.reconciliation_status='matched') matched
    FROM ac_bank_statement_transactions t LEFT JOIN ac_bank_transaction_rules r ON r.id=t.classification_rule_id`)).rows[0]
  console.log(JSON.stringify({ mode, installed, before: counts }))
  if (mode !== 'audit') {
    await client.query('BEGIN')
    try {
      await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='90s'")
      await client.query("SELECT pg_advisory_xact_lock(hashtext('reconciliation-workspace-migrations'))")
      const before = (await client.query('SELECT count(*) n,md5(string_agg(row_to_json(a)::TEXT,\',\' ORDER BY id)) fingerprint FROM ac_bank_reconciliation_allocations a')).rows[0]
      for (const name of names) {
        const version = name.split('_')[0]
        const already = (await client.query('SELECT name FROM supabase_migrations.schema_migrations WHERE version=$1', [version])).rows
        if (already.length) {
          if (already[0].name !== name.slice(4)) throw new Error(`Migration ${version} is occupied by another change`)
          continue
        }
        const source = await fs.readFile(`supabase/migrations/${name}.sql`, 'utf8')
        const sql = source.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')
        await client.query(sql)
        await client.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::TEXT[])', [version, name.slice(4), [sql]])
      }
      const after = (await client.query('SELECT count(*) n,md5(string_agg(row_to_json(a)::TEXT,\',\' ORDER BY id)) fingerprint FROM ac_bank_reconciliation_allocations a')).rows[0]
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Existing allocation rows changed; rolling back')
      const actor = (await client.query("SELECT id FROM us_users WHERE role='superadmin' ORDER BY id LIMIT 1")).rows[0]
      if (!actor) throw new Error('No superadmin available for RPC validation')
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor.id])
      const validation = (await client.query(`SELECT
        bank_sales_workspace(NULL,NULL,'all')->'summary' sales_summary,
        bank_sales_workspace(NULL,NULL,'all')->'states' sales_states,
        bank_statement_workspace()->'summary' bank_summary,
        bank_reconciliation_global_summary() global_summary,
        (SELECT count(*) FROM ac_bank_classification_audit) repaired_audit_rows`)).rows[0]
      if (mode === 'apply') await client.query('COMMIT')
      else await client.query('ROLLBACK')
      console.log(JSON.stringify({ mode, allocationsPreserved: true, validation, committed: mode === 'apply' }))
    } catch (error) { await client.query('ROLLBACK'); throw error }
  }
} catch (error) { console.error(error.message); process.exitCode = 1 }
finally { await client.end() }
