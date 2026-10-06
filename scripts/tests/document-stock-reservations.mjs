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
console.log('Migration compiles on PostgreSQL')
const product='11111111-1111-1111-1111-111111111111'
const order='22222222-2222-2222-2222-222222222222'
const item='33333333-3333-3333-3333-333333333333'
await db.exec(`INSERT INTO pr_products(id,product_code,product_name,unit_name) VALUES('${product}','P1','Product','กล่อง'); INSERT INTO inv_stock_balances(product_id,on_hand,reserved,safety_stock) VALUES('${product}',100,7,20);`)
await db.exec(`INSERT INTO inv_stock_lots(product_id,qty_initial,qty_remaining,unit_cost,created_at,is_safety_stock) VALUES
('${product}',10,10,5,'2020-01-01',false),('${product}',90,90,10,'2021-01-01',false),('${product}',20,20,99,'2019-01-01',true);`)
const lotQty=async(safety=false)=>Number((await db.query(`SELECT sum(qty_remaining) AS qty FROM inv_stock_lots WHERE is_safety_stock=${safety}`)).rows[0].qty)
const balance=async()=> (await db.query(`SELECT on_hand,reserved,safety_stock FROM inv_stock_balances WHERE product_id='${product}'`)).rows[0]
await db.exec(`INSERT INTO or_orders(id,channel_code,bill_no,customer_name,customer_address,admin_user) VALUES('${order}','TR','TR-1','Customer','','tester');
INSERT INTO or_order_items(id,order_id,item_uid,product_id,product_name,quantity) VALUES('${item}','${order}','TR-1-1','${product}','Product',30);`)
assert.equal((await balance()).reserved,'37')
assert.equal(await lotQty(),100)
assert.equal(await lotQty(true),20)
assert.equal((await db.query("SELECT stock_reservation_enabled FROM or_orders WHERE bill_no='LEGACY-1'")).rows[0].stock_reservation_enabled,false)
await assert.rejects(()=>db.exec("UPDATE or_orders SET stock_reservation_enabled=true WHERE bill_no='LEGACY-1'"),/โหมดจอง/)

await db.exec(`UPDATE or_order_items SET quantity=20 WHERE id='${item}'`)
assert.equal((await balance()).reserved,'27')
await assert.rejects(()=>db.exec(`UPDATE or_order_items SET quantity=200 WHERE id='${item}'`),/ไม่พอ/)
assert.equal((await balance()).reserved,'27')
await db.exec(`INSERT INTO wms_orders(product_code,product_name,qty,status,unit_name,source_order_id,source_order_item_id,order_id) VALUES('P1','Product',20,'pending','กล่อง','${order}','${item}','WO1'); UPDATE wms_orders SET status='picked';`)
assert.equal((await balance()).reserved,'27')
await db.exec(`UPDATE wms_orders SET status='correct'`)
assert.equal((await balance()).reserved,'7')
assert.equal((await balance()).on_hand,'80')
assert.equal((await balance()).safety_stock,'20')
assert.equal((await db.query('SELECT count(DISTINCT movement_id)::int n FROM inv_lot_consumptions')).rows[0].n,1)
assert.equal(await lotQty(),80)
assert.equal(await lotQty(true),20)
assert.equal(Number((await db.query("SELECT qty_remaining FROM inv_stock_lots WHERE unit_cost=5")).rows[0].qty_remaining),0)
assert.equal(Number((await db.query("SELECT total_cost FROM inv_stock_movements WHERE ref_type='wms_orders' ORDER BY id LIMIT 1")).rows[0].total_cost),-150)
console.log('Open, reduce, shortage rollback, WMS handoff, real FIFO lot order/cost and Safety isolation pass')

