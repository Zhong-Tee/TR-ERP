// Isolated PostgreSQL checks; no live database or user records are modified.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'

const db = new PGlite()
try {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
    CREATE TABLE us_users(id uuid PRIMARY KEY,role text,username text,email text);
    INSERT INTO us_users VALUES
      ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','superadmin','root','root@example.test'),
      ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','account','account','account@example.test');
    CREATE TABLE or_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),status text,total_amount numeric,
      work_order_id uuid,work_order_name text,shipped_time timestamptz,channel_code text DEFAULT 'PUMP',
      payment_method text DEFAULT 'โอน',admin_user text DEFAULT 'root',requires_confirm_design boolean DEFAULT false);
    CREATE TABLE ac_manual_slip_checks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,
      status text,transfer_amount numeric,duplicate_of uuid,approved_order_total numeric,
      reviewed_by text DEFAULT 'original-reviewer',reviewed_at timestamptz DEFAULT '2026-10-31 04:46+00',rejected_reason text);
    CREATE TABLE ac_bank_reconciliation_allocations(order_id uuid);
    CREATE TABLE ac_order_receipt_certifications(order_id uuid,revoked_at timestamptz);
    CREATE TABLE ac_refunds(order_id uuid,status text,amount numeric);
  `)
  await db.exec(await fs.readFile('supabase/migrations/687_manual_slip_revoke_approval.sql','utf8'))
  const reuseSql = await fs.readFile('supabase/migrations/631_manual_payment_duplicate_and_edit_reuse.sql','utf8')
  await db.exec(reuseSql.slice(reuseSql.indexOf('CREATE OR REPLACE FUNCTION public.reuse_manual_payment_after_order_edit()'), reuseSql.indexOf('CREATE OR REPLACE FUNCTION public.or_guard_pickup_shipping()')))
  const q = async (sql,args=[]) => (await db.query(sql,args)).rows
  const actor = role => q("SELECT set_config('test.actor',$1,false)", [role === 'superadmin' ? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'])
  const make = async () => {
    const order = (await q("INSERT INTO or_orders(status,total_amount) VALUES('รอลงข้อมูล',400) RETURNING id"))[0].id
    const slips = await q("INSERT INTO ac_manual_slip_checks(order_id,status,transfer_amount,approved_order_total) VALUES($1,'approved',408,400) RETURNING id",[order])
    return { order, ids: slips.map(s => s.id) }
  }
  const revoke = (f, reason='ส่งตรวจยอดโอนเกินใหม่', ids=f.ids) => q('SELECT manual_slip_revoke_approval($1,$2::uuid[],$3) result',[f.order,ids,reason])
  let passed=0
  const test = async (name,fn) => { await fn(); passed++; console.log('PASS '+name) }

  await test('account cannot revoke via RPC or direct status update',async () => {
    const f=await make(); await actor('account')
    await assert.rejects(revoke(f),/เฉพาะ superadmin/)
    await assert.rejects(q("UPDATE ac_manual_slip_checks SET status='rejected' WHERE id=$1",[f.ids[0]]),/เฉพาะ superadmin/)
    await assert.rejects(q("UPDATE ac_manual_slip_checks SET status='pending' WHERE id=$1",[f.ids[0]]),/เฉพาะ superadmin/)
    assert.equal((await q('SELECT status FROM ac_manual_slip_checks WHERE id=$1',[f.ids[0]]))[0].status,'approved')
  })
  await actor('superadmin')
  await test('reason and current approved-slip snapshot are required', async () => {
    const f=await make()
    await assert.rejects(revoke(f,'  '),/กรุณาระบุเหตุผล/)
    await assert.rejects(revoke(f,'x',[]),/รายการสลิปเปลี่ยนแปลง/)
    await assert.rejects(revoke(f,'x',[f.ids[0],f.ids[0]]),/รายการสลิปเปลี่ยนแปลง/)
    await q("INSERT INTO ac_manual_slip_checks(order_id,status,transfer_amount) VALUES($1,'pending',1)",[f.order])
    await assert.rejects(revoke(f),/รายการรอตรวจ/)
  })
  await test('work orders, shipped/cancelled bills and financial links block revocation',async () => {
    for (const update of ["work_order_id=gen_random_uuid()", "work_order_name='WO1'", "shipped_time=now()", "status='จัดส่งแล้ว'", "status='ยกเลิก'"]) {
      const f=await make(); await q(`UPDATE or_orders SET ${update} WHERE id=$1`,[f.order])
      await assert.rejects(revoke(f),/เข้าใบงาน หรือจัดส่งแล้ว/)
    }
    for (const table of ['ac_bank_reconciliation_allocations','ac_order_receipt_certifications']) {
      const f=await make(); await q(`INSERT INTO ${table}(order_id) VALUES($1)`,[f.order])
      await assert.rejects(revoke(f),/กระทบยอดหรือรับรองเงินรับ/)
    }
  })
  await test('revocation is atomic, keeps original approval, audits actor and stops payment reuse', async () => {
    const before=await make()
    await q("UPDATE or_orders SET status='ลงข้อมูลเสร็จสิ้น' WHERE id=$1",[before.order])
    assert.equal((await q('SELECT status FROM or_orders WHERE id=$1',[before.order]))[0].status,'ไม่ต้องออกแบบ')
    const f=await make()
    const result=(await revoke(f))[0].result
    assert.equal(result.revoked_count,1); assert.equal(result.order_status,'รอลงข้อมูล')
    const row=(await q('SELECT * FROM ac_manual_slip_checks WHERE id=$1',[f.ids[0]]))[0]
    assert.equal(row.status,'rejected'); assert.equal(row.reviewed_by,'original-reviewer')
    assert.equal(new Date(row.reviewed_at).toISOString(),'2026-10-31T04:46:00.000Z')
    assert.equal(row.approval_revoked_by_name,'root'); assert.ok(row.approval_revoked_at)
    assert.equal(row.approval_revoked_reason,'ส่งตรวจยอดโอนเกินใหม่')
    await assert.rejects(revoke(f),/ไม่พบสลิปมือที่อนุมัติแล้ว/)
    await q("UPDATE or_orders SET status='ลงข้อมูลเสร็จสิ้น' WHERE id=$1",[f.order])
    assert.equal((await q('SELECT status FROM or_orders WHERE id=$1',[f.order]))[0].status,'ลงข้อมูลเสร็จสิ้น')
    await assert.rejects(q("UPDATE ac_manual_slip_checks SET approval_revoked_reason='changed' WHERE id=$1",[f.ids[0]]),/ไม่สามารถแก้ไขประวัติ/)
  })
  console.log(`${passed} integration checks passed`)
} finally {
  await db.close()
}
