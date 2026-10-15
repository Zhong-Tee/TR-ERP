// Isolated database tests: no live database or credentials.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'

const db = new PGlite()
try {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL AS $$ SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::UUID $$;
    CREATE TABLE us_users(id UUID PRIMARY KEY,role TEXT);
    INSERT INTO us_users VALUES(auth.uid(),'account');
    CREATE FUNCTION bank_reconciliation_require_authorized_role() RETURNS VOID LANGUAGE plpgsql AS $$
    BEGIN IF NOT EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role IN ('account','superadmin')) THEN
      RAISE EXCEPTION 'unauthorized'; END IF; END $$;
    CREATE TABLE or_orders(id UUID PRIMARY KEY,total_amount NUMERIC,status TEXT);
    CREATE TABLE ac_refunds(id UUID PRIMARY KEY,order_id UUID REFERENCES or_orders(id),amount NUMERIC,status TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),refund_recipient_account_name TEXT,refund_recipient_bank TEXT,
      refund_recipient_account_number TEXT,refund_recipient_reason TEXT,refund_slip_paths TEXT[],refund_slip_sent_at TIMESTAMPTZ);
    CREATE TABLE ac_bank_reconciliation_allocations(order_id UUID,allocated_amount NUMERIC);
    CREATE TABLE ac_order_receipt_certifications(order_id UUID,amount NUMERIC,revoked_at TIMESTAMPTZ);
  `)
  await db.exec(await fs.readFile('supabase/migrations/662_bank_overpayment_refund_matching.sql', 'utf8'))
  const order = '11111111-1111-1111-1111-111111111111'
  const other = '22222222-2222-2222-2222-222222222222'
  const ids = [1,2,3,4,5].map(n => `bbbbbbbb-bbbb-bbbb-bbbb-${String(n).padStart(12,'0')}`)
  await db.exec(`
    INSERT INTO or_orders VALUES('${order}',200,'จัดส่งแล้ว'),('${other}',100,'จัดส่งแล้ว');
    INSERT INTO ac_bank_reconciliation_allocations VALUES('${order}',220),('${other}',100);
    INSERT INTO ac_order_receipt_certifications VALUES('${order}',10,NULL),('${order}',99,now());
    INSERT INTO ac_refunds(id,order_id,amount,status) VALUES
      ('${ids[0]}','${order}',10,'approved'),('${ids[1]}','${order}',20,'approved'),
      ('${ids[2]}','${order}',30,'rejected'),('${ids[3]}','${other}',10,'approved'),
      ('${ids[4]}','${order}',10,'pending');
  `)
  const info = async () => (await db.query(`SELECT bank_overpayment_refunds('${order}') value`)).rows[0].value
  const match = (id, remove=false, bill=order) => db.exec(`SELECT bank_match_overpayment_refund('${bill}','${id}',${remove})`)
  let data = await info()
  assert.equal(Number(data.excess),30)
  assert.equal(data.refunds.length,2, 'Only approved refunds from this bill are offered')
  await assert.rejects(match(ids[2]), /อนุมัติ/)
  await assert.rejects(match(ids[4]), /อนุมัติ/)
  await assert.rejects(match(ids[3]), /บิลเดียวกัน/)
  await assert.rejects(match(ids[3],false,other), /ยอดรับเกิน/)
  await match(ids[0])
  await assert.rejects(match(ids[0]), /ถูกจับคู่แล้ว/)
  data = await info()
  assert.equal(Number(data.matched_amount),10)
  assert.equal(Number(data.remaining),20)
  assert.equal(data.refunds.filter(r => !r.matched_at).length,1)
  await match(ids[1])
  assert.equal(Number((await info()).remaining),0)
  await match(ids[0],true)
  assert.equal(Number((await info()).remaining),10)
  await db.exec(`UPDATE ac_refunds SET amount=11 WHERE id='${ids[0]}'`)
  await assert.rejects(match(ids[0]), /ยอดรับเกิน/)
  await db.exec(`UPDATE us_users SET role='sales-tr'`)
  await assert.rejects(info(), /unauthorized/)
  await assert.rejects(match(ids[1],true), /unauthorized/)
  await db.exec(`UPDATE us_users SET role='superadmin'`)
  await match(ids[1],true)
  assert.equal(Number((await info()).matched_amount),0)
  const untouched = (await db.query(`SELECT sum(allocated_amount) amount FROM ac_bank_reconciliation_allocations WHERE order_id='${order}'`)).rows[0]
  assert.equal(Number(untouched.amount),220, 'Matching must not change incoming bank allocations')
  console.log('PASS: role checks, same bill, approval, duplicate protection, amount limits, unlink, and original receipts preserved')

  await db.exec(await fs.readFile('supabase/migrations/663_bank_auto_match_overpayment_refunds.sql', 'utf8'))
  const auto = async (bill=order) => (await db.query(`SELECT bank_auto_match_overpayment_refunds(ARRAY['${bill}']::UUID[]) value`)).rows[0].value
  await db.exec(`UPDATE ac_refunds SET amount=30.01 WHERE id='${ids[0]}'`)
  assert.equal((await auto()).matched_count,0, 'Amounts must match exactly, including cents')
  await db.exec(`UPDATE ac_refunds SET amount=30 WHERE id='${ids[0]}'`)
  let automatic = await auto()
  assert.equal(automatic.matched_count,1)
  assert.equal(Number(automatic.amounts[order]),30)
  assert.equal((await auto()).matched_count,0, 'Refreshing must not duplicate a pair')
  await match(ids[0],true)
  assert.equal((await auto()).matched_count,0, 'Manual unlink must survive automatic refresh')
  await match(ids[0])
  assert.equal(Number((await info()).matched_amount),30, 'An excluded refund can still be selected manually')
  await match(ids[0],true)
  await db.exec(`DELETE FROM ac_bank_refund_auto_match_exclusions;
    UPDATE ac_refunds SET amount=30 WHERE id='${ids[1]}'`)
  assert.equal((await auto()).matched_count,0, 'Two equal refunds must be left for manual selection')
  await db.exec(`UPDATE ac_refunds SET status='pending' WHERE id='${ids[1]}'`)
  assert.equal((await auto()).matched_count,1, 'Pending and rejected refunds are not automatic candidates')
  await match(ids[0],true)
  await db.exec(`DELETE FROM ac_bank_refund_auto_match_exclusions;
    UPDATE ac_refunds SET amount=10 WHERE id='${ids[0]}';
    UPDATE ac_refunds SET amount=20,status='approved' WHERE id='${ids[1]}'`)
  await match(ids[0])
  assert.equal((await auto()).matched_count,1, 'Match the remaining overpayment after an earlier partial pair')
  assert.equal(Number((await info()).remaining),0)
  assert.equal((await auto(other)).matched_count,0, 'An equal refund on another bill cannot consume this overpayment')
  await db.exec(`UPDATE us_users SET role='sales-tr'`)
  await assert.rejects(auto(), /unauthorized/)
  await assert.rejects(match(ids[0],true), /unauthorized/)
  await db.exec(`UPDATE us_users SET role='account'`)
  await match(ids[0],true)
  await match(ids[1],true)
  await db.exec(`DELETE FROM ac_bank_refund_auto_match_exclusions;
    UPDATE ac_refunds SET amount=30 WHERE id='${ids[0]}';
    UPDATE or_orders SET status='ยกเลิก' WHERE id='${order}'`)
  assert.equal((await auto()).matched_count,0, 'Cancelled bills must not be auto matched')
  await assert.rejects(db.query(`SELECT bank_auto_match_overpayment_refunds(array_fill('${order}'::UUID,ARRAY[51]))`), /50/)
  assert.equal(Number((await db.query(`SELECT sum(allocated_amount) amount FROM ac_bank_reconciliation_allocations WHERE order_id='${order}'`)).rows[0].amount),220)
  console.log('PASS: automatic exact matching, cents, ambiguity, repeat refresh, manual exclusions, remaining balance, role and cancelled-bill guards')
} finally { await db.close() }
