// Isolated PostgreSQL integration tests. No live credentials or database connections.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'
const db = new PGlite()
process.on('uncaughtException', error => { console.error(error.stack, error.where || '', error.detail || ''); process.exit(1) })
await db.exec(`
 CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::uuid $$;
 CREATE TABLE us_users(id UUID PRIMARY KEY,role TEXT,username TEXT);
 CREATE TABLE st_user_menus(role TEXT,menu_key TEXT,menu_name TEXT,has_access BOOLEAN,updated_at TIMESTAMPTZ,PRIMARY KEY(role,menu_key));
 INSERT INTO us_users VALUES(auth.uid(),'superadmin','tester');
 CREATE TABLE bank_settings(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),bank_code TEXT,bank_name TEXT,account_number TEXT,account_name TEXT,is_active BOOLEAN DEFAULT true);
 CREATE TABLE bank_settings_channels(bank_setting_id UUID,channel_code TEXT);
 CREATE TABLE or_orders(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),bill_no TEXT,status TEXT,channel_code TEXT,payment_method TEXT,total_amount NUMERIC,created_at TIMESTAMPTZ DEFAULT now(),price NUMERIC DEFAULT 0,shipping_cost NUMERIC DEFAULT 0,discount NUMERIC DEFAULT 0,updated_at TIMESTAMPTZ DEFAULT now());
 CREATE TABLE or_claim_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),created_claim_order_id UUID REFERENCES or_orders(id),status TEXT,proposed_snapshot JSONB,reviewed_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT now());
 CREATE TABLE ac_verified_slips(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),order_id UUID,verified_amount NUMERIC,easyslip_date TIMESTAMPTZ,easyslip_receiver_bank_id TEXT,easyslip_receiver_account TEXT,easyslip_response JSONB,expected_bank_code TEXT,expected_bank_account TEXT,is_deleted BOOLEAN DEFAULT false,validation_status TEXT DEFAULT 'passed');
 CREATE TABLE ac_manual_slip_checks(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),order_id UUID,transfer_date TEXT,transfer_time TEXT,transfer_amount NUMERIC,status TEXT);
 INSERT INTO bank_settings(id,bank_code,bank_name,account_number) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','004','KBANK','12349552');
 INSERT INTO bank_settings_channels VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','SHOP');
`)
for (const migration of ['561_bank_statement_reconciliation','562_fix_bank_reconciliation_missing_payments','563_improve_bank_statement_auto_match','564_bank_statement_match_diagnostics','565_restrict_bank_reconciliation_roles','569_split_available_and_allocated_match_candidates','570_link_manual_bill_match_to_payment_source','571_bank_non_sales_classification_rules','580_sync_bank_rule_classification_name','581_prevent_fully_paid_bill_reuse','582_bank_reconciliation_global_summary','583_bank_reconciliation_import_issue_summary','634_reconciliation_workspace','635_literal_bank_rules_and_audit','636_certified_receipt_matching_guards','637_bank_workspace_credit_pagination', '638_sales_tracking_start_october', '639_exclude_ecommerce_sales_tracking','671_bank_import_matching_isolation_and_coverage']) {
  try { await db.exec(await fs.readFile(`supabase/migrations/${migration}.sql`, 'utf8')) }
  catch (error) { console.error('Migration:', migration); throw error }
}

