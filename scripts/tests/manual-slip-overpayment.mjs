import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
const db = new PGlite()
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid $$;
CREATE TABLE us_users(id uuid,role text); INSERT INTO us_users VALUES(auth.uid(),'account');
CREATE TABLE or_orders(id uuid PRIMARY KEY,bill_no text,status text,receivable_amount numeric);
CREATE TABLE ac_verified_slips(order_id uuid,verified_amount numeric,easyslip_date timestamptz,is_deleted boolean DEFAULT false,validation_status text);
CREATE TABLE ac_manual_slip_checks(order_id uuid,transfer_amount numeric,transfer_date text,transfer_time text,status text,duplicate_of uuid);
CREATE TABLE ac_refunds(order_id uuid,amount numeric,status text,reason text,refund_recipient_account_name text,refund_recipient_bank text,refund_recipient_account_number text,refund_recipient_reason text,refund_request_link text);
CREATE TABLE ac_overpayment_waivers(order_id uuid,status text);
CREATE FUNCTION or_approved_overpayment_amount(uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT coalesce(sum(amount),0) FROM ac_refunds WHERE order_id=$1 AND status='approved' $$;`)
await db.exec(await fs.readFile('supabase/migrations/20261112100000_manual_slip_overpayment.sql','utf8'))
const id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const q=async(sql,args=[])=>(await db.query(sql,args)).rows
await q("INSERT INTO or_orders VALUES($1,'TEST','ตรวจสอบแล้ว',85)",[id])
await q("INSERT INTO ac_verified_slips(order_id,verified_amount,validation_status) VALUES($1,85,'failed')",[id])
await q("INSERT INTO ac_manual_slip_checks VALUES($1,85,'2026-11-09','14:12','approved',NULL)",[id])
const paid=async()=>Number((await q('SELECT or_overpayment_paid($1) n',[id]))[0].n)
assert.equal(await paid(),85)
console.log('PASS failed EasySlip without date + approved manual counts once')
await q("UPDATE ac_verified_slips SET verified_amount=999,easyslip_date='2026-11-08T00:00:00Z' WHERE order_id=$1",[id])
assert.equal(await paid(),85)
console.log('PASS manual corrected amount/date overrides failed extraction')
await q("INSERT INTO ac_verified_slips VALUES($1,20,'2026-11-10T00:00:00Z',false,'passed')",[id])
assert.equal(await paid(),105)
let info=(await q('SELECT manual_slip_overpayment($1) info',[id]))[0].info
assert.equal(Number(info.amount),20)
console.log('PASS separate passed payment produces genuine excess')
const details={refund_recipient_account_name:'Test',refund_recipient_bank:'Test',refund_recipient_account_number:'123',refund_recipient_reason:'เกินจริง'}
await q('SELECT manual_slip_request_refund($1,$2)',[id,details])
assert.equal(Number((await q('SELECT amount FROM ac_refunds'))[0].amount),20)
await assert.rejects(q('SELECT manual_slip_request_refund($1,$2)',[id,details]),/รอพิจารณา/)
console.log('PASS refund amount calculated on server and duplicate pending rejected')
await q('DELETE FROM ac_refunds')
await q("UPDATE ac_verified_slips SET verified_amount=85,easyslip_date='2026-11-09T14:12:00+07',validation_status='passed' WHERE verified_amount=999")
assert.equal(await paid(),105)
console.log('PASS passed EasySlip/manual twins count once')
await q("INSERT INTO ac_manual_slip_checks VALUES($1,15,'2026-11-11','12:00','approved',NULL)",[id])
assert.equal(await paid(),120)
console.log('PASS multiple genuine manual payments remain additive')
await q("UPDATE ac_manual_slip_checks SET status='rejected' WHERE transfer_amount=15")
assert.equal(await paid(),105)
await q("UPDATE ac_verified_slips SET is_deleted=true WHERE verified_amount=85")
assert.equal(await paid(),105)
console.log('PASS revoked manual and deleted EasySlip do not duplicate active evidence')
await q("UPDATE ac_verified_slips SET is_deleted=true WHERE verified_amount=20")
assert.equal(await paid(),85)
await assert.rejects(q('SELECT manual_slip_request_refund($1,$2)',[id,details]),/ไม่พบยอดโอนเกิน/)
console.log('PASS exact payment cannot create refund request')
await q("UPDATE us_users SET role='sales-tr'")
await assert.rejects(q('SELECT manual_slip_request_refund($1,$2)',[id,details]),/ไม่มีสิทธิ์/)
console.log('PASS unauthorized refund rejected')
await q("UPDATE us_users SET role='account'")
await db.exec(`ALTER TABLE us_users ADD COLUMN username text,ADD COLUMN email text;
ALTER TABLE or_orders ADD COLUMN admin_user text,ADD COLUMN channel_code text,ADD COLUMN requires_confirm_design boolean;
ALTER TABLE ac_verified_slips ADD COLUMN created_at timestamptz DEFAULT now();
ALTER TABLE ac_manual_slip_checks ADD COLUMN reviewed_by text,ADD COLUMN reviewed_at timestamptz,ADD COLUMN rejected_reason text;
CREATE FUNCTION manual_slip_submission_eligibility(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"allowed":true}'::jsonb $$;`)
await q("INSERT INTO ac_manual_slip_checks(order_id,transfer_amount,transfer_date,transfer_time,status) VALUES($1,10,'2026-11-12','09:00','pending')",[id])
const decision=(await q("SELECT manual_slip_decide($1,'approved') result",[id]))[0].result
assert.equal(Number(decision.overpayment.amount),10)
assert.equal(decision.updated_count,1)
console.log('PASS approval atomically returns genuine excess for popup')
await db.close()
