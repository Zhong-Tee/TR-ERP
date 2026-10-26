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
const scalar = async sql => (await db.query(sql)).rows[0].value
const bill = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const bank = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const importId = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
await db.exec(`
 INSERT INTO or_orders(id,bill_no,status,channel_code,payment_method,total_amount,created_at)
 VALUES('${bill}','SHOP001','ตรวจสอบแล้ว','SHOP','เงินสด',100,'2026-10-01 10:00+07');
 INSERT INTO ac_bank_statement_imports(id,bank_setting_id,file_name,file_hash,parser_code,account_number_snapshot,period_start,period_end)
 VALUES('${importId}','${bank}','one.csv','one','test','12349552','2026-10-01','2026-10-07');
 INSERT INTO ac_bank_statement_transactions(import_id,bank_setting_id,source_row_number,transaction_at,effective_date,transaction_type,credit_amount,description,source_fingerprint)
 VALUES('${importId}','${bank}',1,'2026-10-01 10:00+07','2026-10-01','รับโอนเงิน',100,'Customer transfer','one');
`)
// The tracking cutoff uses Bangkok midnight and cannot be bypassed by an earlier filter.
await db.exec(`INSERT INTO or_orders(bill_no,status,channel_code,total_amount,created_at)
 VALUES('PRE-CUTOFF','ตรวจสอบแล้ว','OLD',999,'2026-09-30 23:59:59+07'),
 ('AT-CUTOFF','ตรวจสอบแล้ว','SHOP',10,'2026-10-01 00:00:00+07')`)
for (const start of ['NULL', "'2026-09-01'"]) {
 const scoped = await scalar(`SELECT bank_sales_workspace(${start},NULL,'all') value`)
 assert.equal(scoped.summary.bills, 2)
 assert.equal(scoped.summary.sales, 110)
 assert.equal(scoped.count, 2)
 assert.ok(scoped.rows.every(row => row.bill_no !== 'PRE-CUTOFF'))
 assert.deepEqual(scoped.channels, ['SHOP'])
}
assert.equal((await scalar(`SELECT bank_sales_workspace(NULL,'2026-09-30','all') value`)).count, 0)
await db.exec("DELETE FROM or_orders WHERE bill_no IN ('PRE-CUTOFF','AT-CUTOFF')")
// Marketplace bills are handled in Ecommerce, never counted in direct receipt tracking.
await db.exec(`INSERT INTO or_orders(bill_no,status,channel_code,total_amount,created_at)
 SELECT 'ECOM-' || channel,'จัดส่งแล้ว',channel,100,'2026-10-02 10:00+07'
 FROM unnest(ARRAY['SPTR','FSPTR','TTTR','LZTR','PGTR','WY']) channel`)