await db.exec(`
 ALTER TABLE us_users ADD COLUMN email text, ADD COLUMN is_active boolean DEFAULT true;
 ALTER TABLE or_orders ADD COLUMN admin_user text DEFAULT 'seller', ADD COLUMN work_order_id uuid,
 ADD COLUMN source_prebill_document_id uuid, ADD COLUMN source_marketplace_order_id uuid,
 ADD COLUMN web_import_snapshot jsonb, ADD COLUMN fulfillment_method text DEFAULT 'shipping',ADD COLUMN requires_confirm_design boolean DEFAULT false;
 CREATE TABLE or_order_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid REFERENCES or_orders(id),product_id uuid,product_name text,quantity numeric,unit_price numeric,is_free boolean DEFAULT false,is_detail_row boolean DEFAULT false);
 CREATE TABLE pr_products(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_category text,product_name text);
 CREATE TABLE promotion(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,rule_type text,is_active boolean DEFAULT true,channel_codes text[] DEFAULT '{}',start_date date,end_date date,allow_stack boolean DEFAULT true,rule_config jsonb DEFAULT '{}');
 CREATE TABLE or_order_promotions(order_id uuid REFERENCES or_orders(id),promotion_id uuid REFERENCES promotion(id),application_count int DEFAULT 1,PRIMARY KEY(order_id,promotion_id));
 CREATE TABLE or_prebill_documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),document_type text DEFAULT 'quotation',document_no text,status text DEFAULT 'active',valid_until date DEFAULT current_date+10,owner_id uuid,owner_name text,
 discount_requested_at timestamptz,discount_request_note text,created_at timestamptz DEFAULT now(),approved_by uuid,approved_at timestamptz,approved_special_discount numeric,approval_note text,rejection_note text,
 subtotal numeric,shipping_cost numeric,promotion_discount numeric DEFAULT 0,special_discount numeric,total_amount numeric,channel_code text DEFAULT 'SHOP',payment_method text DEFAULT 'โอน',converted_order_id uuid);
 CREATE TABLE or_prebill_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),document_id uuid REFERENCES or_prebill_documents(id),product_id uuid,quantity numeric,unit_price numeric,is_free boolean DEFAULT false,is_detail_row boolean DEFAULT false);
 INSERT INTO us_users(id,role,username,email) VALUES ('11111111-1111-1111-1111-111111111111','sales-tr','seller','seller@test'),('22222222-2222-2222-2222-222222222222','sales-pump','other','other@test'),('33333333-3333-3333-3333-333333333333','admin','admin','admin@test');
 INSERT INTO pr_products(id,product_category) VALUES('44444444-4444-4444-4444-444444444444','A'),('55555555-5555-5555-5555-555555555555','A');
 INSERT INTO or_orders(id,bill_no,status,channel_code,price,shipping_cost,discount,total_amount) VALUES('99999999-9999-9999-9999-999999999999','LEGACY','รอลงข้อมูล','SHOP',100,0,100,0);
`)
await db.exec(`
 ALTER TABLE or_orders ADD COLUMN work_order_name text,ADD COLUMN shipped_time timestamptz;
 CREATE TABLE ac_refunds(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,status text,amount numeric,reason text,created_at timestamptz DEFAULT now());
 ALTER TABLE or_prebill_documents ADD COLUMN special_discount_type text,ADD COLUMN special_discount_value numeric,
 ADD COLUMN discount_requested_by uuid,ADD COLUMN updated_at timestamptz DEFAULT now(),ADD COLUMN source_document_id uuid;
 CREATE TABLE or_prebill_approval_logs(document_id uuid,action text,requested_discount numeric,approved_discount numeric,note text,actor_id uuid,actor_name text);
 CREATE FUNCTION check_user_role(p_id uuid,p_roles text[]) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM us_users WHERE id=p_id AND role=ANY(p_roles)) $$;
`)
function sqlFunction(sql,name){const a=sql.indexOf('CREATE OR REPLACE FUNCTION public.'+name+'(');assert.ok(a>=0,name);return sql.slice(a,sql.indexOf('$$;',a)+3)}
const prebill576=await fs.readFile('supabase/migrations/576_prebill_qt_pc_documents.sql','utf8')
const prebill597=await fs.readFile('supabase/migrations/597_prebill_sales_tr_team_cancel_audit.sql','utf8')
for(const [file,name] of [[prebill597,'can_manage_prebill_document'],[prebill597,'rpc_request_prebill_discount'],[prebill576,'rpc_review_prebill_discount'],[prebill597,'guard_prebill_document_update'],[prebill597,'guard_prebill_item_write']]) await db.exec(sqlFunction(file,name))
await db.exec(`CREATE TRIGGER trg_guard_prebill_document_update BEFORE INSERT OR UPDATE ON or_prebill_documents FOR EACH ROW EXECUTE FUNCTION guard_prebill_document_update();
CREATE TRIGGER trg_guard_prebill_item_write BEFORE INSERT OR UPDATE OR DELETE ON or_prebill_items FOR EACH ROW EXECUTE FUNCTION guard_prebill_item_write();`)
await db.exec(await fs.readFile('supabase/migrations/648_refund_production_gate_and_status_history.sql','utf8'))
await db.exec(`
 ALTER TABLE or_orders ADD COLUMN promotion text,ADD COLUMN customer_name text,ADD COLUMN customer_address text,ADD COLUMN recipient_name text,
 ADD COLUMN entry_date date,ADD COLUMN billing_details jsonb,ADD COLUMN prebill_price_locked boolean DEFAULT false,ADD COLUMN source_prebill_document_type text,ADD COLUMN source_prebill_owner_name text;
 ALTER TABLE or_order_items ADD COLUMN item_uid text,ADD COLUMN ink_color text,ADD COLUMN product_type text,ADD COLUMN cartoon_pattern text,ADD COLUMN line_pattern text,
 ADD COLUMN font text,ADD COLUMN line_1 text,ADD COLUMN line_2 text,ADD COLUMN line_3 text,ADD COLUMN no_name_line boolean,ADD COLUMN notes text,ADD COLUMN file_attachment text,ADD COLUMN attachment_name text,ADD COLUMN parent_item_id uuid;
 ALTER TABLE or_prebill_documents ADD COLUMN customer_name text DEFAULT 'customer',ADD COLUMN customer_address text,ADD COLUMN recipient_name text,
 ADD COLUMN customer_phone text,ADD COLUMN billing_details jsonb DEFAULT '{}',ADD COLUMN promotion_ids uuid[] DEFAULT '{}',ADD COLUMN promotion_snapshot jsonb DEFAULT '[]',ADD COLUMN converted_at timestamptz;
 ALTER TABLE or_prebill_items ADD COLUMN sort_order int DEFAULT 1,ADD COLUMN product_name text,ADD COLUMN ink_color text,ADD COLUMN product_type text,ADD COLUMN cartoon_pattern text,ADD COLUMN line_pattern text,
 ADD COLUMN font text,ADD COLUMN line_1 text,ADD COLUMN line_2 text,ADD COLUMN line_3 text,ADD COLUMN no_name_line boolean,ADD COLUMN notes text,ADD COLUMN file_attachment text,ADD COLUMN attachment_name text,ADD COLUMN parent_item_id uuid;
 ALTER TABLE promotion ADD COLUMN version int DEFAULT 1;
 ALTER TABLE or_order_promotions ADD COLUMN promotion_name_snapshot text,ADD COLUMN promotion_version int,ADD COLUMN rule_snapshot jsonb,ADD COLUMN selected_by text;
`)
await db.exec(sqlFunction(prebill597,'rpc_convert_prebill_to_order'))

