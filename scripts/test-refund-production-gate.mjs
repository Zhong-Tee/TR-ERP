// Isolated PostgreSQL regression checks; never connects to production.
// npm install --prefix .tmp/refund-gate-test --no-save --package-lock=false @electric-sql/pglite
import { PGlite } from '../.tmp/refund-gate-test/node_modules/@electric-sql/pglite/dist/index.js'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const db = new PGlite()
const orderId='00000000-0000-0000-0000-000000000001'
const actorId='00000000-0000-0000-0000-000000000002'
const workId='00000000-0000-0000-0000-000000000003'
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE us_users(id uuid PRIMARY KEY,username text,email text,role text);
    CREATE TABLE or_orders(id uuid PRIMARY KEY,bill_no text NOT NULL,status text NOT NULL,total_amount numeric,
      work_order_id uuid,work_order_name text,shipped_time timestamptz);
    CREATE TABLE ac_refunds(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,status text,amount numeric,reason text,rejected_reason text,created_at timestamptz DEFAULT now());
    CREATE TABLE ac_verified_slips(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,verified_amount numeric,is_deleted boolean DEFAULT false);
    INSERT INTO us_users VALUES('${actorId}','test_admin',NULL,'superadmin');
    INSERT INTO or_orders VALUES('${orderId}','TEST-REFUND-GATE','ใบสั่งงาน',200,NULL,NULL,NULL);
    SELECT set_config('request.jwt.claim.sub','${actorId}',false);`)
  await db.exec(await fs.readFile(new URL('../supabase/migrations/648_refund_production_gate_and_status_history.sql',import.meta.url),'utf8'))
  const reason = async () => (await db.query('SELECT or_refund_production_block($1,200) reason',[orderId])).rows[0].reason
  const attemptAttach = async () => db.query('UPDATE or_orders SET work_order_id=$2,work_order_name=\'TEST-WO\' WHERE id=$1',[orderId,workId])
  assert.equal(await reason(),null)
  await db.query('INSERT INTO ac_verified_slips(order_id,verified_amount) VALUES($1,230)',[orderId])
  assert.match(await reason(),/พบยอดโอนเกิน/)
  await assert.rejects(attemptAttach(),/เข้าใบงานไม่ได้/)
  await db.query("INSERT INTO ac_refunds(order_id,status,amount,reason,created_at) VALUES($1,'pending',30,'โอนเกิน','2026-10-12T07:49:50Z')",[orderId])
  assert.match(await reason(),/รออนุมัติ/)
  await assert.rejects(attemptAttach(),/รออนุมัติ/)
  await db.query("UPDATE ac_refunds SET status='rejected',rejected_reason='แก้เหตุผล' WHERE order_id=$1",[orderId])
  assert.match(await reason(),/ถูกปฏิเสธ/)
  await assert.rejects(attemptAttach(),/ถูกปฏิเสธ/)
  await db.query("INSERT INTO ac_refunds(order_id,status,amount,reason,created_at) VALUES($1,'approved',29,'โอนเกิน','2026-10-12T09:17:03Z')",[orderId])
  assert.match(await reason(),/พบยอดโอนเกิน 1.00/)
  await db.query("UPDATE ac_refunds SET amount=30 WHERE order_id=$1 AND status='approved'",[orderId])
  assert.equal(await reason(),null)
  await attemptAttach()
  assert.equal((await db.query('SELECT count(*)::int n FROM or_work_order_refund_blocks(ARRAY[$1::uuid])',[orderId])).rows[0].n,0)
  assert.equal((await db.query("SELECT or_apply_payment_review_status($1,'รอตรวจคำสั่งซื้อ','overpayment_request') status",[orderId])).rows[0].status,'ใบสั่งงาน')
  await db.query("UPDATE or_orders SET status='จัดส่งแล้ว',shipped_time=now() WHERE id=$1",[orderId])
  assert.equal((await db.query("SELECT or_apply_payment_review_status($1,'ใบสั่งงาน','order_review') status",[orderId])).rows[0].status,'จัดส่งแล้ว')
  const history=(await db.query('SELECT event_type,source,actor_name FROM or_order_status_history ORDER BY created_at,id')).rows
  assert(history.some(r=>r.event_type==='preserved'&&r.source==='order_review'&&r.actor_name==='test_admin'))
  assert(history.some(r=>r.event_type==='changed'))
  await db.query("UPDATE or_orders SET status='ใบงานกำลังผลิต',shipped_time=NULL WHERE id=$1",[orderId])
  assert.equal((await db.query('SELECT status FROM or_orders WHERE id=$1',[orderId])).rows[0].status,'ใบงานกำลังผลิต')
  await db.query("UPDATE or_orders SET status='ยกเลิก' WHERE id=$1",[orderId])
  assert.equal((await db.query('SELECT status FROM or_orders WHERE id=$1',[orderId])).rows[0].status,'ยกเลิก')
  // Name-only work-order attachments are also guarded, not just the UUID RPC.
  await db.query("UPDATE or_orders SET work_order_id=NULL,work_order_name=NULL,status='ใบสั่งงาน' WHERE id=$1",[orderId])
  await db.query("INSERT INTO ac_refunds(order_id,status,amount,reason,created_at) VALUES($1,'pending',1,'โอนเกิน','2026-10-12T10:00:00Z')",[orderId])
  await assert.rejects(db.query("UPDATE or_orders SET work_order_name='LEGACY-WO' WHERE id=$1",[orderId]),/รออนุมัติ/)
  // Audit history is readable but cannot be forged by authenticated clients.
  await db.exec('GRANT SELECT,UPDATE ON or_orders TO authenticated; SET ROLE authenticated;')
  assert.equal((await db.query('SELECT count(*)::int n FROM or_order_status_history')).rows[0].n,history.length+3)
  await assert.rejects(db.query("INSERT INTO or_order_status_history(order_id,bill_no,requested_status,resulting_status,event_type,actor_name,source) VALUES($1,'FORGED','x','y','changed','fake','fake')",[orderId]),/permission denied/)
  console.log('PASS: overpayment without request, pending/rejected requests, resubmission approval, amount coverage, UUID/name-only admission, production/shipping preservation, explicit packing reset/cancellation, actor/source audit, and audit write permissions.')
} finally { await db.close() }