const direct = await scalar("SELECT bank_sales_workspace(NULL,NULL,'all') value")
assert.equal(direct.count, 1)
assert.equal(direct.summary.sales, 100)
assert.deepEqual(direct.channels, ['SHOP'])
assert.equal((await scalar("SELECT bank_sales_workspace(NULL,NULL,'all','','SPTR') value")).count, 0)
assert.equal(Number(await scalar("SELECT count(*) value FROM or_orders WHERE bill_no LIKE 'ECOM-%'")), 6)
await db.exec("DELETE FROM or_orders WHERE bill_no LIKE 'ECOM-%'")
let workspace = await scalar(`SELECT bank_sales_workspace() AS value`)
assert.equal(workspace.count, 1)
assert.equal(workspace.rows[0].reconciliation_state, 'no_evidence')
assert.equal(workspace.summary.outstanding, 100)
assert.equal((await scalar(`SELECT bank_sales_workspace('2026-10-02','2026-10-07') value`)).count, 0)
const receipt = await scalar(`SELECT bank_certify_receipt('${bill}',40,'cash','2026-10-01','cash drawer','receipt-1') value`)
workspace = await scalar('SELECT bank_sales_workspace() value')
assert.equal(workspace.rows[0].reconciliation_state, 'partial')
assert.equal(workspace.summary.certified, 40)
assert.equal(workspace.summary.bank, 0)
assert.equal(workspace.summary.cash, 40)
assert.deepEqual(workspace.channels, ['SHOP'])
assert.equal((await scalar(`SELECT bank_receipt_history('${bill}') value`))[0].actor, 'tester')
await assert.rejects(db.exec(`SELECT bank_certify_receipt('${bill}',61,'cash','2026-10-01','too much')`), /ยอดรับรองเกิน/)
await assert.rejects(db.exec(`SELECT bank_certify_receipt('${bill}',0.001,'cash','2026-10-01','invalid precision')`), /ถูกต้อง/)
await assert.rejects(db.exec(`SELECT bank_certify_receipt('${bill}',1,'cash','2999-01-01','future')`), /ถูกต้อง/)
await db.exec(`UPDATE us_users SET role='account'`)
await assert.rejects(db.exec(`SELECT bank_certify_receipt('${bill}',60,'cash','2026-10-01','unauthorized')`), /เฉพาะ superadmin/)
await assert.rejects(db.exec(`SELECT bank_revoke_receipt('${receipt}','unauthorized')`), /เฉพาะ superadmin/)
await db.exec(`UPDATE us_users SET role='superadmin'`)
await scalar(`SELECT bank_certify_receipt('${bill}',60,'other','2026-10-01','balance received') value`)
assert.equal((await scalar('SELECT bank_sales_workspace() value')).count, 0)
assert.equal((await scalar(`SELECT bank_sales_workspace(NULL,NULL,'certified') value`)).count, 1)
await db.exec(`SELECT bank_revoke_receipt('${receipt}','correction')`)
assert.equal((await scalar('SELECT bank_sales_workspace() value')).summary.outstanding, 40)
assert.equal(Number(await scalar(`SELECT count(*) value FROM ac_order_receipt_certifications`)), 2)
await assert.rejects(db.exec(`SELECT bank_revoke_receipt('${receipt}','second revoke')`), /ไม่พบการรับรอง/)
await assert.rejects(db.exec(`INSERT INTO ac_bank_reconciliation_allocations(transaction_id,order_id,allocated_amount,match_method)
 SELECT id,'${bill}',100,'manual_bill' FROM ac_bank_statement_transactions LIMIT 1`), /ไม่ให้นับเงินซ้ำ/)

// Literal wildcard handling, rule changes, disabled rules and audit.
const rule = (await scalar(`SELECT bank_reconciliation_save_rule(NULL,'literal','abc%','OTHER','${bank}',true) value`)).rule_id
await db.exec(`UPDATE ac_bank_statement_transactions SET description='abcXYZ'`)
assert.equal(await scalar(`SELECT reconciliation_status value FROM ac_bank_statement_transactions LIMIT 1`), 'unmatched')
await db.exec(`UPDATE ac_bank_statement_transactions SET description='abc% literal'`)
assert.equal(await scalar(`SELECT reconciliation_status value FROM ac_bank_statement_transactions LIMIT 1`), 'ignored')
await scalar(`SELECT bank_reconciliation_save_rule('${rule}','renamed','different','NEW','${bank}',true) value`)
assert.equal(await scalar(`SELECT reconciliation_status value FROM ac_bank_statement_transactions LIMIT 1`), 'unmatched')
await db.exec(`UPDATE ac_bank_statement_transactions SET description='different transfer'`)
await db.exec(`UPDATE ac_bank_transaction_rules SET is_active=false WHERE id='${rule}'`)
assert.equal(await scalar(`SELECT reconciliation_status value FROM ac_bank_statement_transactions LIMIT 1`), 'unmatched')
assert.ok(Number(await scalar(`SELECT count(*) value FROM ac_bank_classification_audit`)) >= 4)
const combined = await scalar(`SELECT bank_statement_workspace('2026-10-01','2026-10-07') value`)
assert.equal(combined.count, 1)
assert.equal(combined.summary.credit, 100)
assert.equal((await scalar(`SELECT bank_statement_workspace('2026-10-02','2026-10-07') value`)).count, 0)