// Pending -> correct must not subtract any unrelated legacy reservation.
const order2='22222222-2222-2222-2222-222222222223'
const item2='33333333-3333-3333-3333-333333333334'
await db.exec(`INSERT INTO or_orders(id,channel_code,bill_no,customer_name,customer_address,admin_user) VALUES('${order2}','TR','TR-2','Customer','','tester');
INSERT INTO or_order_items(id,order_id,item_uid,product_id,product_name,quantity) VALUES('${item2}','${order2}','TR-2-1','${product}','Product',10);
INSERT INTO wms_orders(product_code,product_name,qty,status,unit_name,source_order_id,source_order_item_id,order_id) VALUES('P1','Product',10,'pending','กล่อง','${order2}','${item2}','WO2');
UPDATE wms_orders SET status='correct' WHERE order_id='WO2';`)
assert.equal((await balance()).reserved,'7')
assert.equal((await balance()).on_hand,'70')
await assert.rejects(()=>db.exec(`DELETE FROM or_order_items WHERE id='${item2}'`),/เชื่อมงานหยิบ/)
// Rechecks do not double-deduct FIFO.
await db.exec(`UPDATE wms_orders SET status='out_of_stock' WHERE order_id='WO2'`)
assert.equal((await balance()).reserved,'7')
await db.exec(`UPDATE wms_orders SET status='correct' WHERE order_id='WO2'`)
assert.equal((await balance()).on_hand,'70')
assert.equal((await balance()).reserved,'7')
assert.equal((await db.query('SELECT count(DISTINCT movement_id)::int n FROM inv_lot_consumptions')).rows[0].n,2)
console.log('Non-pick direct deduction, link guard and repeated FIFO check pass')

// Atomic QT/PC save, draft -> active, own-stock credit, expiry and conversion.
const docPayload={ document_type:'quotation', document_no:'QT-1',status:'draft',channel_code:'TR',header_name:'QT',customer_name:'Customer',
  owner_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',owner_name:'tester',delivery_term:'1-3 วัน',valid_until:'2099-01-01',
  billing_details:{},subtotal:0,shipping_cost:0,promotion_discount:0,special_discount:0,total_amount:0,promotion_ids:[],promotion_snapshot:[],shipping_snapshot:{} }
const preItem={id:'44444444-4444-4444-4444-444444444444',sort_order:0,product_id:product,product_code:'P1',product_name:'Product',quantity:20,unit_price:0,is_free:true,is_detail_row:false,oh_snapshot:0,no_name_line:false,field_snapshot:{}}
let saved=(await db.query('SELECT * FROM public.rpc_save_prebill_document(NULL,$1::jsonb,$2::jsonb)',[JSON.stringify(docPayload),JSON.stringify([preItem])])).rows[0]
assert.equal((await balance()).reserved,'7')
await db.query('SELECT public.rpc_save_prebill_document($1,$2::jsonb,$3::jsonb)',[saved.id,JSON.stringify({...docPayload,status:'active'}),JSON.stringify([preItem])])
assert.equal((await balance()).reserved,'27')
const stock=(await db.query(`SELECT * FROM public.rpc_get_reservation_stock('prebill','${saved.id}') WHERE product_id='${product}'`)).rows[0]
assert.equal(stock.own_reserved,'20')
await assert.rejects(()=>db.query('SELECT public.rpc_save_prebill_document($1,$2::jsonb,$3::jsonb)',[saved.id,JSON.stringify({...docPayload,status:'active',customer_name:'Should rollback'}),JSON.stringify([{...preItem,quantity:200}])]),/ไม่พอ/)
assert.equal((await balance()).reserved,'27')
assert.equal((await db.query(`SELECT customer_name FROM or_prebill_documents WHERE id='${saved.id}'`)).rows[0].customer_name,'Customer')
await db.exec(`UPDATE or_prebill_documents SET valid_until=timezone('Asia/Bangkok',now())::date WHERE id='${saved.id}'`)
assert.equal((await balance()).reserved,'27')
await db.exec(`UPDATE or_prebill_documents SET valid_until=timezone('Asia/Bangkok',now())::date-1 WHERE id='${saved.id}'`)
assert.equal((await balance()).reserved,'7')
await db.exec(`UPDATE or_prebill_documents SET valid_until='2099-01-01' WHERE id='${saved.id}'`)
assert.equal((await balance()).reserved,'27')
const converted='55555555-5555-5555-5555-555555555555'
await db.exec(`BEGIN; INSERT INTO or_orders(id,channel_code,bill_no,customer_name,customer_address,admin_user,source_prebill_document_id) VALUES('${converted}','TR','TR-3','Customer','','tester','${saved.id}');
INSERT INTO or_order_items(id,order_id,item_uid,product_id,product_name,quantity,is_free) VALUES('${preItem.id}','${converted}','TR-3-1','${product}','Product',20,true);
UPDATE or_prebill_documents SET status='converted',converted_order_id='${converted}' WHERE id='${saved.id}'; COMMIT;`)
assert.equal((await balance()).reserved,'27')
let rows=(await db.query(`SELECT * FROM rpc_get_product_reservations(ARRAY['${product}']::uuid[])`)).rows
assert.equal(rows.filter(r=>r.source_type==='prebill').length,0)
assert.equal(rows.find(r=>r.source_id===converted).source_document_no,'QT-1')
await db.exec(`UPDATE or_orders SET status='ยกเลิก' WHERE id='${converted}'`)
assert.equal((await balance()).reserved,'7')
console.log('Draft/free items, atomic QT rollback, own-credit, Bangkok expiry and conversion pass')