await db.exec(await fs.readFile('supabase/migrations/674_sales_discount_approval.sql','utf8'))
const q=async(sql,args=[])=>(await db.query(sql,args)).rows
const root='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',seller='11111111-1111-1111-1111-111111111111',other='22222222-2222-2222-2222-222222222222',admin='33333333-3333-3333-3333-333333333333',product='44444444-4444-4444-4444-444444444444'
const actor=async id=>{await q("SELECT set_config('request.jwt.claim.sub',$1,false)",[id])}
let passed=0
async function test(name,fn){await actor(root);await fn();console.log('PASS '+name);passed++}
const bill=async(discount=100,shipping=0)=> (await q("INSERT INTO or_orders(bill_no,status,channel_code,payment_method,price,shipping_cost,discount,total_amount,created_at) VALUES('SALE'||gen_random_uuid(),'รอลงข้อมูล','SHOP','โอน',100,$1,$2,100+$1::numeric-$2::numeric,'2026-10-15') RETURNING id",[shipping,discount]))[0].id
const line=async id=>{await q('INSERT INTO or_order_items(order_id,product_id,quantity,unit_price) VALUES($1,$2,1,100)',[id,product])}
const request=async id=>(await q("SELECT rpc_request_sales_discount($1,'อนุมัติส่วนลดพิเศษ') id",[id]))[0].id
const review=async(id,approve=true,note=null)=>{await q('SELECT rpc_review_sales_discount($1,$2,$3)',[id,approve,note])}
const get=async id=>(await q('SELECT * FROM or_orders WHERE id=$1',[id]))[0]
const state=async id=>(await q("SELECT rpc_check_order_discount(o.id,to_jsonb(o),or_discount_items(o.id),coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM or_order_promotions p WHERE order_id=o.id),'[]')) s FROM or_orders o WHERE id=$1",[id]))[0].s
const complete=async id=>{await q("UPDATE or_orders SET status='ลงข้อมูลเสร็จสิ้น' WHERE id=$1",[id])}
await test('manual discounted sales cannot complete without approved snapshot',async()=>{const id=await bill();await line(id);await assert.rejects(()=>complete(id),/superadmin/);assert.equal((await get(id)).status,'รอลงข้อมูล')})
await test('seller requests, only active superadmin reviews; pending cannot complete',async()=>{const id=await bill();await line(id);await actor(seller);const req=await request(id);await assert.rejects(()=>complete(id),/superadmin/);for(const role of [seller,other,admin]){await actor(role);await assert.rejects(()=>review(req),/superadmin/)}await actor(root);await review(req);assert.equal((await state(id)).approved,true);await complete(id);const o=await get(id);assert.equal(o.status,'รอตรวจคำสั่งซื้อ');assert.equal(o.payment_not_required,true);assert.equal((await q('SELECT count(*)::int n FROM ac_verified_slips WHERE order_id=$1',[id]))[0].n,0)})
await test('approved positive total stays on payment path, including shipping balance',async()=>{const id=await bill(100,30);await line(id);const req=await request(id);await review(req);await complete(id);assert.equal((await get(id)).payment_not_required,false);assert.equal((await get(id)).status,'ลงข้อมูลเสร็จสิ้น')})
await test('rejection requires note and cannot complete; resubmission retains history',async()=>{const id=await bill();await line(id);const req=await request(id);await assert.rejects(()=>review(req,false),/เหตุผล/);await review(req,false,'ไม่อนุมัติ');await assert.rejects(()=>complete(id),/superadmin/);const newReq=await request(id);assert.notEqual(newReq,req);assert.equal((await q('SELECT count(*)::int n FROM or_sales_discount_requests WHERE order_id=$1',[id]))[0].n,2)})
await test('changed total/items invalidate approval even when payable remains zero',async()=>{const id=await bill();await line(id);await review(await request(id));await q('UPDATE or_order_items SET product_id=$1 WHERE order_id=$2',['55555555-5555-5555-5555-555555555555',id]);assert.equal((await state(id)).approved,false);await assert.rejects(()=>complete(id),/superadmin/);await review(await request(id));await q('UPDATE or_orders SET price=200,discount=200 WHERE id=$1',[id]);await assert.rejects(()=>complete(id),/superadmin/)})
await test('pending edited request becomes stale and is excluded from pending count',async()=>{const id=await bill();await line(id);const req=await request(id);await q('UPDATE or_orders SET shipping_cost=20,total_amount=20 WHERE id=$1',[id]);await assert.rejects(()=>review(req),/รออนุมัติ|เปลี่ยน/);const rows=(await q("SELECT rpc_discount_approval_queue('pending','all',0) s"))[0].s.rows;assert.ok(!rows.some(r=>r.id===req))})
await test('cancelled bills are excluded and cannot be approved',async()=>{const id=await bill();await line(id);const req=await request(id);await q("UPDATE or_orders SET status='ยกเลิก' WHERE id=$1",[id]);assert.equal((await q('SELECT status FROM or_sales_discount_requests WHERE id=$1',[req]))[0].status,'cancelled');await assert.rejects(()=>review(req),/รออนุมัติ/)})
await test('other seller cannot request/read review queue; inactive superadmin cannot approve',async()=>{const id=await bill();await line(id);await actor(other);await assert.rejects(()=>request(id),/สิทธิ์/);await assert.rejects(()=>q("SELECT rpc_discount_approval_queue()"),/superadmin/);await actor(root);const req=await request(id);await q('UPDATE us_users SET is_active=false WHERE id=$1',[root]);await assert.rejects(()=>review(req),/superadmin/);await q('UPDATE us_users SET is_active=true WHERE id=$1',[root])})
await test('legacy bills are not backfilled or silently marked payment free',async()=>{const id='99999999-9999-9999-9999-999999999999';assert.equal((await get(id)).discount_approval_enabled,false);await complete(id);assert.equal((await get(id)).payment_not_required,false)})
await test('negative and inconsistent totals are rejected; exact zero only',async()=>{await assert.rejects(()=>bill(101),/ติดลบ/);const id=await bill(99.99);await line(id);await review(await request(id));await complete(id);assert.equal((await get(id)).payment_not_required,false)})
await test('automatic spend promotion remains exempt, legacy/manual discounts require review',async()=>{const id=await bill(20);await line(id);const p=(await q("INSERT INTO promotion(name,rule_type,rule_config) VALUES('auto','spend_fixed','{\"threshold_amount\":100,\"discount_value\":20}') RETURNING id"))[0].id;await q('INSERT INTO or_order_promotions VALUES($1,$2,1)',[id,p]);assert.equal((await state(id)).required,false);await complete(id);await q("UPDATE or_orders SET status='รอลงข้อมูล',discount=25,total_amount=75 WHERE id=$1",[id]);await assert.rejects(()=>complete(id),/superadmin/)})
await test('request table is read-only to authenticated; fields cannot spoof zero exemption',async()=>{await db.exec('GRANT USAGE ON SCHEMA auth TO authenticated; GRANT SELECT ON us_users,or_orders,or_order_items,or_order_promotions TO authenticated; GRANT UPDATE ON or_orders TO authenticated; REVOKE INSERT,UPDATE,DELETE ON or_sales_discount_requests FROM authenticated;');const id=await bill();await line(id);const req=await request(id);await db.exec('SET ROLE authenticated');try{await assert.rejects(()=>q("UPDATE or_sales_discount_requests SET status='approved' WHERE id=$1",[req]),/permission/);await q('UPDATE or_orders SET payment_not_required=true,discount_approval_enabled=false WHERE id=$1',[id]);}finally{await db.exec('RESET ROLE')}assert.equal((await get(id)).payment_not_required,false);assert.equal((await get(id)).discount_approval_enabled,true)})
await test('approved zero bill is no_payment in real bank workspace; no allocations created',async()=>{const id=await bill();await line(id);await review(await request(id));await complete(id);const s=(await q("SELECT bank_sales_workspace(NULL,NULL,'all','','','',0) s"))[0].s;assert.equal(s.rows.find(r=>r.id===id).reconciliation_state,'no_payment');assert.equal((await q('SELECT count(*)::int n FROM ac_bank_reconciliation_allocations WHERE order_id=$1',[id]))[0].n,0)})