// Nearby candidates and auto matching retain original timing and source linkage.
await db.exec(`
 INSERT INTO or_orders(id,bill_no,status,channel_code,payment_method,total_amount,created_at)
 VALUES('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','SHOP002','ตรวจสอบแล้ว','SHOP','โอน',200,'2026-10-02 12:00+07');
 INSERT INTO ac_verified_slips(order_id,verified_amount,easyslip_date,easyslip_receiver_bank_id,easyslip_receiver_account)
 VALUES('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',200,'2026-10-02 12:00+07','004','12349552');
 INSERT INTO ac_bank_statement_transactions(import_id,bank_setting_id,source_row_number,transaction_at,effective_date,transaction_type,credit_amount,description,source_fingerprint)
 VALUES('${importId}','${bank}',2,'2026-10-02 12:03+07','2026-10-02','รับโอนเงิน',200,'another customer','two');
`)
const tx = await scalar(`SELECT id value FROM ac_bank_statement_transactions WHERE source_fingerprint='two'`)
workspace = await scalar(`SELECT bank_sales_workspace(NULL,NULL,'waiting_bank') value`)
assert.equal(workspace.rows[0].statement_coverage, 'covered')
await db.exec(`UPDATE ac_bank_statement_imports SET period_end='2026-10-01'`)
assert.equal((await scalar(`SELECT bank_sales_workspace(NULL,NULL,'waiting_bank') value`)).rows[0].statement_coverage, 'not_uploaded')
await db.exec(`UPDATE ac_bank_statement_imports SET period_end='2026-10-07'`)
assert.equal((await scalar(`SELECT bank_workspace_diagnostics(ARRAY['${tx}'::UUID]) value`)).candidates[0].available_candidate_count, 1)
await scalar(`SELECT bank_workspace_auto_match('2026-10-02','2026-10-02','${bank}') value`)
assert.equal(await scalar(`SELECT reconciliation_status value FROM ac_bank_statement_transactions WHERE id='${tx}'`), 'matched')
assert.equal((await scalar(`SELECT bank_sales_workspace(NULL,NULL,'matched') value`)).count, 1)
// More than one page: totals must include rows on every page.
await db.exec(`INSERT INTO or_orders(bill_no,status,channel_code,payment_method,total_amount,created_at)
 SELECT 'B'||n,'ตรวจสอบแล้ว','SHOP','โอน',10,'2026-10-03 12:00+07' FROM generate_series(1,55) n`)
workspace = await scalar(`SELECT bank_sales_workspace('2026-10-03','2026-10-03') value`)
assert.equal(workspace.rows.length, 50)
assert.equal(workspace.count, 55)
assert.equal(workspace.summary.outstanding, 550)
assert.equal((await scalar(`SELECT bank_sales_workspace('2026-10-03','2026-10-03','pending','','','',50) value`)).rows.length, 5)
await db.exec(`INSERT INTO ac_bank_statement_transactions(import_id,bank_setting_id,source_row_number,transaction_at,effective_date,transaction_type,credit_amount,description,source_fingerprint)
 SELECT '${importId}','${bank}',n+10,'2026-10-03 10:00+07','2026-10-03','รับโอนเงิน',1,'regular customer','page-'||n FROM generate_series(1,105) n`)
const bankPage = await scalar(`SELECT bank_statement_workspace('2026-10-03','2026-10-03') value`)
assert.equal(bankPage.rows.length, 100)
assert.equal(bankPage.count, 105)
assert.equal(bankPage.summary.credit, 105)
assert.equal((await scalar(`SELECT bank_statement_workspace('2026-10-03','2026-10-03',NULL,'all','',100) value`)).rows.length, 5)
assert.equal(await scalar(`SELECT count(*) value FROM ac_bank_statement_transactions WHERE source_fingerprint LIKE 'page-%' AND reconciliation_status='ignored'`), 0)
await db.exec(`INSERT INTO ac_bank_statement_transactions(import_id,bank_setting_id,source_row_number,transaction_at,effective_date,transaction_type,debit_amount,description,source_fingerprint)
 SELECT '${importId}','${bank}',n+200,'2026-10-03 11:00+07','2026-10-03','เงินออก',1,'expense','debit-'||n FROM generate_series(1,110) n`)