// PC and claim: shipping confirmation starts the replacement-stock hold.
let pc=(await db.query('SELECT * FROM public.rpc_save_prebill_document(NULL,$1::jsonb,$2::jsonb)',[JSON.stringify({...docPayload,status:'active',document_type:'production_confirmation',document_no:'PC-1'}),JSON.stringify([{...preItem,id:'44444444-4444-4444-4444-444444444445',quantity:5}])])).rows[0]
assert.equal((await balance()).reserved,'12')
await db.exec(`UPDATE or_prebill_documents SET status='cancelled' WHERE id='${pc.id}'`)
const claim='66666666-6666-6666-6666-666666666666'
const claimItem='77777777-7777-7777-7777-777777777777'
await db.exec(`INSERT INTO or_orders(id,channel_code,bill_no,customer_name,customer_address,admin_user) VALUES('${claim}','TR','REQ-1','Customer','','tester');
INSERT INTO or_order_items(id,order_id,item_uid,product_id,product_name,quantity) VALUES('${claimItem}','${claim}','REQ-1-1','${product}','Product',15);`)
assert.equal((await balance()).reserved,'7')
await db.exec(`UPDATE or_orders SET claim_shipping_confirmed_at=now() WHERE id='${claim}'`)
assert.equal((await balance()).reserved,'22')
await db.exec(`UPDATE or_order_items SET cancellation_stock_action='not_picked' WHERE id='${claimItem}'`)
assert.equal((await balance()).reserved,'7')
console.log('PC, claim shipping confirmation and partial cancellation pass')

// Atomic order replacement rolls back on shortage and retains stable item IDs.
await db.exec(`UPDATE or_order_items SET cancellation_stock_action=NULL WHERE id='${claimItem}'`)
const claimItemPayload={id:claimItem,item_uid:'REQ-1-1',product_id:product,product_name:'Product',quantity:12,is_detail_row:false,unit_price:0,no_name_line:false,is_free:false}
await db.query('SELECT rpc_save_order_items($1,$2::jsonb)',[claim,JSON.stringify([claimItemPayload])])
assert.equal((await balance()).reserved,'19')
await assert.rejects(()=>db.query('SELECT rpc_save_order_items($1,$2::jsonb)',[claim,JSON.stringify([{...claimItemPayload,quantity:200}])]),/ไม่พอ/)
assert.equal((await balance()).reserved,'19')
assert.equal((await db.query(`SELECT quantity FROM or_order_items WHERE id='${claimItem}'`)).rows[0].quantity,12)
await db.query('SELECT rpc_save_order_items($1,$2::jsonb)',[claim,'[]'])
assert.equal((await balance()).reserved,'7')
assert.ok((await db.query('SELECT count(*)::int n FROM inv_document_reservation_history')).rows[0].n>0)
console.log('Atomic order replacement, shortage rollback, zero removal and history pass')