const qt=async(type='quotation')=>{
 const id=(await q("INSERT INTO or_prebill_documents(document_type,document_no,owner_id,owner_name,subtotal,shipping_cost,special_discount,total_amount) VALUES($1,'QT'||gen_random_uuid(),$2,'seller',100,0,0,100) RETURNING id",[type,seller]))[0].id
 await q('INSERT INTO or_prebill_items(document_id,product_id,quantity,unit_price) VALUES($1,$2,1,100)',[id,product]);return id
}
const qtRequest=async id=>{await q("SELECT rpc_request_prebill_discount($1,'amount',100,'ส่วนลดเต็มจำนวน')",[id])}
const qtReview=async(id,approve=true)=>{await q("SELECT rpc_review_prebill_discount($1,$2,NULL,'พิจารณาแล้ว')",[id,approve])}
await test('QT and PC requests share queue and use the existing superadmin-only approval RPC',async()=>{
 for(const kind of ['quotation','production_confirmation']){
  const id=await qt(kind);await actor(seller);await qtRequest(id)
  await assert.rejects(()=>qtReview(id),/superadmin/);await actor(admin);await assert.rejects(()=>qtReview(id),/superadmin/)
  await actor(root);const queue=(await q("SELECT rpc_discount_approval_queue('pending','all',0) s"))[0].s
  assert.ok(queue.rows.some(r=>r.id===id && r.source===(kind==='quotation'?'QT':'PC')))
  await qtReview(id);assert.equal((await q('SELECT status FROM or_prebill_documents WHERE id=$1',[id]))[0].status,'approved')
 }
})
await test('converted approved QT proof skips new approval only for identical header and commercial lines',async()=>{
 const doc=await qt();await qtRequest(doc);await qtReview(doc)
 const id=(await q('SELECT rpc_convert_prebill_to_order($1) s',[doc]))[0].s.order_id
 assert.equal((await state(id)).source,'prebill');await complete(id);assert.equal((await get(id)).payment_not_required,true)
 assert.equal((await q('SELECT count(*)::int n FROM or_sales_discount_requests WHERE order_id=$1',[id]))[0].n,0)
 await q("UPDATE or_orders SET status='รอลงข้อมูล',shipping_cost=10,total_amount=10 WHERE id=$1",[id]);assert.equal((await state(id)).approved,false);await assert.rejects(()=>complete(id),/superadmin/)
})
await test('actual QT and PC conversion RPC yields reusable approved zero proof and no duplicate requests',async()=>{
 for(const kind of ['quotation','production_confirmation']){
  const doc=await qt(kind);await qtRequest(doc);await qtReview(doc)
  await actor(seller);const result=(await q('SELECT rpc_convert_prebill_to_order($1) s',[doc]))[0].s;const id=result.order_id
  assert.ok(id);assert.equal((await state(id)).approved,true);assert.equal((await state(id)).source,'prebill')
  await complete(id);assert.equal((await get(id)).payment_not_required,true)
  await actor(root)
 }
})
await test('approved QT proof cannot be reassigned or attached to a direct bill through table writes',async()=>{
 const doc=await qt();await qtRequest(doc);await qtReview(doc);const id=(await q('SELECT rpc_convert_prebill_to_order($1) s',[doc]))[0].s.order_id
 const fake=await bill();await line(fake)
 await assert.rejects(()=>q('UPDATE or_orders SET source_prebill_document_id=$1 WHERE id=$2',[doc,fake]),/QT/)
 await assert.rejects(()=>q('UPDATE or_prebill_documents SET converted_order_id=$1 WHERE id=$2',[fake,doc]),/QT/)
 assert.equal((await q('SELECT converted_order_id FROM or_prebill_documents WHERE id=$1',[doc]))[0].converted_order_id,id)
})
await test('unchanged QT item replacement preserves approval; changed replacement invalidates it',async()=>{
 const doc=await qt();await qtRequest(doc);await qtReview(doc)
 await db.exec('BEGIN');await q('DELETE FROM or_prebill_items WHERE document_id=$1',[doc]);await q('INSERT INTO or_prebill_items(document_id,product_id,quantity,unit_price) VALUES($1,$2,1,100)',[doc,product]);await db.exec('COMMIT')
 assert.equal((await q('SELECT status FROM or_prebill_documents WHERE id=$1',[doc]))[0].status,'approved')
 await db.exec('BEGIN');await q('DELETE FROM or_prebill_items WHERE document_id=$1',[doc]);await q('INSERT INTO or_prebill_items(document_id,product_id,quantity,unit_price) VALUES($1,$2,2,100)',[doc,product]);await db.exec('COMMIT')
 assert.equal((await q('SELECT status FROM or_prebill_documents WHERE id=$1',[doc]))[0].status,'active')
})
await test('QT edits while pending or approved invalidate review and require resubmission',async()=>{
 const doc=await qt();await qtRequest(doc);await q('UPDATE or_prebill_items SET quantity=2 WHERE document_id=$1',[doc]);assert.equal((await q('SELECT status FROM or_prebill_documents WHERE id=$1',[doc]))[0].status,'active');await assert.rejects(()=>qtReview(doc),/รออนุมัติ/)
 await qtRequest(doc);await qtReview(doc);await q('UPDATE or_prebill_documents SET shipping_cost=10,total_amount=10 WHERE id=$1',[doc]);assert.equal((await q('SELECT status FROM or_prebill_documents WHERE id=$1',[doc]))[0].status,'active');await assert.rejects(()=>q("UPDATE or_prebill_documents SET status='converted',converted_order_id=gen_random_uuid() WHERE id=$1",[doc]),/อนุมัติ/)
})
await test('expired and cancelled QT requests are excluded from badge; rejected amounts retain requested snapshot',async()=>{
 const expired=await qt();await qtRequest(expired);await q('UPDATE or_prebill_documents SET valid_until=current_date-1 WHERE id=$1',[expired]);await assert.rejects(()=>qtReview(expired),/หมดอายุ/)
 const cancelled=await qt();await qtRequest(cancelled);await q("UPDATE or_prebill_documents SET status='cancelled' WHERE id=$1",[cancelled])
 const rejected=await qt();await qtRequest(rejected);await qtReview(rejected,false)
 const queue=(await q("SELECT rpc_discount_approval_queue('pending','all',0) s"))[0].s
 assert.ok(!queue.rows.some(r=>[expired,cancelled].includes(r.id)))
 const r=(await q("SELECT rpc_discount_approval_queue('rejected','all',0) s"))[0].s.rows.find(r=>r.id===rejected);assert.equal(Number(r.discount),100);assert.equal(Number(r.total_amount),0)
})
await test('inactive superadmin cannot approve QT via the existing RPC',async()=>{const doc=await qt();await qtRequest(doc);await q('UPDATE us_users SET is_active=false WHERE id=$1',[root]);await assert.rejects(()=>qtReview(doc),/superadmin/);await q('UPDATE us_users SET is_active=true WHERE id=$1',[root])})
await test('normal zero workflow preserves design routing for owner, not reviewer',async()=>{
 const id=await bill();await line(id);await q("UPDATE or_orders SET admin_user='other',channel_code='PUMP',requires_confirm_design=false WHERE id=$1",[id]);await review(await request(id));await complete(id);assert.equal((await get(id)).status,'ไม่ต้องออกแบบ')
})
await test('financial edits cannot invalidate an approved bill already progressing; parent reassignment blocked',async()=>{const id=await bill();await line(id);await review(await request(id));await complete(id);await assert.rejects(()=>q('UPDATE or_order_items SET quantity=2 WHERE order_id=$1',[id]),/superadmin/);const target=await bill();await assert.rejects(()=>q('UPDATE or_order_items SET order_id=$1 WHERE order_id=$2',[target,id]),/ย้ายรายการ/)})
await test('queue count matches pending rows across types and pagination',async()=>{const all=(await q("SELECT rpc_discount_approval_queue('pending','all',0) s"))[0].s;assert.equal(all.count,all.pending_count);let sum=0;for(const type of ['sale','QT','PC'])sum+=(await q("SELECT rpc_discount_approval_queue('pending',$1,0) s",[type]))[0].s.count;assert.equal(sum,all.count)})
await test('SQL group allocation follows overlapping selectors and highest-value/quantity-at-least rules',async()=>{
 const items=[{product_id:product,product_category:'A',quantity:2,unit_price:100},{product_id:other,product_category:'A',quantity:2,unit_price:20}]
 const groups=[{quantity:2,options:[{selector_type:'category',category:'A'}]},{quantity:1,options:[{selector_type:'sku',product_id:product}]}]
 const calc=async(gs,extra=false)=>(await q('SELECT or_discount_group_value($1::jsonb,$2::jsonb,1,$3) v',[JSON.stringify(items),JSON.stringify(gs),extra]))[0].v
 assert.equal(Number(await calc(groups)),220)
 assert.equal(Number(await calc([{quantity:1,quantity_at_least:true,options:[{selector_type:'category',category:'A'}]}],true)),240)
 assert.equal(await calc([{quantity:5,options:[{selector_type:'category',category:'A'}]}]),null)
})
await test('automatic promotion eligibility is preserved after rules change, but commercial edits require reevaluation',async()=>{
 const id=await bill(20);await line(id);const p=(await q("INSERT INTO promotion(name,rule_type,rule_config) VALUES('versioned','spend_fixed','{\"threshold_amount\":100,\"discount_value\":20}') RETURNING id"))[0].id
 await q('INSERT INTO or_order_promotions(order_id,promotion_id,application_count) VALUES($1,$2,1)',[id,p]);await complete(id)
 await q('UPDATE promotion SET is_active=false WHERE id=$1',[p]);await q("UPDATE or_orders SET status='ตรวจสอบแล้ว' WHERE id=$1",[id]);assert.equal((await state(id)).required,false)
 await assert.rejects(()=>q('UPDATE or_order_items SET quantity=2 WHERE order_id=$1',[id]),/superadmin/)
})
await test('QT discounts cannot exceed remaining balance after promotion',async()=>{
 const doc=await qt();await q('UPDATE or_prebill_documents SET promotion_discount=50,total_amount=50 WHERE id=$1',[doc]);await qtRequest(doc);await qtReview(doc)
 const d=(await q('SELECT * FROM or_prebill_documents WHERE id=$1',[doc]))[0];assert.equal(Number(d.special_discount),50);assert.equal(Number(d.total_amount),0)
 const id=(await q('SELECT rpc_convert_prebill_to_order($1) s',[doc]))[0].s.order_id;await complete(id);assert.equal((await get(id)).payment_not_required,true)
})
await test('server monetary promotion calculation matches shared frontend rules across all monetary types',async()=>{
 const ts=await import('../../node_modules/typescript/lib/typescript.js')
 const source=ts.default.transpileModule(await fs.readFile('src/lib/promotionRules.ts','utf8'),{compilerOptions:{module:ts.default.ModuleKind.ESNext,target:ts.default.ScriptTarget.ES2022}}).outputText
 const rules=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))
 const items=[{product_id:product,product_category:'A',quantity:2,unit_price:100},{product_id:'55555555-5555-5555-5555-555555555555',product_category:'A',quantity:2,unit_price:20}]
 const group={quantity:2,options:[{selector_type:'category',category:'A'}]}
 const cases=[['spend_fixed',{threshold_amount:100,discount_value:20,max_applications:2},2],['spend_percent',{threshold_amount:100,discount_value:10},1],['quantity_fixed',{condition_groups:[group],discount_value:30,max_applications:2},2],['quantity_percent',{condition_groups:[group,{quantity:1,options:[{selector_type:'sku',product_id:product}]}],discount_value:10},1],['bundle_fixed_price',{condition_groups:[group],set_price:150},1],['quantity_percent',{condition_groups:[{...group,quantity_at_least:true}],discount_value:50},1]]
 for(const [type,cfg,count] of cases){
  const pr=(await q('INSERT INTO promotion(name,rule_type,rule_config) VALUES($1,$1,$2::jsonb) RETURNING *',[type,JSON.stringify(cfg)]))[0]
  const expected=rules.totalPromotionDiscount(rules.evaluatePromotions([pr],items,{channel_code:'SHOP',order_subtotal:240,application_counts:{[pr.id]:count},order_date:new Date(Date.now()+7*3600000).toISOString().slice(0,10)}))
  const actual=(await q('SELECT or_discount_automatic($1::jsonb,$2::jsonb,$3::jsonb) v',[JSON.stringify({price:240,channel_code:'SHOP'}),JSON.stringify(items),JSON.stringify([{promotion_id:pr.id,application_count:count}])]))[0].v
  assert.equal(Number(actual),expected,type)
 }
 const first=(await q("INSERT INTO promotion(name,rule_type,rule_config,allow_stack) VALUES('exclusive','spend_fixed','{\"discount_value\":10}',false) RETURNING id"))[0].id
 const second=(await q("INSERT INTO promotion(name,rule_type,rule_config) VALUES('stack','spend_fixed','{\"discount_value\":20}') RETURNING id"))[0].id
 assert.equal(Number((await q('SELECT or_discount_automatic($1::jsonb,$2::jsonb,$3::jsonb) v',[JSON.stringify({price:240,channel_code:'SHOP'}),JSON.stringify(items),JSON.stringify([{promotion_id:first},{promotion_id:second}])]))[0].v),0)
})
await test('currency snapshot comparison tolerates JavaScript floating point sums at satang precision',async()=>{
 const id=await bill();await line(id);await q('UPDATE or_orders SET price=100.30,discount=100.30,total_amount=0 WHERE id=$1',[id]);await q('UPDATE or_order_items SET unit_price=100.30 WHERE order_id=$1',[id]);await review(await request(id))
 const header={...(await get(id)),price:100.1+0.2,discount:100.3,total_amount:0}
 const result=(await q('SELECT rpc_check_order_discount($1,$2::jsonb,$3::jsonb) s',[id,JSON.stringify(header),JSON.stringify([{product_id:product,quantity:1,unit_price:100.3}])]))[0].s
 assert.equal(result.approved,true);assert.equal(result.zero_payment,true)
})
console.log(`${passed} isolated database scenarios passed`)
await db.close()