assert.equal((await scalar(`SELECT bank_statement_workspace('2026-10-03','2026-10-03') value`)).count, 105)
assert.equal((await scalar(`SELECT bank_statement_workspace('2026-10-03','2026-10-03',NULL,'all','',0,true) value`)).count, 215)
// Even a superadmin cannot bypass the audit functions with a direct table write.
await db.exec(`GRANT USAGE ON SCHEMA auth TO authenticated; GRANT SELECT ON us_users TO authenticated; GRANT ALL ON ac_order_receipt_certifications TO authenticated; SET ROLE authenticated`)
await assert.rejects(db.exec(`INSERT INTO ac_order_receipt_certifications(order_id,amount,receipt_method,received_on,reason,certified_by) VALUES('${bill}',1,'cash','2026-10-01','direct write',auth.uid())`), /row-level security/)
await db.exec('RESET ROLE')
// REQ bills must retain the approved claim charge, including an explicit zero.
const reqZero = 'eeeeeeee-eeee-eeee-eeee-000000000001'
const reqPaid = 'eeeeeeee-eeee-eeee-eeee-000000000002'
const reqPending = 'eeeeeeee-eeee-eeee-eeee-000000000003'
await db.exec(`
 INSERT INTO or_orders(id,bill_no,status,channel_code,payment_method,price,shipping_cost,total_amount,created_at) VALUES
 ('${reqZero}','REQFBTR26100044','จัดส่งแล้ว','FBTR','โอน',55,30,85,'2026-10-10 10:00+07'),
 ('${reqPaid}','REQFBTR-PAID','ตรวจสอบแล้ว','FBTR','โอน',55,30,85,'2026-10-10 10:00+07'),
 ('${reqPending}','REQFBTR-PENDING','ตรวจสอบแล้ว','FBTR','โอน',69,30,99,'2026-10-10 10:00+07');
 INSERT INTO or_claim_requests(created_claim_order_id,status,proposed_snapshot,reviewed_at) VALUES
 ('${reqZero}','approved','{"order":{"price":0,"shipping_cost":0,"discount":0,"total_amount":0}}',now()),
 ('${reqPaid}','approved','{"order":{"price":25,"shipping_cost":10,"discount":5,"total_amount":30}}',now()),
 ('${reqPending}','pending','{"order":{"price":0,"shipping_cost":0,"total_amount":0}}',NULL);
`)
const beforeAllocations = await scalar('SELECT count(*) value FROM ac_bank_reconciliation_allocations')
const beforeClaimRepair = (await scalar("SELECT bank_sales_workspace(NULL,NULL,'all') value")).summary
await db.exec(await fs.readFile('supabase/migrations/664_approved_claim_receivable.sql','utf8'))
const reqRow = async (id, status='all') => (await scalar(`SELECT bank_sales_workspace(NULL,NULL,'${status}') value`)).rows.find(r => r.id===id)
assert.equal(Number((await reqRow(reqZero)).total_amount),0)
assert.equal((await reqRow(reqZero)).reconciliation_state,'no_payment')
assert.equal(await reqRow(reqZero,'pending'),undefined,'Free claims must not appear as outstanding work')
assert.equal((await scalar("SELECT bank_sales_workspace(NULL,NULL,'no_payment') value")).count,1)
assert.equal(Number((await reqRow(reqPaid)).total_amount),30)
assert.equal(Number((await reqRow(reqPending)).total_amount),99,'Unapproved proposals must not become receivables')
const afterClaimRepair = (await scalar("SELECT bank_sales_workspace(NULL,NULL,'all') value")).summary
assert.equal(Number(beforeClaimRepair.sales)-Number(afterClaimRepair.sales),140)
assert.equal(Number(beforeClaimRepair.outstanding)-Number(afterClaimRepair.outstanding),140)
const zeroAvailability = await scalar("SELECT bank_reconciliation_bill_match_availability('REQFBTR26100044') value")
assert.equal(Number(zeroAvailability.bill_amount),0)
assert.equal(Number(zeroAvailability.remaining_amount),0)
assert.equal(zeroAvailability.available,false)
assert.equal(Number((await scalar("SELECT bank_reconciliation_bill_match_availability('REQFBTR-PAID') value")).bill_amount),30)
const repair = await scalar(`SELECT previous_amounts value FROM ac_claim_financial_repairs WHERE order_id='${reqZero}'`)
assert.equal(Number(repair.total_amount),85,'Keep the incorrect old amount for audit')
assert.equal(Number(await scalar(`SELECT count(*) value FROM ac_claim_financial_repairs`)),2)
assert.equal(await scalar('SELECT count(*) value FROM ac_bank_reconciliation_allocations'),beforeAllocations)
await db.exec(`UPDATE or_orders SET price=55,shipping_cost=30,total_amount=85 WHERE id='${reqZero}'`)
assert.equal(Number((await reqRow(reqZero)).total_amount),0,'Regular form recalculation cannot overwrite an approved claim')
await assert.rejects(db.exec(`SELECT bank_certify_receipt('${reqZero}',85,'cash','2026-10-10','invalid charge')`),/ยอดค้าง/)
await assert.rejects(db.exec(`SELECT bank_certify_receipt('${reqPaid}',31,'cash','2026-10-10','too much')`),/ยอดค้าง/)
await db.exec(`SELECT bank_certify_receipt('${reqPaid}',30,'cash','2026-10-10','approved claim charge')`)
assert.equal((await reqRow(reqPaid)).reconciliation_state,'certified')
// A free claim with actual money received still needs overpayment review.
await db.exec(`INSERT INTO ac_order_receipt_certifications(order_id,amount,receipt_method,received_on,reason,certified_by)
 VALUES('${reqZero}',5,'cash','2026-10-10','unexpected receipt',auth.uid())`)
