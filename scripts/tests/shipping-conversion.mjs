// Runs the migration against isolated PostgreSQL WASM; never connects to Supabase.
// Install test runtime without changing manifests: npm install --no-save --package-lock=false --ignore-scripts @electric-sql/pglite
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
const db = new PGlite()
const sql = (s, p = []) => db.query(s, p)
await db.exec(`
 CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid',true),'')::uuid $$;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
 CREATE TABLE us_users(id uuid PRIMARY KEY,role text,username text,email text);
 CREATE TABLE channels(channel_code text PRIMARY KEY,is_self_pickup boolean);
 CREATE TABLE channel_role_visibility(channel_code text,role text);
 CREATE TABLE tr_shipping_carriers(code text PRIMARY KEY,name text,is_active boolean);
 CREATE TABLE or_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bill_no text,channel_code text,fulfillment_method text,
 status text,shipped_time timestamptz,transport_meta jsonb,billing_details jsonb,customer_address text,recipient_name text,tracking_number text,
 price numeric,discount numeric,shipping_cost numeric,total_amount numeric,payment_method text,packing_meta jsonb,admin_user text,
 work_order_name text,converted_from_self_pickup_at timestamptz,converted_from_self_pickup_by text);
 CREATE TABLE ac_verified_slips(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,verified_amount numeric,validation_status text,easyslip_trans_ref text,slip_image_url text,slip_storage_path text,verified_by uuid,easyslip_response jsonb,easyslip_date timestamptz,is_deleted boolean DEFAULT false,easyslip_receiver_bank_id text,easyslip_receiver_account text,is_validated boolean,expected_amount numeric,account_name_match boolean,bank_code_match boolean);
 CREATE TABLE ac_refunds(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,amount numeric,status text);
 CREATE TABLE or_fulfillment_change_logs(id uuid DEFAULT gen_random_uuid(),order_id uuid,bill_no text,from_method text,to_method text,reason text,previous_status text,previous_customer_address text,previous_recipient_name text,previous_tracking_number text,changed_by text,changed_by_user_id uuid,changed_at timestamptz DEFAULT now());
 CREATE TABLE pk_packing_unit_scans(id uuid DEFAULT gen_random_uuid(),order_id uuid);
 CREATE TABLE st_user_menus(role text,menu_key text,menu_name text,has_access boolean,updated_at timestamptz,UNIQUE(role,menu_key));
 CREATE TABLE or_shipping_fee_settings(id int,auto_calculate_enabled boolean,special_area_enabled boolean);
 CREATE TABLE or_shipping_fee_ranges(min_amount numeric,max_amount numeric,shipping_fee numeric,sort_order int);
 CREATE TABLE or_shipping_area_rules(carrier text,channel_codes text[],postal_code text,province text,district text,sub_district text,surcharge numeric,is_forever boolean,start_date date,end_date date,is_active boolean);
 CREATE FUNCTION pk_convert_self_pickup_to_shipping(uuid,text,text,text,text,text,text,text,text,text,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
 CREATE FUNCTION pk_start_work_order_packing(text,timestamptz DEFAULT now()) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
 GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;
 GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO authenticated,service_role;
 INSERT INTO channels VALUES('SHOPP',true),('OATR-P',true),('SHOP',false);
 INSERT INTO channel_role_visibility VALUES('SHOPP','sales-tr'),('OATR-P','sales-tr');
 INSERT INTO tr_shipping_carriers VALUES('FLASH','Flash Express',true),('SELF','รับเอง',true);
 INSERT INTO or_shipping_fee_settings VALUES(1,true,true);
 INSERT INTO or_shipping_fee_ranges VALUES(0,NULL,50,1);
`)
const old = await readFile('supabase/migrations/515_order_fulfillment_conversion.sql', 'utf8')
await db.exec(old.slice(old.indexOf('CREATE OR REPLACE FUNCTION public.normalize_shop_pickup_tracking_number()'), old.indexOf('CREATE OR REPLACE FUNCTION public.pk_convert_self_pickup_to_shipping(')))
await db.exec(await readFile('supabase/migrations/628_sales_shipping_conversion.sql', 'utf8'))
await db.exec(await readFile('supabase/migrations/629_preserve_legacy_pickup_financial_snapshot.sql', 'utf8'))
const actors = {}
for (const role of ['sales-tr','packing_staff','production','account','admin','superadmin','sales-pump']) {
 const id = (await sql('SELECT gen_random_uuid() id')).rows[0].id
 actors[role] = id
 await sql('INSERT INTO auth.users VALUES($1)',[id]); await sql('INSERT INTO us_users VALUES($1,$2,$2,$2)',[id,role])
}
async function as(role, dbRole = 'authenticated') {
 await db.exec('RESET ROLE'); await sql("SELECT set_config('test.uid',$1,false)",[actors[role]])
 await db.exec(`SET ROLE ${dbRole}`)
}
async function bill(code='SHOPP', receipt=100) {
 await as('sales-tr')
 const { rows } = await sql("INSERT INTO or_orders(bill_no,channel_code,status,price,discount,shipping_cost,total_amount,payment_method,packing_meta,admin_user,work_order_name) VALUES(gen_random_uuid()::text,$1,'ใบงานกำลังผลิต',100,0,0,100,'โอน','{\"dailyPackingTag\":\"tag\",\"parcelScanned\":true}','sales-tr',gen_random_uuid()::text) RETURNING *",[code])
 if (receipt) await sql("INSERT INTO ac_verified_slips(order_id,verified_amount,validation_status,easyslip_trans_ref) VALUES($1,$2,'passed',gen_random_uuid()::text)",[rows[0].id,receipt])
 return rows[0]
}
const details = {recipient_name:'ผู้รับ',address_line:'1',sub_district:'สุเทพ',district:'เมืองเชียงใหม่',province:'เชียงใหม่',postal_code:'50200',mobile_phone:'0812345678',carrier:'FLASH'}
async function request(o,fee) { return (await sql('SELECT or_request_shipping_conversion($1,$2,$3,$4) id',[o.id,fee,details,'ลูกค้าขอจัดส่ง'])).rows[0].id }
async function rejects(s,p=[]) { await assert.rejects(() => sql(s,p)) }
async function pay(q,amount,ref=crypto.randomUUID()) {
 await as('sales-tr','service_role')
 return (await sql("SELECT or_record_shipping_payment($1,$2,$3,'slip-images/test','https://test.invalid/slip',$5,$4) ready",[q,ref,amount,actors['sales-tr'],{data:{date:'2026-10-06T12:00:00+07:00'}}])).rows[0].ready
}
async function row(o) { return (await sql('SELECT * FROM or_orders WHERE id=$1',[o.id])).rows[0] }
let passed=0
async function test(name,action) { await action(); passed++; console.log(`PASS ${name}`) }
await test('Pickup defaults, cost and address are normalized; tax address survives',async()=>{
 const o=await bill('OATR-P')
 await sql("UPDATE or_orders SET shipping_cost=30,total_amount=130,customer_address='shipping',tracking_number='123',billing_details='{\"address_line\":\"shipping\",\"tax_customer_address\":\"tax\"}' WHERE id=$1",[o.id])
 const x=await row(o); assert.equal(x.fulfillment_method,'self_pickup');assert.equal(Number(x.shipping_cost),0);assert.equal(Number(x.total_amount),100);assert.equal(x.customer_address,'');assert.equal(x.tracking_number,null);assert.equal(x.billing_details.tax_customer_address,'tax');assert.equal(x.billing_details.address_line,undefined)
})
await test('Packing/production cannot request or invoke legacy conversion',async()=>{
 const o=await bill()
 for(const role of ['packing_staff','production']) {await as(role);await rejects('SELECT or_request_shipping_conversion($1,50,$2,\'reason\')',[o.id,details]);await rejects("SELECT pk_convert_self_pickup_to_shipping($1,'a','a','a','a','a','a','a','a','a','a')",[o.id])}
})
await test('Pending request blocks direct conversion, scans, packing start and shipment',async()=>{
 const o=await bill();await sql('INSERT INTO pk_packing_unit_scans(order_id) VALUES($1)',[o.id]);const q=await request(o,50);assert(q);assert.equal((await row(o)).shipping_conversion_pending,true)
 await as('packing_staff')
 await rejects("UPDATE or_orders SET fulfillment_method='shipping' WHERE id=$1",[o.id]);await rejects('INSERT INTO pk_packing_unit_scans(order_id) VALUES($1)',[o.id]);await rejects('DELETE FROM pk_packing_unit_scans WHERE order_id=$1',[o.id]);await rejects("UPDATE or_orders SET status='จัดส่งแล้ว' WHERE id=$1",[o.id]);await rejects('SELECT pk_start_work_order_packing($1)',[o.work_order_name]);await rejects("UPDATE or_orders SET transport_meta='{\"customer_received\":true}' WHERE id=$1",[o.id])
})
await test('Partial receipts hold; full additional payment converts without losing product scans',async()=>{
 const o=await bill();await sql('INSERT INTO pk_packing_unit_scans(order_id) VALUES($1)',[o.id]);const q=await request(o,50)
 assert.equal(await pay(q,25),false);assert.equal(await pay(q,25),true)
 const x=await row(o);assert.equal(x.fulfillment_method,'shipping');assert.equal(x.shipping_conversion_pending,false);assert.equal(Number(x.total_amount),150);assert.equal(x.status,'ใบงานกำลังผลิต');assert.equal(Number((await sql("SELECT sum(verified_amount) total FROM ac_verified_slips WHERE order_id=$1 AND validation_status='passed'",[o.id])).rows[0].total),150);assert.equal(x.packing_meta.dailyPackingTag,'tag');assert.equal(x.packing_meta.parcelScanned,undefined);assert.equal(x.transport_meta.carrier,'FLASH');assert.equal(Number((await sql('SELECT count(*) n FROM pk_packing_unit_scans WHERE order_id=$1',[o.id])).rows[0].n),1)
 await rejects('UPDATE or_orders SET shipping_cost=0,total_amount=100 WHERE id=$1',[o.id])
})
await test('Zero fee requires privileged approval even with all goods paid',async()=>{
 const o=await bill();const q=await request(o,0);await as('sales-tr');await rejects("SELECT or_review_zero_shipping($1,true,'ok')",[q]);await rejects("UPDATE or_shipping_conversion_requests SET status='ready' WHERE id=$1",[q]);await rejects("SELECT or_record_shipping_payment($1,'fake',1,'path','url','{}',null)",[q]);await as('account');assert.equal((await sql("SELECT or_review_zero_shipping($1,true,'อนุมัติส่งฟรี') ready",[q])).rows[0].ready,true)
})
await test('Zero approval does not waive goods payment; admin and superadmin can approve',async()=>{
 for(const role of ['admin','superadmin']) {const o=await bill('OATR-P',0);const q=await request(o,0);await as(role);assert.equal((await sql("SELECT or_review_zero_shipping($1,true,'ok') ready",[q])).rows[0].ready,false);assert.equal((await row(o)).shipping_conversion_pending,true);assert.equal(await pay(q,100),true)}
})
await test('Reject and cancel release hold with audit reason; resubmission is allowed',async()=>{
 const o=await bill();const q=await request(o,0);await as('account');await sql("SELECT or_review_zero_shipping($1,false,'เหตุผลไม่เหมาะสม')",[q]);assert.equal((await row(o)).shipping_conversion_pending,false);await as('sales-tr');const q2=await request(o,50);await sql("SELECT or_cancel_shipping_conversion($1,'ลูกค้ารับเองเหมือนเดิม')",[q2]);assert.equal((await row(o)).fulfillment_method,'self_pickup')
})
await test('Existing slip reuse, cross-request reuse and reciprocal normal-slip reuse are blocked',async()=>{
 const a=await bill();const oldRef=(await sql('SELECT easyslip_trans_ref FROM ac_verified_slips WHERE order_id=$1',[a.id])).rows[0].easyslip_trans_ref;const q=await request(a,50)
 await assert.rejects(()=>pay(q,50,oldRef));const used=crypto.randomUUID();assert.equal(await pay(q,50,used),true)
 const b=await bill();const q2=await request(b,50);await assert.rejects(()=>pay(q2,50,used));await as('sales-tr');await rejects("INSERT INTO ac_verified_slips(order_id,verified_amount,validation_status,easyslip_trans_ref) VALUES($1,50,'passed',$2)",[b.id,used])
})
await test('Old overpayment is not reused as shipping; overpay and non-finite input fail',async()=>{
 const o=await bill('SHOPP',120);await sql("INSERT INTO ac_refunds(order_id,amount,status) VALUES($1,20,'approved')",[o.id]);const q=await request(o,50);await assert.rejects(()=>pay(q,51));assert.equal(await pay(q,50),true)
 const b=await bill();await rejects("SELECT or_request_shipping_conversion($1,'NaN'::numeric,$2,'reason')",[b.id,details]);const q2=await request(b,50);await assert.rejects(()=>pay(q2,'NaN'))
})
await test('Double requests, shipped/received bills, inactive/self carriers and missing address fail',async()=>{
 const o=await bill();await request(o,50);await rejects("SELECT or_request_shipping_conversion($1,50,$2,'reason')",[o.id,details]);const b=await bill();await sql("UPDATE or_orders SET status='จัดส่งแล้ว' WHERE id=$1",[b.id]);await rejects("SELECT or_request_shipping_conversion($1,0,$2,'reason')",[b.id,details]);const c=await bill();await sql("UPDATE or_orders SET transport_meta='{\"customer_received\":true}' WHERE id=$1",[c.id]);await rejects("SELECT or_request_shipping_conversion($1,0,$2,'reason')",[c.id,details]);const d=await bill();await rejects("SELECT or_request_shipping_conversion($1,50,$2,'reason')",[d.id,{...details,carrier:'SELF'}]);await rejects("SELECT or_request_shipping_conversion($1,50,$2,'reason')",[d.id,{...details,postal_code:''}])
})
await test('Quote includes specific special-area rule, ignores expired and unrelated channels',async()=>{
 const o=await bill();await sql("INSERT INTO or_shipping_area_rules VALUES('Flash Express',ARRAY['SHOPP'],'50200','เชียงใหม่','เมืองเชียงใหม่','สุเทพ',30,true,NULL,NULL,true)")
 await sql("INSERT INTO or_shipping_area_rules VALUES('FLASH',ARRAY['OTHER'],'50200','เชียงใหม่','เมืองเชียงใหม่','สุเทพ',888,true,NULL,NULL,true),('FLASH',ARRAY['SHOPP'],'50200','เชียงใหม่','เมืองเชียงใหม่','สุเทพ',999,false,'2020-01-01','2020-01-02',true)")
 assert.equal(Number((await sql('SELECT or_quote_conversion_shipping($1,$2) fee',[o.id,details])).rows[0].fee),80)
 const q=await request(o,0);assert.equal(Number((await sql('SELECT suggested_shipping_cost fee FROM or_shipping_conversion_requests WHERE id=$1',[q])).rows[0].fee),80)
})
await test('Supplemental proof is mirrored for accounting without double-counting unpaid goods',async()=>{
 const o=await bill('SHOPP',0);const q=await request(o,50);assert.equal(await pay(q,100),false);assert.equal((await row(o)).shipping_conversion_pending,true);assert.equal(await pay(q,50),true);await as('packing_staff');await rejects("UPDATE or_orders SET fulfillment_method='self_pickup' WHERE id=$1",[o.id])
})
await test('A later refund or deleted original receipt blocks packing/shipment again',async()=>{
 const o=await bill();const q=await request(o,50);assert.equal(await pay(q,50),true);await as('account');await sql("INSERT INTO ac_refunds(order_id,amount,status) VALUES($1,10,'pending')",[o.id]);assert.equal((await sql('SELECT or_refresh_shipping_conversion($1) result',[q])).rows[0].result.ready,false);await rejects("UPDATE or_orders SET status='จัดส่งแล้ว' WHERE id=$1",[o.id]);await rejects('INSERT INTO pk_packing_unit_scans(order_id) VALUES($1)',[o.id]);await rejects("UPDATE ac_verified_slips SET is_deleted=true WHERE order_id=$1 AND easyslip_trans_ref IN(SELECT trans_ref FROM or_shipping_conversion_payments WHERE request_id=$2)",[o.id,q])
})
await test('Legacy compensated pickup keeps shipping, discount and net total on status updates',async()=>{
 await db.exec('RESET ROLE; ALTER TABLE or_orders DISABLE TRIGGER trg_01_pickup_shipping_guard')
 const o=(await sql("INSERT INTO or_orders(bill_no,channel_code,status,price,discount,shipping_cost,total_amount,payment_method,admin_user) VALUES('legacy-compensated','SHOPP','ตรวจสอบแล้ว',35,30,30,35,'โอน','sales-tr') RETURNING *")).rows[0]
 await db.exec('ALTER TABLE or_orders ENABLE TRIGGER trg_01_pickup_shipping_guard')
 await as('packing_staff');await sql("UPDATE or_orders SET status='จัดส่งแล้ว',shipped_time=now() WHERE id=$1",[o.id])
 const x=await row(o);assert.equal(Number(x.shipping_cost),30);assert.equal(Number(x.discount),30);assert.equal(Number(x.total_amount),35)
 await as('account');await rejects('UPDATE or_orders SET shipping_cost=0,total_amount=5 WHERE id=$1',[o.id]);await rejects('UPDATE or_orders SET shipping_cost=0,discount=0 WHERE id=$1',[o.id]);assert.equal(Number((await row(o)).total_amount),35)
})
await test('Read-only recheck recognizes offset instead of extra collection',async()=>{
 const result=await sql(await readFile('scripts/audit_pickup_shipping.sql','utf8').then(s=>s.slice(s.indexOf('SELECT o.id'),s.indexOf('-- 2.'))))
 const legacy=result.rows.find(r=>r.bill_no==='legacy-compensated');assert(legacy);assert.equal(Number(legacy.total_difference),0);assert(legacy.audit_result.includes('ส่วนลดครอบคลุมค่าส่ง'))
})
console.log(`${passed} PostgreSQL integration scenarios passed`)
await db.close()
