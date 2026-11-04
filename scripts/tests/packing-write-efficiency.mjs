// Isolated PostgreSQL tests: no connection to Supabase or live stock.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'
const read = p => fs.readFile(new URL('../../' + p, import.meta.url), 'utf8')
const db = new PGlite()
let checks = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++ }
const denied = async (fn, pattern) => { await assert.rejects(fn, pattern); checks++ }
const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const first = '00000000-0000-0000-0000-000000000001'
const second = '00000000-0000-0000-0000-000000000002'
const hidden = '00000000-0000-0000-0000-000000000003'
await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE TABLE or_orders(id uuid PRIMARY KEY, owner_id uuid, packing_meta jsonb, status text DEFAULT 'ใบสั่งงาน', updated_at timestamptz DEFAULT now());
CREATE TABLE plan_jobs(id text PRIMARY KEY, tracks jsonb DEFAULT '{}', owner_id uuid);
CREATE TABLE writes(kind text);
CREATE FUNCTION record_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO writes VALUES(TG_TABLE_NAME); RETURN NEW; END $$;
CREATE TRIGGER plan_write AFTER UPDATE ON plan_jobs FOR EACH ROW EXECUTE FUNCTION record_write();
CREATE TRIGGER order_write AFTER UPDATE ON or_orders FOR EACH ROW EXECUTE FUNCTION record_write();
GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;
GRANT SELECT,UPDATE ON or_orders,plan_jobs TO authenticated;
GRANT INSERT,SELECT ON writes TO authenticated;
ALTER TABLE or_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY order_own ON or_orders TO authenticated USING(owner_id=auth.uid()) WITH CHECK(owner_id=auth.uid());
CREATE POLICY plan_own ON plan_jobs TO authenticated USING(owner_id=auth.uid()) WITH CHECK(owner_id=auth.uid());
INSERT INTO or_orders VALUES('${first}','${a}','{"parcelScanned":true,"scanTime":"old","other":{"keep":1}}','ใบสั่งงาน',now()),
('${second}','${a}',NULL,'ใบสั่งงาน',now()),('${hidden}','${b}',NULL,'ใบสั่งงาน',now());
INSERT INTO plan_jobs VALUES('job','{}','${a}'),('hidden','{}','${b}');`)
// Apply the actual original routine first, then verify migration reapplication.
const original = await read('supabase/legacy-migrations/pre-baseline-20261104/086_rpc_merge_plan_tracks.sql')
await db.exec(original.slice(original.indexOf('CREATE OR REPLACE FUNCTION merge_plan_tracks('), original.indexOf('-- Name-based variant')))
const migration = await read('supabase/legacy-migrations/pre-baseline-20261104/692_packing_write_efficiency.sql')
await db.exec(migration)
await db.exec(migration)
await db.exec(`SET request.jwt.claim.sub='${a}'; SET ROLE authenticated`)
const tags = async payload => (await db.query('SELECT rpc_assign_packing_tags($1::jsonb) result', [JSON.stringify(payload)])).rows[0].result
const order = async id => (await db.query('SELECT packing_meta FROM or_orders WHERE id=$1', [id])).rows[0]?.packing_meta
check(await tags([]), {})
check(await tags([{order_id:first, tag:12},{order_id:second, tag:13}]), {[first]:12,[second]:13})
check(await order(first), {parcelScanned:true, scanTime:'old', other:{keep:1}, dailyPackingTag:12})
check(await order(second), {dailyPackingTag:13})
check((await db.query("SELECT count(*)::int n FROM writes WHERE kind='or_orders'")).rows[0].n, 2)
// A stale second station proposes new tags after the first commit. The stored
// tags must win, and retries must emit no additional UPDATE/Realtime event.
check(await tags([{order_id:first,tag:99},{order_id:second,tag:100}]), {[first]:12,[second]:13})
check((await db.query("SELECT count(*)::int n FROM writes WHERE kind='or_orders'")).rows[0].n, 2)
await db.exec(`UPDATE or_orders SET packing_meta=jsonb_set(packing_meta,'{parcelScanned}','false') WHERE id='${first}'`)
await tags([{order_id:first,tag:88}])
check((await order(first)).parcelScanned, false)
check((await order(first)).dailyPackingTag, 12)
await denied(() => tags([{order_id:hidden,tag:1}]), /unavailable/)
for (const value of [null, {}, [{order_id:first,tag:null}], [{order_id:first,tag:'1'}],
  [{order_id:first,tag:0}], [{order_id:first,tag:1.5}], [{order_id:first,tag:9007199254740992}],
  [{order_id:first,tag:1},{order_id:first,tag:2}], [{order_id:'invalid',tag:1}],
  Array.from({length:501}, () => ({order_id:first,tag:1}))]) {
  await denied(() => tags(value), /array|Invalid|duplicate|uuid|500/)
}
// An allowed write before an inaccessible row must roll back with the batch.
await db.exec(`UPDATE or_orders SET packing_meta=NULL WHERE id='${first}'`)
await denied(() => tags([{order_id:first,tag:25},{order_id:hidden,tag:26}]), /unavailable/)
check(await order(first), null)
// SELECT allowed, UPDATE denied is also rejected, rather than returning a fake tag.
await db.exec(`RESET ROLE; DROP POLICY order_own ON or_orders;
CREATE POLICY order_read ON or_orders FOR SELECT TO authenticated USING(owner_id=auth.uid());
CREATE POLICY order_update ON or_orders FOR UPDATE TO authenticated USING(false);
SET ROLE authenticated`)
await denied(() => tags([{order_id:first,tag:25}]), /Cannot update|row-level security|unavailable/)
check(await order(first), null)

const merge = async patch => (await db.query("SELECT merge_plan_tracks('job','PACK',$1::jsonb) result", [JSON.stringify(patch)])).rows[0].result
const start = '2026-11-02T05:00:00Z'
check(await merge({'เริ่มแพ็ค':{start_if_null:start}}), {PACK:{'เริ่มแพ็ค':{start,end:null}}})
await merge({'เริ่มแพ็ค':{start_if_null:'2099-01-01'}})
check((await db.query("SELECT count(*)::int n FROM writes WHERE kind='plan_jobs'")).rows[0].n, 1)
await merge({'เริ่มแพ็ค':{end:'finish'}})
check((await merge({'เริ่มแพ็ค':{end:'finish'}})).PACK['เริ่มแพ็ค'], {start,end:'finish'})
check((await db.query("SELECT count(*)::int n FROM writes WHERE kind='plan_jobs'")).rows[0].n, 2)
await merge({'เริ่มแพ็ค':{start:null,end:null}})
check((await merge({'เริ่มแพ็ค':{start_if_null:'restart'}})).PACK['เริ่มแพ็ค'], {start:'restart',end:null})
check((await db.query("SELECT merge_plan_tracks('hidden','PACK','{}') result")).rows[0].result, null)
await db.exec('RESET ROLE; SET ROLE anon')
await denied(() => tags([]), /permission denied/)
await db.exec('RESET ROLE')
const properties = (await db.query("SELECT prosecdef,proconfig FROM pg_proc WHERE proname='rpc_assign_packing_tags'")).rows[0]
check(properties.prosecdef, false)
check(properties.proconfig, ['search_path=public, pg_temp'])
check((await db.query(`SELECT packing_meta FROM or_orders WHERE id='${hidden}'`)).rows[0].packing_meta, null)
console.log(`PASS ${checks} phase 3 packing/Plan SQL checks (isolated PostgreSQL)`)
await db.close()