assert.equal((await reqRow(reqZero)).reconciliation_state,'overpaid')
// Reapproval updates the canonical bill only when the new claim is approved.
await db.exec(`UPDATE or_claim_requests SET proposed_snapshot='{"order":{"price":20,"shipping_cost":5,"discount":0,"total_amount":25}}' WHERE created_claim_order_id='${reqPending}'`)
assert.equal(Number((await reqRow(reqPending)).total_amount),99)
await db.exec(`UPDATE or_claim_requests SET status='approved',reviewed_at=now() WHERE created_claim_order_id='${reqPending}'`)
assert.equal(Number((await reqRow(reqPending)).total_amount),25)
await db.exec(`UPDATE or_claim_requests SET status='pending',proposed_snapshot='{"order":{"price":90,"shipping_cost":0,"total_amount":90}}' WHERE created_claim_order_id='${reqPending}';
 UPDATE or_orders SET price=90,total_amount=90 WHERE id='${reqPending}'`)
assert.equal(Number((await reqRow(reqPending)).total_amount),25,'Pending revisions retain the last approved bill charge')
await db.exec(`UPDATE or_claim_requests SET status='approved',reviewed_at=now() WHERE created_claim_order_id='${reqPending}'`)
assert.equal(Number((await reqRow(reqPending)).total_amount),90)
// Missing total can use approved components, while explicit zero is never replaced.
await db.exec(`UPDATE or_claim_requests SET proposed_snapshot='{"order":{"price":15,"shipping_cost":5,"discount":2}}' WHERE created_claim_order_id='${reqPending}'`)
assert.equal(Number((await reqRow(reqPending)).total_amount),18)
await db.exec(`UPDATE or_claim_requests SET proposed_snapshot='{"order":{"total_amount":0}}' WHERE created_claim_order_id='${reqPending}'`)
assert.equal(Number((await reqRow(reqPending)).total_amount),0)
assert.equal(Number(await scalar(`SELECT price value FROM or_orders WHERE id='${reqPending}'`)),0)
assert.equal(Number(await scalar(`SELECT shipping_cost value FROM or_orders WHERE id='${reqPending}'`)),0)
console.log('Passed: approved REQ repair/audit, zero-payment state, overpayment visibility, canonical claim amount, preserved pending revisions and reapproval synchronization.')
await db.close()
console.log('Passed: bill-first listing, date filters, pagination totals, partial receipts, superadmin-only certification/revocation, retained audit, double-count guard, literal rules, rule edit/disable recovery, combined bank rows, nearby candidates and automatic matching.')