// Legacy borrow balance and the latest cancellation resolver coexist with document holds.
await db.exec(`INSERT INTO wms_borrow_requisitions VALUES('99999999-9999-9999-9999-999999999999','BR-1','approved','2099-01-01',auth.uid());
INSERT INTO wms_borrow_requisition_items VALUES('99999999-9999-9999-9999-999999999998','99999999-9999-9999-9999-999999999999','${product}',10,2,1);
ALTER TABLE inv_stock_movements ADD created_by uuid;`)
const cancelSql=await read('supabase/migrations/603_cancelled_wms_not_picked_and_voided_time.sql')
await db.exec(cancelSql.slice(cancelSql.indexOf('CREATE OR REPLACE FUNCTION public.rpc_resolve_cancelled_wms('),cancelSql.indexOf('REVOKE ALL ON FUNCTION public.rpc_resolve_cancelled_wms')))
const cancelOrder='12121212-1212-1212-1212-121212121212'
const cancelItem='13131313-1313-1313-1313-131313131313'
const cancelWms='14141414-1414-1414-1414-141414141414'
await db.exec(`INSERT INTO or_orders(id,channel_code,bill_no,customer_name,customer_address,admin_user) VALUES('${cancelOrder}','TR','TR-CANCEL','Customer','','tester');
INSERT INTO or_order_items(id,order_id,item_uid,product_id,product_name,quantity) VALUES('${cancelItem}','${cancelOrder}','TR-CANCEL-1','${product}','Product',6);
INSERT INTO wms_orders(id,product_code,product_name,qty,status,unit_name,source_order_id,source_order_item_id,order_id) VALUES('${cancelWms}','P1','Product',6,'pending','กล่อง','${cancelOrder}','${cancelItem}','WO-CANCEL');
UPDATE wms_orders SET status='picked' WHERE id='${cancelWms}';
UPDATE wms_orders SET status_before_cancel='picked',status='cancelled' WHERE id='${cancelWms}';
UPDATE or_orders SET status='ยกเลิก' WHERE id='${cancelOrder}';`)
assert.equal((await balance()).reserved,'13')
rows=(await db.query(`SELECT * FROM rpc_get_product_reservations(ARRAY['${product}']::uuid[])`)).rows
assert.equal(rows.reduce((sum,r)=>sum+Number(r.qty),0),13)
assert.equal(rows.find(r=>r.source_id===cancelOrder).status,'cancelled_pending_stock')
assert.equal(rows.find(r=>r.document_type==='borrow').qty,'7')
await db.exec("UPDATE wms_borrow_requisitions SET status='partial_returned'")
assert.equal((await db.query(`SELECT qty FROM rpc_get_product_reservations(ARRAY['${product}']::uuid[]) WHERE document_type='borrow'`)).rows[0].qty,'7')
await db.exec(`SELECT rpc_resolve_cancelled_wms('${cancelWms}','recall')`)
assert.equal((await balance()).reserved,'7')
assert.equal((await balance()).on_hand,'70')
await db.exec(`SELECT rpc_resolve_cancelled_wms('${cancelWms}','recall')`)
assert.equal((await balance()).reserved,'7')
console.log('Borrow totals, pending-after-pick cancellation, recall and duplicate recall pass')

// The worker runs without UI and never returns physical stock or changes Safety stock.
let exp=(await db.query('SELECT * FROM public.rpc_save_prebill_document(NULL,$1::jsonb,$2::jsonb)',[JSON.stringify({...docPayload,status:'active',document_no:'QT-EXPIRE'}),JSON.stringify([{...preItem,id:'15151515-1515-1515-1515-151515151515',quantity:3}])])).rows[0]
assert.equal((await balance()).reserved,'10')
await db.exec(`ALTER TABLE or_prebill_documents DISABLE TRIGGER zzz_document_reservation;
UPDATE or_prebill_documents SET valid_until=timezone('Asia/Bangkok',now())::date-1 WHERE id='${exp.id}';
ALTER TABLE or_prebill_documents ENABLE TRIGGER zzz_document_reservation;
UPDATE inv_document_reservations SET expires_on=timezone('Asia/Bangkok',now())::date-1 WHERE source_id='${exp.id}';
SELECT fn_expire_document_reservations();`)
assert.equal((await balance()).reserved,'7')
assert.equal((await balance()).on_hand,'70')
assert.equal((await balance()).safety_stock,'20')
await db.exec(`SET ROLE authenticated`)
await assert.rejects(()=>db.exec(`SELECT fn_set_document_reservation('order','${claim}','${product}',0)`),/permission denied/)
await assert.rejects(()=>db.exec(`UPDATE inv_document_reservations SET qty=0`),/permission denied/)
await db.exec(`RESET ROLE`)
assert.equal(await lotQty(),70)
assert.equal(await lotQty(true),20)
console.log('Background expiry and client mutation permissions pass')

