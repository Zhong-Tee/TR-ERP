import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'

// One-time, explicitly requested release of the two abandoned legacy film reservations.
const codes = ['990000166', '990000167']
const reason = 'ผู้ใช้ยืนยันไม่ต้องการเบิกต่อ: ใบ REQ-20260903-001 เป็นรายการเก่าช่วงเริ่มใช้ ERP ที่มีบั๊ก ขอปลดยอดจองฟิล์มสองรายการเป็น 0'
const dump = execFileSync('supabase', ['db', 'dump', '--linked', '--dry-run'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const vars = {}
for (const m of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
const client = new pg.Client({ host: vars.PGHOST, port: Number(vars.PGPORT), user: vars.PGUSER, password: vars.PGPASSWORD, database: vars.PGDATABASE, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 })
try {
  await client.connect()
  await client.query('SET ROLE postgres')
  await client.query('BEGIN')
  await client.query("SET LOCAL lock_timeout='10s'")
  await client.query("SET LOCAL statement_timeout='60s'")
  const products = (await client.query('SELECT id,product_code FROM pr_products WHERE product_code=ANY($1::text[]) ORDER BY id FOR UPDATE', [codes])).rows
  if (products.length !== 2) throw Error('Expected exactly two film products')
  const ids = products.map(p => p.id)
  await client.query('SELECT id FROM wms_orders WHERE product_code=ANY($1::text[]) ORDER BY id FOR UPDATE', [codes])
  await client.query('SELECT product_id FROM inv_stock_balances WHERE product_id=ANY($1::uuid[]) ORDER BY product_id FOR UPDATE', [ids])
  const audit = (await client.query('SELECT * FROM fn_reservation_audit($1::uuid[])', [ids])).rows
  if (audit.length !== 2 || audit.some(r => Number(r.reserved) !== 3 || Number(r.linked_reserved) !== 0 || Number(r.uncertain_count) !== 0)) throw Error('Reservation snapshot changed or active reservations exist; abort')
  for (const row of audit) {
    const wms = row.evidence.wms
    if (!Array.isArray(wms) || wms.length !== 1 || wms[0].work_order !== 'REQ-20260903-001' || wms[0].status !== 'out_of_stock' || Number(wms[0].qty) !== 3 || Number(wms[0].net_deducted) !== 0) throw Error('Unexpected WMS evidence; abort')
  }
  const physical = async () => (await client.query('SELECT product_id,on_hand,safety_stock,(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),\'[]\'::jsonb) FROM inv_stock_lots l WHERE l.product_id=b.product_id) AS lots FROM inv_stock_balances b WHERE product_id=ANY($1::uuid[]) ORDER BY product_id', [ids])).rows
  const before = await physical()
  const batch = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id
  for (const row of audit) {
    await client.query('INSERT INTO inv_reservation_reconciliations(batch_id,product_id,old_reserved,new_reserved,reason,evidence) VALUES($1,$2,$3,0,$4,$5::jsonb)', [batch, row.product_id, row.reserved, reason, JSON.stringify({ ...row.evidence, release_authority: 'explicit_user_request', reviewed_audit: row })])
  }
  const changed = (await client.query('UPDATE inv_stock_balances SET reserved=0,updated_at=now() WHERE product_id=ANY($1::uuid[]) AND reserved=3 RETURNING product_id,reserved,on_hand', [ids])).rows
  if (changed.length !== 2) throw Error('Expected two releases; abort')
  const after = await physical()
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Physical stock or lots changed; abort')
  const verification = (await client.query('SELECT product_code,reserved,linked_reserved,difference FROM fn_reservation_audit($1::uuid[])', [ids])).rows
  if (verification.some(r => Number(r.reserved) !== 0 || Number(r.difference) !== 0)) throw Error('Verification failed; abort')
  await fs.writeFile('reports/legacy-film-reservation-release-2026-10-08.json', JSON.stringify({ batch_id: batch, reason, before: audit, after: verification, physicalUnchanged: true }, null, 2))
  await client.query('COMMIT')
  console.log(JSON.stringify({ batch_id: batch, after: verification, physicalUnchanged: true }))
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  console.error(error.message)
  process.exitCode = 1
} finally {
  await client.end()
}
