// Isolated PostgreSQL integration tests. No live credentials or database connections.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'
const db = new PGlite()
process.on('uncaughtException', error => { console.error(error.stack, error.where || '', error.detail || ''); process.exit(1) })
await db.exec(`
 CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL AS $$ SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::UUID $$;
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
const q=async(sql,args=[])=>(await db.query(sql,args)).rows
try {
await db.exec(`
 ALTER TABLE us_users ADD COLUMN email text;
 ALTER TABLE or_orders ADD COLUMN admin_user text DEFAULT 'tester', ADD COLUMN work_order_id uuid,
  ADD COLUMN work_order_name text, ADD COLUMN shipped_time timestamptz, ADD COLUMN requires_confirm_design boolean DEFAULT false;
 ALTER TABLE ac_manual_slip_checks ADD COLUMN duplicate_of uuid;
 CREATE TABLE ac_refunds(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid REFERENCES or_orders(id),
  status text,amount numeric,reason text,rejected_reason text,created_at timestamptz DEFAULT now(),
  refund_slip_sent_at timestamptz,refund_slip_paths text[],refund_recipient_account_name text,
  refund_recipient_bank text,refund_recipient_account_number text,refund_recipient_reason text);
`)
for (const name of ['648_refund_production_gate_and_status_history','662_bank_overpayment_refund_matching','663_bank_auto_match_overpayment_refunds','688_overpayment_customer_waiver','689_optional_overpayment_waiver_evidence']) {
  await db.exec(await fs.readFile(`supabase/migrations/${name}.sql`,'utf8'))
}
const actor='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const bank='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
let n=0,passed=0
const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name)}
const fixture=async()=>{
 n++
 const date=`2026-10-${String(n).padStart(2,'0')}T05:28:00+07`
 const order=(await q("INSERT INTO or_orders(bill_no,status,channel_code,payment_method,total_amount) VALUES($1,'ตรวจสอบแล้ว','SHOP','โอน',400) RETURNING id",[`TEST-${n}`]))[0].id
 const slip=(await q("INSERT INTO ac_verified_slips(order_id,verified_amount,easyslip_date,easyslip_receiver_bank_id,easyslip_receiver_account,expected_bank_code,expected_bank_account) VALUES($1,408,$2,'004','12349552','004','12349552') RETURNING id",[order,date]))[0].id
 const imp=(await q("INSERT INTO ac_bank_statement_imports(bank_setting_id,file_name,file_hash,parser_code,account_number_snapshot,period_start,period_end) VALUES($1,$2,$2,'test','12349552','2026-10-01','2026-10-31') RETURNING id",[bank,`waiver-${n}`]))[0].id
 const tx=(await q("INSERT INTO ac_bank_statement_transactions(import_id,bank_setting_id,source_row_number,transaction_at,effective_date,transaction_type,credit_amount,source_fingerprint) VALUES($1,$2,1,$3,$4,'รับโอน',408,$5) RETURNING id",[imp,bank,date,date.slice(0,10),`waiver-tx-${n}`]))[0].id
 return {order,slip,imp,tx,date}
}
const submit=async f=>(await q("SELECT submit_overpayment_waiver($1,'ลูกค้ายืนยันไม่รับคืน','https://example.test/evidence') id",[f.order]))[0].id
const decide=(id,action='approved',reason=null)=>q('SELECT decide_overpayment_waiver($1,$2,$3)',[id,action,reason])
const block=async f=>(await q('SELECT or_refund_production_block($1,400) reason',[f.order]))[0].reason
const cap=async(f,amount=408)=>(await q('SELECT bank_auto_match_order_has_capacity($1,$2) allowed',[f.order,amount]))[0].allowed

await test('unresolved and pending waiver cannot enter production or auto-match 408 to 400',async()=>{
 const f=await fixture(); assert.match(await block(f),/โอนเกิน/); assert.equal(await cap(f),false)
 const id=await submit(f);assert.ok(id);assert.match(await block(f),/รอบัญชีรับรอง/);assert.equal(await cap(f),false)
 await assert.rejects(submit(f),/มีคำขอไม่รับเงินคืน/)
 await q("SELECT bank_statement_auto_match($1)",[f.imp])
 assert.equal((await q('SELECT count(*)::int n FROM ac_bank_reconciliation_allocations WHERE order_id=$1',[f.order]))[0].n,0)
})
await test('request requires reason and an authorized bill owner, and validates supplied links',async()=>{
 const f=await fixture()
 await assert.rejects(q("SELECT submit_overpayment_waiver($1,'','https://example.test')",[f.order]),/กรุณาระบุเหตุผล/)
 await assert.rejects(q("SELECT submit_overpayment_waiver($1,'x','javascript:alert(1)')",[f.order]),/ลิงก์หลักฐานให้ถูกต้อง/)
 await q("UPDATE us_users SET role='sales-pump' WHERE id=$1",[actor])
 await q("UPDATE or_orders SET admin_user='somebody-else' WHERE id=$1",[f.order])
 await assert.rejects(submit(f),/ไม่มีสิทธิ์จัดการบิล/)
 await q("UPDATE or_orders SET admin_user='tester' WHERE id=$1",[f.order])
 const id=await submit(f)
 await assert.rejects(decide(id),/เฉพาะบัญชี/)
 await q("UPDATE us_users SET role='superadmin' WHERE id=$1",[actor])
 await assert.rejects(decide(id,'rejected'),/เหตุผลที่ไม่อนุมัติ/)
})
await test('approved waiver resolves gate, auto-matches 408 and never creates a payout',async()=>{
 const f=await fixture(); const id=await submit(f); await decide(id)
 assert.equal(await block(f),null); assert.equal(await cap(f),true); assert.equal(await cap(f,409),false)
 await q('SELECT bank_statement_auto_match($1)',[f.imp])
 const allocations=await q('SELECT allocated_amount FROM ac_bank_reconciliation_allocations WHERE order_id=$1',[f.order])
 assert.equal(allocations.length,1); assert.equal(Number(allocations[0].allocated_amount),408)
 const info=(await q('SELECT bank_overpayment_refunds($1) info',[f.order]))[0].info
 assert.equal(Number(info.excess),8); assert.equal(Number(info.waived_amount),8); assert.equal(Number(info.remaining),0)
 assert.equal((await q('SELECT count(*)::int n FROM ac_refunds WHERE order_id=$1',[f.order]))[0].n,0)
 assert.equal(Number((await q('SELECT total_amount FROM or_orders WHERE id=$1',[f.order]))[0].total_amount),400)
 const auto=(await q('SELECT bank_auto_match_overpayment_refunds($1::uuid[]) info',[[f.order]]))[0].info
 assert.equal(Number(auto.waived_amounts[f.order]),8)
 await assert.rejects(q("INSERT INTO ac_refunds(order_id,status,amount,reason) VALUES($1,'pending',8,'โอนเกิน')",[f.order]),/คำขอไม่รับเงินคืน/)
 await assert.rejects(decide(id),/พิจารณาแล้ว/)
})
await test('approved refund still permits automatic 408 matching and refund pairing',async()=>{
 const f=await fixture()
 await q("INSERT INTO ac_refunds(order_id,status,amount,reason) VALUES($1,'approved',8,'โอนเกิน')",[f.order])
 assert.equal(await cap(f),true); assert.equal(await block(f),null)
 await assert.rejects(submit(f),/มีคำขอโอนคืน/)
 await q('SELECT bank_workspace_auto_match(NULL,NULL,$1)',[bank])
 assert.equal(Number((await q('SELECT allocated_amount FROM ac_bank_reconciliation_allocations WHERE order_id=$1',[f.order]))[0].allocated_amount),408)
 await q('SELECT bank_auto_match_overpayment_refunds($1::uuid[])',[[f.order]])
 assert.equal(Number((await q('SELECT bank_overpayment_refunds($1) info',[f.order]))[0].info.remaining),0)
})
await test('changed totals cannot be approved; rejection and resubmission retain audit history',async()=>{
 const f=await fixture(); const id=await submit(f)
 await q('UPDATE or_orders SET total_amount=399 WHERE id=$1',[f.order])
 await assert.rejects(decide(id),/ยอดบิลหรือยอดรับเปลี่ยนแปลง/)
 await decide(id,'rejected','ยอดเปลี่ยน ต้องยืนยันลูกค้าใหม่')
 assert.match(await block(f),/ถูกปฏิเสธ/)
 const next=await submit(f); assert.notEqual(next,id);await decide(next)
 const rows=await q('SELECT status,reviewed_by,reviewed_at FROM ac_overpayment_waivers WHERE order_id=$1',[f.order])
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r.reviewed_by===actor && r.reviewed_at))
 await q('UPDATE ac_verified_slips SET verified_amount=410 WHERE id=$1',[f.slip])
 assert.equal(Number((await q('SELECT or_approved_waiver_amount($1) amount',[f.order]))[0].amount),0)
 assert.equal(await cap(f,410),false)
 const replacement=await submit(f)
 assert.equal((await q('SELECT status FROM ac_overpayment_waivers WHERE id=$1',[next]))[0].status,'superseded')
 await decide(replacement)
 assert.equal(await cap(f,410),true)
})
await test('manual/EasySlip twins count once, manual-only approved receipt is supported',async()=>{
 const f=await fixture()
 await q("INSERT INTO ac_manual_slip_checks(order_id,status,transfer_amount,transfer_date,transfer_time) VALUES($1,'approved',408,$2,'05:28')",[f.order,f.date.slice(0,10)])
 assert.equal(Number((await q('SELECT or_overpayment_paid($1) amount',[f.order]))[0].amount),408)
 await q('UPDATE ac_verified_slips SET is_deleted=true WHERE id=$1',[f.slip])
 assert.equal(Number((await q('SELECT or_overpayment_paid($1) amount',[f.order]))[0].amount),408)
 const id=await submit(f);await decide(id);assert.equal(await block(f),null)
})
await test('authenticated clients cannot insert or approve waivers by direct table writes',async()=>{
 const f=await fixture();const id=await submit(f)
 await db.exec('GRANT SELECT ON or_orders TO authenticated; SET ROLE authenticated;')
 try {
   assert.equal((await q('SELECT id FROM ac_overpayment_waivers WHERE id=$1',[id])).length,1)
   await assert.rejects(q("UPDATE ac_overpayment_waivers SET status='approved' WHERE id=$1",[id]),/permission denied/)
   await assert.rejects(q("DELETE FROM ac_overpayment_waivers WHERE id=$1",[id]),/permission denied/)
 } finally { await db.exec('RESET ROLE') }
})
await test('rejected waiver can be corrected by choosing a refund without preserving an obsolete rejection',async()=>{
 const f=await fixture();const id=await submit(f);await decide(id,'rejected','หลักฐานไม่ครบ')
 await q("INSERT INTO ac_refunds(order_id,status,amount,reason,created_at) VALUES($1,'approved',8,'โอนเกิน',now()+interval '1 second')",[f.order])
 assert.equal(await block(f),null);assert.equal(await cap(f),true)
 assert.equal((await q('SELECT status FROM ac_overpayment_waivers WHERE id=$1',[id]))[0].status,'rejected')
})
await test('split payments of 400 and 8 match only within the approved overpayment limit',async()=>{
 const f=await fixture()
 await q('UPDATE ac_verified_slips SET verified_amount=400 WHERE id=$1',[f.slip])
 await q("INSERT INTO ac_verified_slips(order_id,verified_amount,easyslip_date,easyslip_receiver_bank_id,easyslip_receiver_account,expected_bank_code,expected_bank_account) VALUES($1,8,$2::timestamptz+interval '2 minutes','004','12349552','004','12349552')",[f.order,f.date])
 await q('UPDATE ac_bank_statement_transactions SET credit_amount=400 WHERE id=$1',[f.tx])
 await q("INSERT INTO ac_bank_statement_transactions(import_id,bank_setting_id,source_row_number,transaction_at,effective_date,transaction_type,credit_amount,source_fingerprint) VALUES($1,$2,2,$3::timestamptz+interval '2 minutes',$4,'รับโอน',8,$5)",[f.imp,bank,f.date,f.date.slice(0,10),`split-${n}`])
 const id=await submit(f);await decide(id)
 await q('SELECT bank_statement_auto_match($1)',[f.imp])
 const allocations=await q('SELECT allocated_amount FROM ac_bank_reconciliation_allocations WHERE order_id=$1',[f.order])
 assert.equal(allocations.length,2);assert.equal(allocations.reduce((sum,row)=>sum+Number(row.allocated_amount),0),408)
 assert.equal(await cap(f,8),false)
 const available=(await q('SELECT bank_reconciliation_bill_match_availability($1) info',[`TEST-${n}`]))[0].info
 assert.equal(available.available,false);assert.equal(Number(available.bill_amount),400);assert.equal(Number(available.allowed_amount),408)
})
await test('null, empty and whitespace evidence can be submitted and approved without creating refunds',async()=>{
 for (const evidence of [null,'','   ']) {
   const f=await fixture()
   const id=(await q("SELECT submit_overpayment_waiver($1,'ลูกค้าไม่รับคืน',$2) id",[f.order,evidence]))[0].id
   assert.equal((await q('SELECT evidence_url FROM ac_overpayment_waivers WHERE id=$1',[id]))[0].evidence_url,null)
   await decide(id);assert.equal(await block(f),null);assert.equal(await cap(f),true)
   assert.equal((await q('SELECT count(*)::int n FROM ac_refunds WHERE order_id=$1',[f.order]))[0].n,0)
 }
})
console.log(`${passed} overpayment integration scenarios passed. No live database accessed.`)
} finally { await db.close() }