await db.exec(`GRANT USAGE ON SCHEMA public,auth TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON or_orders,or_order_items,or_prebill_documents,or_prebill_items TO authenticated;
GRANT SELECT,UPDATE ON inv_stock_balances TO authenticated; GRANT SELECT ON us_users TO authenticated;
ALTER TABLE inv_stock_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_read ON inv_stock_balances FOR SELECT TO authenticated USING(true);
ALTER TABLE or_prebill_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_docs ON or_prebill_documents TO authenticated USING(owner_id=auth.uid()) WITH CHECK(owner_id=auth.uid());
SET ROLE authenticated;`)
const authedDoc=(await db.query('SELECT * FROM rpc_save_prebill_document(NULL,$1::jsonb,$2::jsonb)',[JSON.stringify({...docPayload,status:'active',document_no:'QT-AUTH'}),JSON.stringify([{...preItem,id:'16161616-1616-1616-1616-161616161616',quantity:2}])])).rows[0]
assert.ok(authedDoc.id)
await db.exec('RESET ROLE')
assert.equal((await balance()).reserved,'9')
console.log('Authenticated atomic save with real prebill guards and stock read-only RLS passes')
await db.exec(`INSERT INTO wms_orders(product_code,product_name,qty,status,unit_name,order_id) VALUES('P1','Product',2,'pending','กล่อง','REQ-WMS-LEGACY');
UPDATE wms_orders SET status='picked' WHERE order_id='REQ-WMS-LEGACY';`)
const orphan=(await db.query(`SELECT document_type,qty FROM rpc_get_product_reservations(ARRAY['${product}']::uuid[]) WHERE document_no='REQ-WMS-LEGACY'`)).rows[0]
assert.equal(orphan.document_type,'wms')
assert.equal(orphan.qty,'2')
assert.equal((await balance()).reserved,'11')
console.log('Legacy WMS holds without a bill are identified explicitly')
await db.exec(await read('supabase/migrations/626_reservation_reconciliation_audit.sql'))
let audit=(await db.query(`SELECT * FROM fn_reservation_audit(ARRAY['${product}']::uuid[])`)).rows[0]
assert.equal(audit.linked_reserved,'11')
assert.equal(audit.classification,'matched')
await db.exec(`UPDATE inv_stock_balances SET reserved=12 WHERE product_id='${product}'`)
audit=(await db.query(`SELECT * FROM fn_reservation_audit(ARRAY['${product}']::uuid[])`)).rows[0]
assert.equal(audit.classification,'excess_with_completed_evidence')
const reviewed=[{product_id:product,expected_reserved:12,expected_linked_reserved:11}]
const corrected=(await db.query('SELECT * FROM rpc_reconcile_reservation_excess($1::jsonb,$2)',[JSON.stringify(reviewed),'Integration verification'])).rows[0]
assert.equal(corrected.old_reserved,'12')
assert.equal(corrected.new_reserved,'11')
assert.equal((await balance()).on_hand,'70')
assert.equal(await lotQty(),70)
assert.equal(await lotQty(true),20)
assert.equal((await db.query('SELECT count(*)::int AS count FROM inv_reservation_reconciliations')).rows[0].count,1)
await assert.rejects(()=>db.query('SELECT * FROM rpc_reconcile_reservation_excess($1::jsonb,$2)',[JSON.stringify(reviewed),'Stale snapshot']),/ยอดเปลี่ยนหลังตรวจ/)
await db.exec(`UPDATE inv_stock_balances SET reserved=10 WHERE product_id='${product}'`)
await assert.rejects(()=>db.query('SELECT * FROM rpc_reconcile_reservation_excess($1::jsonb,$2)',[JSON.stringify([{...reviewed[0],expected_reserved:10}]),'Under reserved']),/หลักฐานไม่ครบ/)
await db.exec(`UPDATE inv_stock_balances SET reserved=11 WHERE product_id='${product}'; SET ROLE anon`)
await assert.rejects(()=>db.exec('SELECT * FROM fn_reservation_audit(NULL)'),/permission denied/)
await assert.rejects(()=>db.exec(`SELECT * FROM rpc_reconcile_reservation_excess('[]','Denied')`),/permission denied/)
await db.exec('RESET ROLE')
console.log('Audit, guarded correction, stale snapshots, under-reservation rejection, history and FIFO preservation pass')
const draftOrder='17171717-1717-1717-1717-171717171717'
await db.exec(`INSERT INTO or_orders(id,channel_code,bill_no,customer_name,customer_address,admin_user,status) VALUES('${draftOrder}','TR','TR-DRAFT','Draft','','tester','รอลงข้อมูล');
INSERT INTO or_order_items(id,order_id,item_uid,product_id,product_name,quantity) VALUES('18181818-1818-1818-1818-181818181818','${draftOrder}','draft-1','${product}','Product',200);`)
assert.equal((await balance()).reserved,'11')
await assert.rejects(()=>db.exec(`UPDATE or_orders SET status='ข้อมูลครบ' WHERE id='${draftOrder}'`),/ไม่พอ/)
assert.equal((await db.query(`SELECT status FROM or_orders WHERE id='${draftOrder}'`)).rows[0].status,'รอลงข้อมูล')
assert.equal((await balance()).reserved,'11')
await db.exec(`UPDATE or_order_items SET quantity=3 WHERE order_id='${draftOrder}'; ALTER TABLE or_orders DISABLE TRIGGER aa_guard_reservation_cutover; UPDATE or_orders SET stock_reservation_enabled=false WHERE id='${draftOrder}'; ALTER TABLE or_orders ENABLE TRIGGER aa_guard_reservation_cutover; UPDATE or_orders SET status='ข้อมูลครบ' WHERE id='${draftOrder}'`)
assert.equal((await balance()).reserved,'14')
await db.exec(`UPDATE or_orders SET status='รอลงข้อมูล' WHERE id='${draftOrder}'`)
assert.equal((await balance()).reserved,'11')
assert.equal(await lotQty(),70)
assert.equal(await lotQty(true),20)
console.log('Sales drafts reserve zero, activation shortage rolls back, legacy activation reserves, reverting releases document holds only')
for (const documentType of ['quotation','production_confirmation']) {
  const pending=(await db.query('SELECT * FROM rpc_save_prebill_document(NULL,$1::jsonb,$2::jsonb)',[JSON.stringify({...docPayload,status:'draft',document_type:documentType,document_no:`DRAFT-${documentType}`}),JSON.stringify([{...preItem,id:crypto.randomUUID(),quantity:200}])])).rows[0]
  assert.equal((await balance()).reserved,'11')
  await assert.rejects(()=>db.query('SELECT * FROM rpc_save_prebill_document($1,$2::jsonb,$3::jsonb)',[pending.id,JSON.stringify({...docPayload,status:'active',document_type:documentType,document_no:`DRAFT-${documentType}`}),JSON.stringify([{...preItem,id:crypto.randomUUID(),quantity:200}])]),/ไม่พอ/)
  assert.equal((await db.query('SELECT status FROM or_prebill_documents WHERE id=$1',[pending.id])).rows[0].status,'draft')
  assert.equal((await balance()).reserved,'11')
}
console.log('QT and PC drafts accept unreserved quantities, but actual activation rejects shortages and preserves the draft')
await db.close()
