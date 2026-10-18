// Apply only migration 666; do not push unrelated pending migrations.
// node scripts/superadmin-product-import-db.mjs rehearse|apply
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'
const mode = process.argv[2] || 'rehearse'
if (!['rehearse','apply'].includes(mode)) throw new Error('Expected rehearse or apply')
let client
try {
  const dump = execFileSync('supabase',['db','dump','--linked','--dry-run'],{encoding:'utf8',stdio:['ignore','pipe','pipe']})
  const vars = {}
  for (const m of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[m[1]] = m[2].trim().replace(/^['"]|['"]$/g,'')
  client = new pg.Client({host:vars.PGHOST,port:Number(vars.PGPORT),user:vars.PGUSER,password:vars.PGPASSWORD,
    database:vars.PGDATABASE,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000})
  await client.connect()
  await client.query('SET ROLE postgres')
  await client.query('BEGIN')
  await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'")
  await client.query("SELECT pg_advisory_xact_lock(hashtext('superadmin-product-import-migration'))")
  const existing = (await client.query("SELECT name FROM supabase_migrations.schema_migrations WHERE version='666'")).rows
  if (existing.length) {
    if (existing[0].name !== 'superadmin_product_import') throw new Error('Migration 666 is occupied by another change')
    console.log('Migration 666 is already installed')
  } else {
    const sql = (await readFile(new URL('../supabase/migrations/666_superadmin_product_import.sql',import.meta.url),'utf8')).replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'')
    await client.query(sql)
    await client.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[])',['666','superadmin_product_import',[sql]])
  }
  await client.query(mode==='apply'?'COMMIT':'ROLLBACK')
  console.log(mode==='apply'?'Migration 666 committed':'Migration 666 rehearsed and rolled back')
} catch (error) {
  await client?.query('ROLLBACK').catch(()=>{})
  // CLI stdout may contain connection credentials. Only expose its stderr.
  console.error(error.stderr ? String(error.stderr).trim() : error.message)
  process.exitCode = 1
} finally { await client?.end() }
