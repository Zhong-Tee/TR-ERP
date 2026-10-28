// Isolated PostgreSQL tests; no live connection or customer data.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'

const db = new PGlite()
const oldMigration = await fs.readFile('supabase/migrations/597_prebill_sales_tr_team_cancel_audit.sql', 'utf8')
const originalHelper = oldMigration.slice(oldMigration.indexOf('CREATE OR REPLACE FUNCTION public.can_manage_prebill_document'), oldMigration.indexOf('DROP POLICY IF EXISTS prebill_documents_select'))
const patch = await fs.readFile('supabase/migrations/677_prebill_set_based_rls.sql', 'utf8')
const uuid = number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`
const roles = ['superadmin', 'sales-tr', 'sales-tr', 'sales-pump', 'sales-pump', 'admin', 'account', 'production']
await db.exec(`
CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
CREATE TABLE us_users(id uuid PRIMARY KEY,role text,is_active boolean DEFAULT true);
CREATE TABLE or_prebill_documents(id uuid PRIMARY KEY,owner_id uuid,document_type text DEFAULT 'production_confirmation',status text DEFAULT 'active',note text);
CREATE TABLE or_prebill_items(id uuid PRIMARY KEY,document_id uuid REFERENCES or_prebill_documents(id),product_name text);
GRANT SELECT,INSERT,UPDATE,DELETE ON or_prebill_documents,or_prebill_items TO authenticated;
ALTER TABLE or_prebill_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE or_prebill_items ENABLE ROW LEVEL SECURITY;
`)
await db.exec(originalHelper)
await db.exec(`
CREATE POLICY prebill_documents_select ON or_prebill_documents FOR SELECT TO authenticated USING(can_manage_prebill_document(owner_id));
CREATE POLICY prebill_documents_update ON or_prebill_documents FOR UPDATE TO authenticated USING(can_manage_prebill_document(owner_id)) WITH CHECK(can_manage_prebill_document(owner_id));
CREATE POLICY prebill_items_select ON or_prebill_items FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM or_prebill_documents d WHERE d.id=document_id));
CREATE POLICY prebill_items_write ON or_prebill_items FOR ALL TO authenticated USING(EXISTS(SELECT 1 FROM or_prebill_documents d WHERE d.id=document_id AND can_manage_prebill_document(d.owner_id))) WITH CHECK(EXISTS(SELECT 1 FROM or_prebill_documents d WHERE d.id=document_id AND can_manage_prebill_document(d.owner_id)));
`)
for (const [index, role] of roles.entries()) {
  await db.query('INSERT INTO us_users(id,role,is_active) VALUES($1,$2,$3)', [uuid(index + 1), role, index !== 2])
}
for (let i = 1; i <= 10; i++) {
  // Include an orphan owner and NULL owner; neither may become accessible.
  await db.query('INSERT INTO or_prebill_documents(id,owner_id) VALUES($1,$2)', [uuid(100+i), i === 10 ? null : uuid(i)])
  await db.query('INSERT INTO or_prebill_items VALUES($1,$2,$3)', [uuid(200+i), uuid(100+i), 'Product'])
}
const actor = async id => {
  await db.exec('RESET ROLE')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [id || ''])
  await db.exec('SET ROLE authenticated')
}
const visible = async () => ({
  documents: (await db.query('SELECT id FROM or_prebill_documents ORDER BY id')).rows.map(row => row.id),
  items: (await db.query('SELECT id FROM or_prebill_items ORDER BY id')).rows.map(row => row.id),
})
const identities = [...roles.map((_, index) => uuid(index+1)), uuid(99), null]
const before = []
for (const id of identities) { await actor(id); before.push(await visible()) }
await db.exec('RESET ROLE')
await db.exec(patch)
await db.exec(patch) // Reapplying does not change semantics or grants.
let passed = 0
for (const [index, id] of identities.entries()) {
  await actor(id)
  assert.deepEqual(await visible(), before[index], `Visibility changed for ${roles[index] || 'missing actor'}`)
  const owners = (await db.query('SELECT public.prebill_accessible_owner_ids() id')).rows.map(row => row.id).sort()
  await db.exec('RESET ROLE')
  const expected = (await db.query('SELECT id FROM us_users WHERE can_manage_prebill_document(id) ORDER BY id')).rows.map(row => row.id)
  assert.deepEqual(owners, expected)
  console.log(`PASS unchanged document/item scope: ${roles[index] || 'missing actor'}`)
  passed++
}
await actor(uuid(2))
const sameTeam = await db.query("UPDATE or_prebill_documents SET note='team edit' WHERE id=$1 RETURNING id", [uuid(103)])
assert.equal(sameTeam.rows.length, 1)
const foreignDoc = await db.query("UPDATE or_prebill_documents SET note='forbidden' WHERE id=$1 RETURNING id", [uuid(104)])
assert.equal(foreignDoc.rows.length, 0)
await assert.rejects(() => db.query('UPDATE or_prebill_documents SET owner_id=$1 WHERE id=$2', [uuid(4), uuid(102)]), /row-level security/)
await assert.rejects(() => db.query('INSERT INTO or_prebill_items VALUES($1,$2,$3)', [uuid(999), uuid(104), 'forbidden']), /row-level security/)
await assert.rejects(() => db.query('UPDATE or_prebill_items SET document_id=$1 WHERE id=$2', [uuid(104), uuid(202)]), /row-level security/)
assert.equal((await db.query("UPDATE or_prebill_items SET product_name='team edit' WHERE id=$1 RETURNING id", [uuid(203)])).rows.length, 1)
assert.equal((await db.query('DELETE FROM or_prebill_items WHERE id=$1 RETURNING id', [uuid(204)])).rows.length, 0)
assert.equal((await db.query('DELETE FROM or_prebill_items WHERE id=$1 RETURNING id', [uuid(203)])).rows.length, 1)
passed++
console.log('PASS team writes remain allowed; cross-owner insert/update/delete and ownership reassignment remain denied')
const plan = (await db.query('EXPLAIN (FORMAT JSON) SELECT * FROM or_prebill_documents')).rows[0]['QUERY PLAN']
assert.ok(JSON.stringify(plan).includes('hashed'))
assert.ok(!JSON.stringify(plan).includes('can_manage_prebill_document'))
passed++
console.log('PASS document scope uses a hashed subplan instead of a per-row helper')
await db.exec('RESET ROLE; SET ROLE anon')
await assert.rejects(() => db.query('SELECT public.prebill_accessible_owner_ids()'), /permission denied/)
passed++
console.log('PASS anon cannot execute the scope helper')
await db.close()
console.log(`${passed} checks passed`)
