// Uses the existing Supabase CLI linked connection. Never prints connection credentials.
// node scripts/delivery-tracking-workspace-db.mjs audit|rehearse|apply
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'
const mode = process.argv[2] || 'audit'
if (!['audit', 'rehearse', 'apply'].includes(mode)) throw new Error('Expected audit, rehearse or apply')
const dump = execFileSync('supabase', ['db', 'dump', '--linked', '--dry-run'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const vars = {}
for (const match of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
const client = new pg.Client({ host: vars.PGHOST, port: Number(vars.PGPORT), user: vars.PGUSER, password: vars.PGPASSWORD, database: vars.PGDATABASE, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 })
const names = ['640_delivery_tracking_workspace', '641_exclude_ecommerce_pickup_delivery_tracking']
try {
  await client.connect()
  await client.query('SET ROLE postgres')
  const installed = (await client.query("SELECT version,name FROM supabase_migrations.schema_migrations WHERE version IN ('640','641') ORDER BY version")).rows
  console.log(JSON.stringify({ mode, installed }))
  if (mode === 'audit') {
    const statuses = (await client.query(`SELECT raw_data->>'สถานะงานรับ' pickup_status,count(*) n FROM tr_delivery_check_rows WHERE source_kind='carrier' GROUP BY 1 ORDER BY n DESC`)).rows
    const rawKeys = (await client.query(`SELECT key,count(*) n FROM tr_delivery_check_rows r CROSS JOIN LATERAL jsonb_object_keys(r.raw_data) key WHERE source_kind='carrier' GROUP BY key ORDER BY n DESC LIMIT 25`)).rows
    console.log(JSON.stringify({ statuses, rawKeys }))
  }
  if (mode !== 'audit') {
    await client.query('BEGIN')
    try {
      await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='90s'")
      await client.query("SELECT pg_advisory_xact_lock(hashtext('delivery-tracking-workspace-migrations'))")
      const before = (await client.query('SELECT (SELECT count(*) FROM or_orders) orders,(SELECT count(*) FROM tr_delivery_check_rows) carrier_rows,md5(string_agg(row_to_json(a)::TEXT,\',\' ORDER BY id)) fingerprint FROM tr_delivery_check_rows a')).rows[0]
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
      const after = (await client.query('SELECT (SELECT count(*) FROM or_orders) orders,(SELECT count(*) FROM tr_delivery_check_rows) carrier_rows,md5(string_agg(row_to_json(a)::TEXT,\',\' ORDER BY id)) fingerprint FROM tr_delivery_check_rows a')).rows[0]
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Existing delivery rows or orders changed; rolling back')
      const actor = (await client.query("SELECT id FROM us_users WHERE role='superadmin' ORDER BY id LIMIT 1")).rows[0]
      if (!actor) throw new Error('No superadmin available for RPC validation')
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor.id])
      const started = Date.now()
      const validation = (await client.query(`SELECT
        tr_delivery_tracking_workspace()->'summary' summary,
        tr_delivery_tracking_workspace()->'count' count,
        jsonb_array_length(tr_delivery_tracking_workspace()->'rows') page_rows,
        (SELECT count(*) FROM tr_delivery_check_imports) imports`)).rows[0]
      validation.durationMs = Date.now()-started
      if (mode === 'apply') await client.query('COMMIT')
      else await client.query('ROLLBACK')
      console.log(JSON.stringify({ mode, existingOrdersAndCarrierRowsPreserved: true, validation, committed: mode === 'apply' }))
    } catch (error) { await client.query('ROLLBACK'); throw error }
  }
} catch (error) { console.error(error.message); process.exitCode = 1 }
finally { await client.end() }
