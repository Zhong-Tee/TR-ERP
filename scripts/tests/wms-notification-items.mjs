// Isolated PostgreSQL fixture; never connects to the live database.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'
const db = new PGlite()
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE wms_orders(id uuid PRIMARY KEY,order_id text,product_code text,product_name text,location text);
    CREATE TABLE wms_notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),type text,order_id text,status text,is_read boolean);
    INSERT INTO wms_orders VALUES
      ('12715b96-fa36-46ce-aea0-7b0528a685f1','REQ-20261014-001','990000046','Bubble 32.5x100m ม้วน',null),
      ('4da60744-a1b2-4a24-9b4b-87b4c8af4ea5','REQ-20261014-001','990000055','ใบปะหน้า แบบพับ 500แผ่น','MOV-E-S02-B07');
    INSERT INTO wms_notifications(id,type,order_id,status,is_read) VALUES
      ('bea8de6e-1b31-477f-9431-22e17607d556','สินค้าหมด (X)','REQ-20261014-001','fixed',true);
    INSERT INTO wms_notifications(type,order_id,status) VALUES('สินค้าหมด (X)','OTHER','unread');`)
  await db.exec(await fs.readFile(new URL('../../supabase/migrations/651_link_wms_notifications_to_items.sql', import.meta.url),'utf8'))
  const repaired = (await db.query("SELECT * FROM wms_notifications WHERE id='bea8de6e-1b31-477f-9431-22e17607d556'")).rows[0]
  assert.equal(repaired.wms_order_id,'4da60744-a1b2-4a24-9b4b-87b4c8af4ea5')
  assert.equal(repaired.product_name,'ใบปะหน้า แบบพับ 500แผ่น')
  assert.equal(repaired.location,'MOV-E-S02-B07')
  assert.equal(repaired.status,'fixed')
  assert.equal(repaired.is_read,true)
  assert.equal((await db.query("SELECT wms_order_id FROM wms_notifications WHERE order_id='OTHER'")).rows[0].wms_order_id,null)
  await assert.rejects(() => db.exec(`INSERT INTO wms_notifications(type,order_id,wms_order_id)
    VALUES('สินค้าหมด (X)','OTHER','4da60744-a1b2-4a24-9b4b-87b4c8af4ea5')`), /ไม่ตรงกับใบงาน/)
  await db.exec(`INSERT INTO wms_notifications(type,order_id,wms_order_id,product_name)
    VALUES('แจ้งเตือน','REQ-20261014-001','4da60744-a1b2-4a24-9b4b-87b4c8af4ea5','wrong client name')`)
  assert.equal((await db.query("SELECT product_name FROM wms_notifications WHERE type='แจ้งเตือน'")).rows[0].product_name,'ใบปะหน้า แบบพับ 500แผ่น')
  await db.exec("UPDATE wms_orders SET product_name='changed'; DELETE FROM wms_orders WHERE id='4da60744-a1b2-4a24-9b4b-87b4c8af4ea5'")
  const snapshot = (await db.query("SELECT * FROM wms_notifications WHERE type='แจ้งเตือน'")).rows[0]
  assert.equal(snapshot.wms_order_id,null)
  assert.equal(snapshot.product_name,'ใบปะหน้า แบบพับ 500แผ่น')
  assert.equal(snapshot.location,'MOV-E-S02-B07')
  console.log('PASS: exact incident repair, item/job validation, snapshots, deleted rows, unchanged notification status')
} finally { await db.close() }
