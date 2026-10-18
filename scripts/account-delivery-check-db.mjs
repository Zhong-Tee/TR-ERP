// Uses the project's linked Supabase connection without logging credentials.
// node scripts/account-delivery-check-db.mjs audit|rehearse|apply
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'

const mode = process.argv[2] || 'audit'
if (!['audit', 'rehearse', 'apply'].includes(mode)) throw new Error('Expected audit, rehearse or apply')
const dump = execFileSync('supabase', ['db', 'dump', '--linked', '--dry-run'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const vars = {}
for (const match of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
const client = new pg.Client({ host: vars.PGHOST, port: Number(vars.PGPORT), user: vars.PGUSER,
  password: vars.PGPASSWORD, database: vars.PGDATABASE, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 })
const name = '665_account_delivery_check_access'
const functionNames = ['tr_delivery_check_import', 'tr_delivery_check_find_previous_duplicates',
  'tr_delivery_check_delete_import', 'tr_delivery_check_rebuild_system_only',
  'tr_delivery_tracking_workspace', 'tr_delivery_check_review_row', 'tr_delivery_check_move_to_review']
const functions = async () => (await client.query(`SELECT p.proname,p.prosrc FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1) ORDER BY p.proname`, [functionNames])).rows
const fingerprint = async () => (await client.query(`SELECT
  (SELECT md5(coalesce(string_agg(row_to_json(r)::text,',' ORDER BY id),'')) FROM tr_delivery_check_rows r) rows,
  (SELECT md5(coalesce(string_agg(row_to_json(i)::text,',' ORDER BY id),'')) FROM tr_delivery_check_imports i) imports,
  (SELECT count(*) FROM or_orders) orders`)).rows[0]
try {
  await client.connect()
  await client.query('SET ROLE postgres')
  const installed = (await client.query("SELECT version,name FROM supabase_migrations.schema_migrations WHERE version='665'")).rows
  const beforeFunctions = await functions()
  console.log(JSON.stringify({ tablePrivileges: (await client.query(`SELECT current_user,
    has_table_privilege(current_user,'public.tr_delivery_check_rows','SELECT') own_read,
    has_table_privilege('authenticated','public.tr_delivery_check_rows','SELECT') authenticated_read,
    (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.tr_delivery_check_rows'::regclass) owner`)).rows }))
  assert.equal(beforeFunctions.length, 7, 'Expected exactly seven delivery functions')
  console.log(JSON.stringify({ mode, installed, functions: beforeFunctions.map(f => ({ name: f.proname, accountAllowed: f.prosrc.includes("'account'") })) }))
  if (mode !== 'audit') {
    await client.query('BEGIN')
    try {
      await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='90s'")
      await client.query("SELECT pg_advisory_xact_lock(hashtext('account-delivery-check-migration'))")
      const before = await fingerprint()
      console.log('Existing data fingerprint captured')
      const existing = (await client.query("SELECT name FROM supabase_migrations.schema_migrations WHERE version='665'")).rows
      if (existing.length && existing[0].name !== name.slice(4)) throw new Error('Migration 665 is occupied by another change')
      if (!existing.length) {
        const sql = (await fs.readFile(`supabase/migrations/${name}.sql`, 'utf8')).replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')
        await client.query(sql)
        console.log('Migration executed in transaction')
        // Fail closed if the deployed functions contain logic absent from this checkout.
        const afterFunctions = await functions()
        const normalize = body => body.replace(/\r\n/g, '\n').replace(/'packing_staff', 'account'/g, "'packing_staff'").replace(/\s+/g, ' ').trim()
        for (let i = 0; i < beforeFunctions.length; i++) {
          assert.equal(normalize(afterFunctions[i].prosrc), normalize(beforeFunctions[i].prosrc), `Unexpected logic change in ${beforeFunctions[i].proname}`)
        }
        await client.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[])', ['665', name.slice(4), [sql]])
      }
      assert.deepEqual(await fingerprint(), before, 'Existing delivery data changed')
      console.log('Function logic and existing data preserved')
      const actor = (await client.query("SELECT id FROM us_users WHERE role='account' ORDER BY id LIMIT 1")).rows[0]
      if (!actor) throw new Error('No Account user available for validation')
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor.id])
      await client.query("SET LOCAL ROLE authenticated")
      console.log('Validating authenticated Account access')
      const validation = (await client.query(`SELECT
        tr_delivery_tracking_workspace()->'count' bill_count,
        (SELECT count(*) FROM tr_delivery_check_imports) imports,
        (SELECT count(*) FROM tr_delivery_check_rows) rows,
        (SELECT count(*) FROM tr_delivery_check_find_previous_duplicates(ARRAY[]::text[])) duplicates,
        (SELECT has_access FROM st_user_menus WHERE role='account' AND menu_key='transport') menu_access`)).rows[0]
      assert.equal(validation.menu_access, true)
      await client.query('SET LOCAL ROLE postgres')
      assert.deepEqual(await fingerprint(), before, 'Validation changed existing delivery data')
      if (mode === 'apply') await client.query('COMMIT')
      else await client.query('ROLLBACK')
      console.log(JSON.stringify({ mode, validation, existingDataPreserved: true, committed: mode === 'apply' }))
    } catch (error) { await client.query('ROLLBACK'); throw error }
  }
} catch (error) { console.error(error.message, error.where || ''); process.exitCode = 1 }
finally { await client.end() }
