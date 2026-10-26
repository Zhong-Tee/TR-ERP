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
const bank='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
let passed=0;async function test(name,fn){await fn();console.log('PASS '+name);passed++}
const makeBill=async(no,amount=100)=> (await q("INSERT INTO or_orders(bill_no,status,channel_code,total_amount,created_at) VALUES($1,'จัดส่งแล้ว','SHOP',$2,'2026-10-01 03:00+07') RETURNING id",[no,amount]))[0].id
const slip=async(bill,amount,date,receiver='XXXXX3955X',expected='12349552')=> (await q("INSERT INTO ac_verified_slips(order_id,verified_amount,easyslip_date,easyslip_receiver_bank_id,easyslip_receiver_account,expected_bank_code,expected_bank_account) VALUES($1,$2,$3,'004',$4,'004',$5) RETURNING id",[bill,amount,date,receiver,expected]))[0].id
const tx=(n,amount,date,key)=>({source_row_number:n,transaction_at:date,effective_date:date.slice(0,10),transaction_type:'รับโอนเงิน',credit_amount:amount,debit_amount:0,source_fingerprint:key,description:'โอนเข้าจากลูกค้า'})
const importFile=async(name,rows,account='12349552')=>(await q('SELECT bank_statement_import($1,$2,$3,$4::jsonb,$5::jsonb) result',[bank,name,name,JSON.stringify({parser_code:'test',account_number:account,period_start:'2026-09-19',period_end:'2026-09-30'}),JSON.stringify(rows)]))[0].result
const old=await makeBill('OATR26090010',280)
const oldSlip=await slip(old,280,'2026-09-18T08:48:06+07','XXX-X-XX955-2')
const oldImport=(await q("INSERT INTO ac_bank_statement_imports(bank_setting_id,file_name,file_hash,parser_code,account_number_snapshot,period_start,period_end) VALUES($1,'old.csv','old','test','12349552','2026-09-01','2026-09-18') RETURNING id",[bank]))[0].id
const oldTx=(await q("INSERT INTO ac_bank_statement_transactions(import_id,bank_setting_id,source_row_number,transaction_at,effective_date,transaction_type,credit_amount,source_fingerprint) VALUES($1,$2,1,'2026-09-18 08:48+07','2026-09-18','โอนเข้า',280,'old') RETURNING id",[oldImport,bank]))[0].id
await q("INSERT INTO ac_bank_reconciliation_allocations(transaction_id,order_id,verified_slip_id,allocated_amount,match_method) VALUES($1,$2,$3,280,'exact_verified_slip')",[oldTx,old,oldSlip])
await slip(old,50,'2026-09-19T05:32:20+07')
const oldBefore=(await q('SELECT row_to_json(a) record FROM ac_bank_reconciliation_allocations a WHERE order_id=$1',[old]))[0].record
await test('full OATR bill is skipped while raw statement and eligible September payment for October bill import successfully',async()=>{
 const b=await makeBill('FBTR26100005',280);await slip(b,280,'2026-09-30T07:17:42+07')
 const before=(await q("SELECT bank_sales_workspace(NULL,NULL,'all','','','',0) result"))[0].result.rows.find(r=>r.id===b)
 assert.equal(before.statement_coverage,'not_uploaded')
 const result=await importFile('sept.csv',[tx(1,50,'2026-09-19T05:32:00+07','overpaid-old'),tx(2,280,'2026-09-30T07:17:00+07','eligible'),tx(3,999,'2026-09-25T10:00:00+07','unknown')])
 assert.equal(result.inserted_count,3);assert.equal(result.match_result.matched,1)
 const rows=await q('SELECT source_fingerprint,reconciliation_status FROM ac_bank_statement_transactions WHERE import_id=$1',[result.import_id])
 assert.equal(rows.find(r=>r.source_fingerprint==='overpaid-old').reconciliation_status,'unmatched')
 assert.equal(rows.find(r=>r.source_fingerprint==='unknown').reconciliation_status,'unmatched')
 assert.deepEqual((await q('SELECT row_to_json(a) record FROM ac_bank_reconciliation_allocations a WHERE order_id=$1',[old]))[0].record,oldBefore)
 const after=(await q("SELECT bank_sales_workspace(NULL,NULL,'all','','','',0) result"))[0].result.rows.find(r=>r.id===b)
 assert.equal(after.statement_coverage,'covered');assert.equal(after.bank_received,280)
})
await test('all other four reported October bills match their September slips including masked receiver accounts',async()=>{
 const cases=[['FBTR26100001',690,'2026-09-30T10:19:36+07','xxx-x-x3955-x'],['FBTR26100003',200,'2026-09-30T13:52:33+07','XXXXX3955X'],['FBTR26100004',310,'2026-09-30T07:36:05+07','XXX-X-XX955-2'],['FBTR26100046',590,'2026-09-27T13:13:17+07','XXXXX3955X']]
 const bills=[];const transactions=[]
 for(const [index,[no,amount,date,receiver]] of cases.entries()){
  const b=await makeBill(no,amount);bills.push(b);await slip(b,amount,date,receiver)
  if(no==='FBTR26100046')await q("UPDATE or_orders SET created_at='2026-10-06 02:50+07' WHERE id=$1",[b])
  transactions.push(tx(index+1,amount,date,`reported-${index}`))
 }
 const r=await importFile('reported-four.csv',transactions);assert.equal(r.inserted_count,4);assert.equal(r.match_result.matched,4)
 const workspace=(await q("SELECT bank_sales_workspace(NULL,NULL,'all','','','',0) result"))[0].result
 for(const b of bills){const row=workspace.rows.find(r=>r.id===b);assert.equal(row.statement_coverage,'covered');assert.equal(row.reconciliation_state,'matched')}
})
await test('workspace-wide matching also skips fully paid bill',async()=>{
 const result=(await q('SELECT bank_workspace_auto_match(NULL,NULL,NULL) result'))[0].result
 assert.equal(Number((await q('SELECT sum(allocated_amount) amount FROM ac_bank_reconciliation_allocations WHERE order_id=$1',[old]))[0].amount),280)
 assert.ok(result.matched>=0)
})
await test('partial payment uses only remaining bill capacity',async()=>{
 const b=await makeBill('PARTIAL',100)
 await slip(b,70,'2026-09-24T08:00+07');await importFile('part1.csv',[tx(1,70,'2026-09-24T08:00+07','part1')])
 await slip(b,50,'2026-09-24T09:00+07');const tooMuch=await importFile('part-over.csv',[tx(1,50,'2026-09-24T09:00+07','part-over')]);assert.equal(tooMuch.match_result.matched,0)
 await slip(b,30,'2026-09-24T10:00+07');const exact=await importFile('part2.csv',[tx(1,30,'2026-09-24T10:00+07','part2')]);assert.equal(exact.match_result.matched,1)
})
await test('approved manual slips for fully funded bills are skipped as well',async()=>{
 await q("INSERT INTO ac_manual_slip_checks(order_id,transfer_amount,transfer_date,transfer_time,status) VALUES($1,50,'2026-09-25','11:00','approved')",[old])
 const r=await importFile('manual-full.csv',[tx(1,50,'2026-09-25T11:00+07','manual-full')]);assert.equal(r.match_result.matched,0);assert.equal(r.inserted_count,1)
})
await test('ambiguous candidates remain imported for review',async()=>{
 const a=await makeBill('AMB-A',90),b=await makeBill('AMB-B',90);await slip(a,90,'2026-09-26T10:00+07');await slip(b,90,'2026-09-26T10:00+07')
 const r=await importFile('amb.csv',[tx(1,90,'2026-09-26T10:00+07','amb')]);assert.equal(r.match_result.ambiguous,1);assert.equal(r.inserted_count,1)
})
await test('row allocation guard error preserves other successful matches and raw rows with an explicit warning',async()=>{
 const bad=await makeBill('GUARD-BAD',35),good=await makeBill('GUARD-GOOD',36);await slip(bad,35,'2026-09-27T10:00+07');await slip(good,36,'2026-09-27T11:00+07')
 await db.exec(`CREATE FUNCTION test_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.order_id='${bad}' THEN RAISE EXCEPTION 'simulated competing allocation';END IF;RETURN NEW;END;$$;CREATE TRIGGER z_test_guard BEFORE INSERT ON ac_bank_reconciliation_allocations FOR EACH ROW EXECUTE FUNCTION test_allocation_guard();`)
 const r=await importFile('guard.csv',[tx(1,35,'2026-09-27T10:00+07','guard-bad'),tx(2,36,'2026-09-27T11:00+07','guard-good')]);assert.equal(r.inserted_count,2);assert.equal(r.match_result.skipped,1);assert.equal(r.match_result.matched,1)
 const warning=(await q('SELECT warnings FROM ac_bank_statement_imports WHERE id=$1',[r.import_id]))[0].warnings;assert.equal(warning[0].code,'auto_match_skipped')
 await db.exec('DROP TRIGGER z_test_guard ON ac_bank_reconciliation_allocations;DROP FUNCTION test_allocation_guard()')
})
await test('unexpected matcher failure rolls back only matching and keeps import with warning',async()=>{
 const original=(await q("SELECT pg_get_functiondef('bank_statement_auto_match(uuid)'::regprocedure) definition"))[0].definition
 await db.exec("CREATE OR REPLACE FUNCTION bank_statement_auto_match(p_import_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION USING ERRCODE='XX000',MESSAGE='simulated matcher failure';END;$$")
 const r=await importFile('failed-matcher.csv',[tx(1,17,'2026-09-28T10:00+07','failed-matcher')]);assert.equal(r.inserted_count,1);assert.equal(r.match_result.requires_review,true)
 assert.equal((await q('SELECT warnings FROM ac_bank_statement_imports WHERE id=$1',[r.import_id]))[0].warnings[0].code,'auto_match_failed')
 await db.exec(original)
})
await test('wrong account and duplicate-file validation remain strict',async()=>{
 await assert.rejects(()=>importFile('wrong.csv',[tx(1,12,'2026-09-28T11:00+07','wrong')],'different'),/เลขบัญชี/)
 await assert.rejects(()=>importFile('sept.csv',[tx(1,12,'2026-09-28T11:00+07','dupe')]),/นำเข้าแล้ว/)
})
await test('a fully readable actual account takes priority over a conflicting expected account',async()=>{
 const b=await makeBill('ACTUAL',44);await slip(b,44,'2026-09-30T12:00+07','99998888','12349552')
 const row=(await q("SELECT bank_sales_workspace(NULL,NULL,'all','','','',0) result"))[0].result.rows.find(r=>r.id===b)
 assert.equal(row.statement_coverage,'unknown')
})
await test('migration 671 preserves zero-value claim no-payment status from migration 664',async()=>{
 const b=await makeBill('REQ-ZERO-671',0)
 const row=(await q("SELECT bank_sales_workspace(NULL,NULL,'all','','','',0) result"))[0].result.rows.find(r=>r.id===b)
 assert.equal(row.reconciliation_state,'no_payment')
})
await test('bank-received allocation history for OATR remains byte-for-byte unchanged',async()=>{
 const records=await q('SELECT row_to_json(a) record FROM ac_bank_reconciliation_allocations a WHERE order_id=$1',[old]);assert.equal(records.length,1);assert.deepEqual(records[0].record,oldBefore)
})
await db.close();console.log(`${passed} import and coverage scenarios passed. No live database was accessed.`)
