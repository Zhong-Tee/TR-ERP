import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import pg from '../../.reservation-test-runtime/node_modules/pg/lib/index.js'

/** Explicitly privileged maintenance connection. Never log connection details. */
export async function connectHrRepairDatabase() {
  let dump
  try {
    dump = execFileSync('supabase', ['db', 'dump', '--linked', '--dry-run'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000,
    })
  } catch {
    throw new Error('Supabase CLI login/linked connection unavailable; credentials were not logged')
  }
  const vars = {}
  for (const match of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
  assert.ok(vars.PGHOST && vars.PGPASSWORD, 'Linked connection unavailable')
  const ref = (await fs.readFile('supabase/.temp/project-ref', 'utf8')).trim()
  assert.ok((await fs.readFile('.env', 'utf8')).includes(`${ref}.supabase.co`), 'App/linked project mismatch')
  assert.ok(vars.PGHOST.includes(ref) || vars.PGUSER.includes(ref), 'Unexpected database target')
  pg.types.setTypeParser(1082, value => value)
  const db = new pg.Client({ host: vars.PGHOST, port: Number(vars.PGPORT), user: vars.PGUSER,
    password: vars.PGPASSWORD, database: vars.PGDATABASE, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 })
  await db.connect()
  try { await db.query('SET ROLE postgres') } catch (error) { await db.end(); throw error }
  return db
}
