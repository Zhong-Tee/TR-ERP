import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
const db = new PGlite()
const fixture = await readFile('scripts/tests/shipping-conversion.mjs','utf8')
await db.exec(fixture.split('await db.exec(`')[1].split('`)')[0])
await db.exec(`
 ALTER TABLE or_orders ADD COLUMN work_order_id uuid, ADD COLUMN requires_confirm_design boolean;
 CREATE TABLE ac_manual_slip_checks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,bill_no text,
 transfer_date text,transfer_time text,transfer_amount numeric,status text,cancelled_at timestamptz,rejected_reason text);
 INSERT INTO us_users VALUES(gen_random_uuid(),'sales-tr','Ta_AM_TR','ta@example.test');
 INSERT INTO or_orders(id,bill_no,channel_code,status,fulfillment_method,requires_confirm_design,admin_user,price,shipping_cost,discount,total_amount)
 VALUES('0599b759-237d-42af-a4db-4249e70fe4b1','SHOPP26100005','SHOPP','ลงข้อมูลผิด','self_pickup',false,'Ta_AM_TR',2310,30,261,2079);
 INSERT INTO ac_manual_slip_checks(id,order_id,transfer_date,transfer_time,transfer_amount,status) VALUES
 ('e0a5ae14-60ac-4b52-b2e9-284e386b447f','0599b759-237d-42af-a4db-4249e70fe4b1','2026-10-06','17:30',2079,'approved'),
 ('e62533f5-9fe8-480d-b205-eecf2659e1db','0599b759-237d-42af-a4db-4249e70fe4b1','2026-10-06','17:30',2079,'approved');
`)
for(const name of ['628_sales_shipping_conversion','629_preserve_legacy_pickup_financial_snapshot','631_manual_payment_duplicate_and_edit_reuse'])
 await db.exec(await readFile(`supabase/migrations/${name}.sql`,'utf8'))
await db.exec(await readFile('scripts/repair_shopp26100005_duplicate_and_discount.sql','utf8'))
const bill = async () => (await db.query("SELECT * FROM or_orders WHERE bill_no='SHOPP26100005'")).rows[0]
assert.equal(Number((await bill()).total_amount),2079)
assert.equal(Number((await bill()).shipping_cost),0)
assert.equal(Number((await bill()).discount),231)
assert.equal((await bill()).status,'ลงข้อมูลผิด')
assert.equal(Number((await db.query("SELECT sum(transfer_amount) amount FROM ac_manual_slip_checks WHERE status='approved'")).rows[0].amount),2079)
assert.equal((await db.query('SELECT count(*) n FROM ac_manual_slip_checks')).rows[0].n,2)
await assert.rejects(db.exec("INSERT INTO ac_manual_slip_checks(order_id,transfer_date,transfer_time,transfer_amount,status) VALUES('0599b759-237d-42af-a4db-4249e70fe4b1','2026-10-06','17:30',2079,'pending')"),/ห้ามส่งหรืออนุมัติซ้ำ/)
await db.exec("UPDATE or_orders SET status='ลงข้อมูลเสร็จสิ้น' WHERE bill_no='SHOPP26100005'")
assert.equal((await bill()).status,'รอตรวจคำสั่งซื้อ')
await db.exec("UPDATE or_orders SET status='ลงข้อมูลผิด' WHERE bill_no='SHOPP26100005'")
await db.exec("UPDATE or_orders SET discount=200,total_amount=2110,status='ลงข้อมูลเสร็จสิ้น' WHERE bill_no='SHOPP26100005'")
assert.equal((await bill()).status,'ลงข้อมูลเสร็จสิ้น')
await assert.rejects(db.exec("UPDATE ac_manual_slip_checks SET status='approved' WHERE id='e62533f5-9fe8-480d-b205-eecf2659e1db'"),/รายการซ้ำ/)
await db.close()
console.log('Passed: financial normalization, one active payment, retained audit, duplicate rejection, same-total reuse, changed-total recheck, duplicate reapproval rejection')
