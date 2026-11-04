import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
process.on('uncaughtException',e=>{console.error(e.message,e.where || '');process.exit(1)})
const db=new PGlite()
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
CREATE TABLE us_users(id uuid PRIMARY KEY,username text,email text,role text);
CREATE TABLE bill_header_settings(id uuid PRIMARY KEY,bill_code text);
CREATE TABLE st_user_menus(role text,menu_key text,menu_name text,has_access boolean,UNIQUE(role,menu_key));
CREATE TABLE or_orders(created_at timestamptz DEFAULT now(),id uuid PRIMARY KEY,bill_no text,status text,admin_user text,total_amount numeric,price numeric,shipping_cost numeric,discount numeric,billing_details jsonb,work_order_id uuid,work_order_name text);
CREATE TABLE ac_verified_slips(id uuid DEFAULT gen_random_uuid(),order_id uuid,is_deleted boolean,validation_status text);
CREATE SCHEMA storage;
CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(),bucket_id text,name text);
CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array($1,'/') $$;
`)
for(const file of ['690_tax_workflow.sql','691_tax_invoice_numbering.sql']) await db.exec(readFileSync(`supabase/migrations/${file}`,'utf8'))
const actor='10000000-0000-0000-0000-000000000001',sales='10000000-0000-0000-0000-000000000002',head='20000000-0000-0000-0000-000000000001'
const ids=[1,2,3,4,5].map(n=>`30000000-0000-0000-0000-${String(n).padStart(12,'0')}`)
await db.query(`INSERT INTO us_users VALUES ($1,'acc','acc@test','account'),($2,'seller','seller@test','sales-tr'); INSERT INTO bill_header_settings VALUES ($3,'TR')`,[actor,sales,head]).catch(async()=>{
 await db.query(`INSERT INTO us_users VALUES ($1,'acc','acc@test','account'),($2,'seller','seller@test','sales-tr')`,[actor,sales]);await db.query('INSERT INTO bill_header_settings VALUES($1,\'TR\')',[head])
})
await db.exec(`INSERT INTO st_user_menus VALUES('account','account-tax-invoice','tax',true);`)
const identity={request_tax_invoice:true,tax_customer_name:'บริษัททดสอบ',tax_id:'0103563005345',tax_customer_address:'ที่อยู่ทดสอบ'}
for(const id of ids) await db.query(`INSERT INTO or_orders(id,bill_no,status,admin_user,total_amount,price,shipping_cost,discount,billing_details) VALUES($1,$2,'ตรวจสอบแล้ว','seller',1070,1000,70,0,$3)`,[id,id,{...identity,...(id===ids[0]?{withholding_requested:true}:{})}])
const uid=async id=>db.query(`SELECT set_config('test.uid',$1,false)`,[id])
const action=async(id,kind,a,p={})=>{
 const current=(await db.query('SELECT billing_details,total_amount FROM or_orders WHERE id=$1',[id])).rows[0]
 return db.query(`SELECT or_tax_action($1,$2,$3,$4)`,[id,kind,a,{expected_details:current.billing_details,expected_total:current.total_amount,...p}])
}
let assertions=0
async function denied(fn,pattern){await assert.rejects(fn,pattern);assertions++}
await uid(sales)
await denied(()=>action(ids[0],'invoice','approve'),/ไม่มีสิทธิ์เมนู|เฉพาะบัญชี/)
await uid(actor)
await denied(()=>db.query(`UPDATE or_orders SET work_order_name='W1' WHERE id=$1`,[ids[0]]),/รอบัญชี/)
await denied(()=>db.query(`UPDATE or_orders SET billing_details=billing_details||'{"account_confirmed_tax":true}' WHERE id=$1`,[ids[0]]),/ผ่านขั้นตอน TAX/)
await action(ids[0],'invoice','reject',{reason:'แก้ชื่อ'})
await uid(sales)
await action(ids[0],'invoice','resubmit',{tax_customer_name:'บริษัททดสอบ',tax_id:'0103563005345',tax_customer_address:'ที่อยู่ทดสอบ'})
await uid(actor)
await action(ids[0],'invoice','approve')
await denied(()=>db.query(`UPDATE or_orders SET work_order_name='W1' WHERE id=$1`,[ids[0]]),/หัก ณ ที่จ่าย/)
await action(ids[0],'withholding','approve')
await db.query(`UPDATE or_orders SET work_order_name='W1' WHERE id=$1`,[ids[0]])
assert.equal((await db.query(`SELECT receivable_amount,total_amount FROM or_orders WHERE id=$1`,[ids[0]])).rows[0].receivable_amount,'1040.00');assertions++
await db.query(`INSERT INTO ac_verified_slips(order_id,is_deleted,validation_status) VALUES($1,false,'passed')`,[ids[1]])
await denied(()=>db.query(`UPDATE or_orders SET billing_details=billing_details||'{"withholding_requested":true}' WHERE id=$1`,[ids[1]]),/EasySlip/)
for(const id of [ids[1],ids[2]]) await action(id,'invoice','approve')
const snapshot={customerName:identity.tax_customer_name,customerTaxId:identity.tax_id,customerAddress:identity.tax_customer_address,grandTotal:1070}
const issue=async id=>(await db.query(`SELECT (or_issue_tax_invoice($1,$2,'2026-11-04',$3,'FA-1')).*`,[id,head,snapshot])).rows[0]
const a=await issue(ids[1]),b=await issue(ids[2]),same=await issue(ids[1])
assert.equal(a.invoice_no,'TRIV26110001');assert.equal(b.invoice_no,'TRIV26110002');assert.equal(same.invoice_no,a.invoice_no);assertions+=3
await denied(()=>db.query(`UPDATE or_orders SET total_amount=1080 WHERE id=$1`,[ids[1]]),/ออกใบกำกับแล้ว/)
await denied(()=>db.query(`UPDATE or_orders SET billing_details=billing_details||'{"tax_customer_name":"changed"}' WHERE id=$1`,[ids[1]]),/TAX เท่านั้น/)
await db.query(`SELECT or_tax_flow_reference($1,'FA-NEW')`,[ids[1]])
assert.equal((await db.query('SELECT flow_account_reference FROM or_tax_invoices WHERE order_id=$1',[ids[1]])).rows[0].flow_account_reference,'FA-NEW');assertions++
await uid(sales)
await denied(()=>issue(ids[3]),/เฉพาะบัญชี/)

// Load the actual payment function replacements against minimal legacy tables.
await db.exec(`
CREATE TABLE ac_bank_reconciliation_allocations(id uuid DEFAULT gen_random_uuid(),order_id uuid,allocated_amount numeric);
CREATE TABLE ac_order_receipt_certifications(id uuid DEFAULT gen_random_uuid(),order_id uuid,amount numeric,receipt_method text,received_on date,reason text,evidence_reference text,certified_by uuid,revoked_at timestamptz);
CREATE TABLE ac_manual_slip_checks(id uuid DEFAULT gen_random_uuid(),order_id uuid,transfer_amount numeric,transfer_date text,transfer_time text,status text,duplicate_of uuid,approved_order_total numeric);
CREATE TABLE ac_refunds(id uuid DEFAULT gen_random_uuid(),order_id uuid,amount numeric,status text,reason text,rejected_reason text,created_at timestamptz);
CREATE TABLE ac_overpayment_waivers(id uuid DEFAULT gen_random_uuid(),order_id uuid,amount numeric,status text,order_total numeric,paid_amount numeric,invalidated_at timestamptz,rejected_reason text,created_at timestamptz);
CREATE FUNCTION bank_reconciliation_require_authorized_role() RETURNS void LANGUAGE plpgsql AS $$BEGIN RETURN; END$$;
CREATE FUNCTION or_overpayment_paid(uuid) RETURNS numeric LANGUAGE sql STABLE AS $$SELECT 0::numeric$$;
CREATE FUNCTION or_approved_overpayment_amount(uuid) RETURNS numeric LANGUAGE sql STABLE AS $$SELECT 0::numeric$$;
`)
await db.exec(readFileSync('supabase/migrations/692_tax_receivable_payment_paths.sql','utf8'))
await uid(actor)
const availability=(await db.query(`SELECT bank_reconciliation_bill_match_availability($1) info`,[ids[0]])).rows[0].info
assert.equal(availability.bill_amount,1040);assertions++
assert.equal((await db.query(`SELECT bank_auto_match_order_has_capacity($1,1040) ok`,[ids[0]])).rows[0].ok,true);assertions++
assert.equal((await db.query(`SELECT bank_auto_match_order_has_capacity($1,1070) ok`,[ids[0]])).rows[0].ok,false);assertions++
await db.exec(`CREATE TRIGGER test_manual BEFORE INSERT ON ac_manual_slip_checks FOR EACH ROW EXECUTE FUNCTION guard_manual_payment_identity()`)
await db.query(`INSERT INTO ac_manual_slip_checks(order_id,transfer_amount,transfer_date,transfer_time,status) VALUES($1,1040,'2026-11-04','09:00','approved')`,[ids[0]])
assert.equal((await db.query('SELECT approved_order_total FROM ac_manual_slip_checks WHERE order_id=$1',[ids[0]])).rows[0].approved_order_total,'1040.00');assertions++
await denied(()=>db.query(`SELECT bank_certify_receipt($1,1070,'cash','2026-11-04','test',null)`,[ids[0]]),/superadmin/)
await db.query(`UPDATE us_users SET role='superadmin' WHERE id=$1`,[actor])
await denied(()=>db.query(`SELECT bank_certify_receipt($1,1070,'cash','2026-11-04','test',null)`,[ids[0]]),/เกินยอดค้าง/)
await db.query(`SELECT bank_certify_receipt($1,1040,'cash','2026-11-04','test',null)`,[ids[0]])
assert.equal((await db.query(`SELECT bank_auto_match_order_has_capacity($1,1) ok`,[ids[0]])).rows[0].ok,false);assertions++
await db.exec(readFileSync('supabase/migrations/694_tax_queue.sql','utf8'))
const queue=(await db.query(`SELECT or_tax_queue('invoice','issued','',0) result`)).rows[0].result
assert.equal(queue.total,2);assertions++

// Exercise address relationship checks and receipt ownership.
await db.exec(`CREATE TABLE thai_provinces(id bigint,name_th text);CREATE TABLE thai_districts(id bigint,name_th text,province_id bigint);CREATE TABLE thai_sub_districts(id bigint,name_th text,district_id bigint,zip_code text);CREATE TABLE thai_sub_district_postal_aliases(sub_district_id bigint,zip_code text);INSERT INTO thai_provinces VALUES(10,'กรุงเทพมหานคร');INSERT INTO thai_districts VALUES(1001,'บางแค',10);INSERT INTO thai_sub_districts VALUES(100101,'หลักสอง',1001,'10160');`)
const structured={...identity,tax_address:{sub_district:'หลักสอง',district:'บางแค',province:'กรุงเทพมหานคร',postal_code:'10160'}}
await db.query('SELECT or_tax_validate($1)',[structured]);assertions++
await denied(()=>db.query('SELECT or_tax_validate($1)',[{...structured,tax_address:{...structured.tax_address,postal_code:'99999'}}]),/ไม่สัมพันธ์/)
await denied(()=>db.query('SELECT or_tax_validate($1)',[{...identity,tax_id:'0103563005344'}]),/เลขตรวจสอบ/)
await db.query(`INSERT INTO storage.objects(bucket_id,name) VALUES('tax-evidence',$1)`,[`${ids[1]}/document.pdf`])
await denied(()=>action(ids[0],'withholding','received',{reference:'W1',date:'2026-11-04',file_path:`${ids[1]}/document.pdf`}),/ไม่พบไฟล์แนบของบิลนี้/)
await db.query(`INSERT INTO storage.objects(bucket_id,name) VALUES('tax-evidence',$1)`,[`${ids[0]}/document.pdf`])
await action(ids[0],'withholding','received',{reference:'W1',date:'2026-11-04',file_path:`${ids[0]}/document.pdf`})
await denied(()=>action(ids[0],'withholding','received',{reference:'W1',date:'2026-11-04',file_path:`${ids[0]}/document.pdf`}),/บันทึกรับเอกสารแล้ว/)
await denied(()=>action(ids[3],'invoice','approve',{expected_details:{}}),/ข้อมูลเปลี่ยนแล้ว/)
await action(ids[3],'invoice','approve')
await db.exec(`SELECT set_config('app.tax_write','yes',false)`)
await db.query(`UPDATE or_orders SET billing_details=billing_details||$1 WHERE id=$2`,[{account_confirmed_tax:true,account_confirmed_tax_at:'2026-11-04T00:00:00Z'},ids[4]])
await db.exec(`SELECT set_config('app.tax_write','',false)`)
await denied(()=>issue(ids[3]),/ตรวจทะเบียน/)
await db.query(`SELECT or_tax_initialize_series($1,$2,'2611',42,'checked existing register')`,[ids[3],head])
assert.equal((await issue(ids[3])).invoice_no,'TRIV26110043');assertions++
await denied(()=>db.query(`SELECT or_tax_initialize_series($1,$2,'2611',1,'invalid decrease')`,[ids[3],head]),/ห้ามลดเลข/)
assert.equal((await db.query('SELECT count(*) n FROM or_tax_invoices WHERE order_id=$1',[ids[4]])).rows[0].n,0);assertions++
const otherSales='10000000-0000-0000-0000-000000000003'
await db.query(`INSERT INTO us_users VALUES($1,'other','other@test','sales-pump')`,[otherSales])
await uid(otherSales)
assert.equal((await db.query(`SELECT or_tax_queue('sales','pending','',0) result`)).rows[0].result.total,0);assertions++
await denied(()=>action(ids[3],'invoice','resubmit',identity),/ไม่มีสิทธิ์จัดการบิลนี้/)
console.log(`PASS: ${assertions} PostgreSQL workflow/payment assertions; no external database used`)
await db.close()
