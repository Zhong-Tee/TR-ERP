// Isolated PostgreSQL integration fixture; never connects to the live database.
// Setup: npm install --prefix .reservation-test-runtime --no-save --package-lock=false @electric-sql/pglite@0.5.8
// Run: node scripts/tests/document-stock-reservations.mjs
// pg_cron is stubbed; the FIFO consumer and reconciler are the real migration 504 routines.
process.on('uncaughtException', e => { console.error(e.message, e.detail || '', e.where || '', e.position, (e.query || '').slice(Math.max(0, Number(e.position)-200),Number(e.position)+100)); process.exit(1) })
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'
const db = new PGlite()
const read = p => fs.readFile(new URL('../../'+p,import.meta.url),'utf8')
const table = (s,name) => s.match(new RegExp('CREATE TABLE IF NOT EXISTS '+name+' \\([\\s\\S]*?\\n\\);'))[0].replaceAll('uuid_generate_v4()','gen_random_uuid()')
await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid $$;
CREATE FUNCTION public.check_user_role(uuid,text[]) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION public.can_manage_prebill_document(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TABLE us_users(id uuid PRIMARY KEY,username text,email text); INSERT INTO us_users VALUES(auth.uid(),'tester','test');
CREATE TABLE channels(channel_code text PRIMARY KEY); INSERT INTO channels VALUES('TR');
ALTER TABLE us_users ADD role text DEFAULT 'superadmin'; CREATE TABLE st_user_menus(role text,menu_key text,has_access boolean);
CREATE TABLE pr_products(id uuid PRIMARY KEY,product_code text,product_name text,unit_name text);
CREATE SCHEMA cron; CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;`)
const initial = await read('supabase/migrations/001_initial_schema.sql')
await db.exec(table(initial,'or_orders')+';'+table(initial,'or_order_items'))
await db.exec(`ALTER TABLE or_orders ADD source_prebill_document_id uuid,ADD claim_shipping_confirmed_at timestamptz;
ALTER TABLE or_order_items ADD is_detail_row boolean DEFAULT false,ADD parent_item_id uuid,ADD cancellation_stock_action text,ADD unit_price numeric,ADD no_name_line boolean DEFAULT false,ADD is_free boolean DEFAULT false,ADD attachment_name text;
CREATE TABLE inv_stock_balances(id uuid DEFAULT gen_random_uuid(),product_id uuid PRIMARY KEY,on_hand numeric DEFAULT 0,reserved numeric DEFAULT 0,safety_stock numeric DEFAULT 0,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE inv_stock_movements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_id uuid,movement_type text,qty numeric,ref_type text,ref_id uuid,note text);
CREATE TABLE wms_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_code text,product_name text,qty numeric,status text,unit_name text,source_order_id uuid,source_order_item_id uuid,order_id text,status_before_cancel text,stock_action text);
CREATE TABLE wms_borrow_requisitions(id uuid PRIMARY KEY,borrow_no text,status text,due_date date,created_by uuid);
CREATE TABLE wms_borrow_requisition_items(id uuid PRIMARY KEY,borrow_requisition_id uuid,product_id uuid,qty numeric,returned_qty numeric,written_off_qty numeric);
CREATE TABLE fifo_test_consumption(product_id uuid,qty numeric,movement_id uuid);
CREATE FUNCTION fn_reconcile_sellable_lots_to_on_hand(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION fn_consume_stock_fifo(uuid,numeric,uuid) RETURNS void LANGUAGE sql AS $$ INSERT INTO fifo_test_consumption VALUES($1,$2,$3) $$;
CREATE FUNCTION fn_recalc_product_landed_cost(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION fn_reverse_wms_stock(uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT 0::numeric $$;
CREATE FUNCTION inv_deduct_stock_on_wms_picked() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER trg_inv_deduct_wms_picked AFTER UPDATE OF status ON wms_orders FOR EACH ROW EXECUTE FUNCTION inv_deduct_stock_on_wms_picked();
CREATE FUNCTION fn_guard_or_order_items_stock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER trg_guard_or_order_items_stock BEFORE INSERT OR UPDATE OF product_id,quantity ON or_order_items FOR EACH ROW EXECUTE FUNCTION fn_guard_or_order_items_stock();`)
const fifoTables=await read('supabase/migrations/099_fifo_stock_lots.sql')
await db.exec(table(fifoTables,'inv_stock_lots')+';'+table(fifoTables,'inv_lot_consumptions'))
await db.exec(`ALTER TABLE inv_stock_lots ADD is_safety_stock boolean DEFAULT false;
ALTER TABLE inv_stock_movements ADD unit_cost numeric,ADD total_cost numeric;
ALTER TABLE pr_products ADD landed_cost numeric DEFAULT 10;
DROP FUNCTION fn_consume_stock_fifo(uuid,numeric,uuid); DROP FUNCTION fn_reconcile_sellable_lots_to_on_hand(uuid);`)
const fifoSql=await read('supabase/migrations/504_reconcile_fifo_lots_before_wms_deduction.sql')
for(const name of ['fn_consume_stock_fifo','fn_reconcile_sellable_lots_to_on_hand']) {
  const start=fifoSql.indexOf('CREATE OR REPLACE FUNCTION public.'+name+'(')
  await db.exec(fifoSql.slice(start,fifoSql.indexOf('$$;',start)+3))
}
const pre = await read('supabase/migrations/576_prebill_qt_pc_documents.sql')
await db.exec(table(pre,'public.or_prebill_documents')+';'+table(pre,'public.or_prebill_items'))
// Use the actual latest prebill mutation guards as well as the RLS-backed RPCs.
const preGuardSql=await read('supabase/migrations/597_prebill_sales_tr_team_cancel_audit.sql')
for(const name of ['guard_prebill_document_update','guard_prebill_item_write']) {
  const start=preGuardSql.indexOf('CREATE OR REPLACE FUNCTION public.'+name+'(')
  await db.exec(preGuardSql.slice(start,preGuardSql.indexOf('$$;',start)+3))
}
await db.exec(`CREATE TRIGGER trg_guard_prebill_document_update BEFORE INSERT OR UPDATE ON or_prebill_documents FOR EACH ROW EXECUTE FUNCTION guard_prebill_document_update();
CREATE TRIGGER trg_guard_prebill_item_write BEFORE INSERT OR UPDATE OR DELETE ON or_prebill_items FOR EACH ROW EXECUTE FUNCTION guard_prebill_item_write();`)
let migration=await read('supabase/migrations/625_document_stock_reservations.sql')
migration=migration.replace('CREATE EXTENSION IF NOT EXISTS pg_cron;','-- pg_cron stubbed in embedded test only')
await db.exec(`INSERT INTO or_orders(id,channel_code,bill_no,customer_name,customer_address,admin_user) VALUES('88888888-8888-8888-8888-888888888888','TR','LEGACY-1','Old','','tester');`)
await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated,anon; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated,anon;')
await db.exec(migration)
await db.exec(await read('supabase/migrations/627_sales_draft_no_reservation.sql'))
await db.exec(`ALTER TABLE or_orders ALTER COLUMN status SET DEFAULT 'ข้อมูลครบ'`)
await db.exec(await read('supabase/migrations/632_stable_bill_item_order.sql'))
const orderId='88888888-8888-8888-8888-888888888888'
const a='11111111-1111-4111-8111-111111111111', b='22222222-2222-4222-8222-222222222222', c='33333333-3333-4333-8333-333333333333'
const save = async items => db.query('SELECT rpc_save_order_items($1,$2::jsonb)',[orderId,JSON.stringify(items.map(x=>({product_name:'Test',...x})))])
const rows = async () => (await db.query('SELECT id,item_uid,sort_order,line_1 FROM or_order_items WHERE order_id=$1 ORDER BY sort_order',[orderId])).rows
await save([{id:a,item_uid:'LEGACY-1-1',line_1:'first',quantity:1},{id:b,item_uid:'LEGACY-1-2',line_1:'second',quantity:1}])
assert.deepEqual((await rows()).map(x=>x.item_uid),['LEGACY-1-1','LEGACY-1-2'])
await save([{id:b,item_uid:'LEGACY-1-1',line_1:'edited',quantity:1},{id:a,item_uid:'LEGACY-1-2',quantity:1}])
assert.deepEqual((await rows()).map(x=>x.item_uid),['LEGACY-1-2','LEGACY-1-1'])
assert.equal((await rows())[0].line_1,'edited')
await save([{id:a,item_uid:'LEGACY-1-1',quantity:1},{id:c,item_uid:'LEGACY-1-2',quantity:1}])
assert.deepEqual((await rows()).map(x=>x.item_uid),['LEGACY-1-1','LEGACY-1-3'])
assert.deepEqual((await rows()).map(x=>x.sort_order),[1,2])
await save([{id:a,quantity:1}])
await save([{id:a,quantity:1},{id:b,quantity:1}])
assert.deepEqual((await rows()).map(x=>x.item_uid),['LEGACY-1-1','LEGACY-1-4'])
await db.exec('UPDATE or_order_items SET sort_order=NULL')
await db.exec(await read('supabase/migrations/632_stable_bill_item_order.sql'))
assert.deepEqual((await rows()).map(x=>x.item_uid),['LEGACY-1-1','LEGACY-1-4'])
assert.deepEqual((await rows()).map(x=>x.sort_order),[1,2])
await db.close()
console.log('Passed: stable UID during edits, persisted order, new UID after deletion without collision')
