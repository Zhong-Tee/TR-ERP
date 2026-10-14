// Isolated PostgreSQL regression fixture. Never connects to the live database.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'
const db = new PGlite()
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE pr_products(id uuid PRIMARY KEY, product_code text UNIQUE, product_name text, unit_name text);
    CREATE TABLE inv_stock_balances(product_id uuid PRIMARY KEY, on_hand numeric, reserved numeric);
    CREATE TABLE wms_requisitions(id uuid DEFAULT gen_random_uuid(), requisition_id text PRIMARY KEY, status text);
    CREATE TABLE wms_requisition_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requisition_id text, product_code text, qty numeric);
    CREATE TABLE wms_orders(id uuid DEFAULT gen_random_uuid(), order_id text, product_code text, qty numeric, status text);
    INSERT INTO pr_products VALUES('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','990000055','ใบปะหน้า','แพ็ค');
    INSERT INTO inv_stock_balances VALUES('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',19,0);
    INSERT INTO wms_requisitions(requisition_id,status) VALUES('REQ-1','pending'),('REQ-2','pending');`)
  await db.exec(await fs.readFile(new URL('../../supabase/migrations/650_guard_wms_requisition_stock.sql', import.meta.url), 'utf8'))
  const add = (req, qty) => db.exec(`INSERT INTO wms_requisition_items(requisition_id,product_code,qty) VALUES('${req}','990000055',${qty})`)
  await assert.rejects(() => add('REQ-1',2000), /ไม่เกิน 19/)
  for (const qty of [0,-1,"'NaN'","'Infinity'"]) await assert.rejects(() => add('REQ-1',qty), /ต้องมากกว่า 0/)
  await add('REQ-1',10)
  await assert.rejects(() => add('REQ-1',10), /ไม่เกิน 19/)
  await add('REQ-1',9)
  await db.exec('UPDATE inv_stock_balances SET reserved=1')
  await assert.rejects(() => db.exec("UPDATE wms_requisitions SET status='approved' WHERE requisition_id='REQ-1'"), /ไม่เกิน 18/)
  assert.equal((await db.query("SELECT status FROM wms_requisitions WHERE requisition_id='REQ-1'")).rows[0].status,'pending')
  await db.exec('UPDATE inv_stock_balances SET reserved=0')
  await db.exec("UPDATE wms_requisitions SET status='approved' WHERE requisition_id='REQ-1'")
  await assert.rejects(() => add('REQ-1',1), /รออนุมัติ/)
  // Test the new BEFORE guard with the same reserve timing as the existing AFTER trigger.
  await db.exec(`CREATE FUNCTION reserve_test_pick() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status='picked' AND OLD.status IS DISTINCT FROM 'picked' THEN
      UPDATE inv_stock_balances SET reserved=reserved+NEW.qty
      WHERE product_id=(SELECT id FROM pr_products WHERE product_code=NEW.product_code);
    END IF; RETURN NEW; END $$;
    CREATE TRIGGER reserve_test AFTER UPDATE OF status ON wms_orders FOR EACH ROW EXECUTE FUNCTION reserve_test_pick();
    INSERT INTO wms_orders(order_id,product_code,qty,status) VALUES('REQ-1','990000055',19,'pending'),('REQ-2','990000055',1,'pending');
    UPDATE wms_orders SET status='picked' WHERE order_id='REQ-1';`)
  await assert.rejects(() => db.exec("UPDATE wms_orders SET status='picked' WHERE order_id='REQ-2'"), /ไม่เกิน 0/)
  assert.equal((await db.query('SELECT reserved FROM inv_stock_balances')).rows[0].reserved,'19')
  await db.exec("UPDATE wms_orders SET status='picked' WHERE order_id='REQ-1'")
  await assert.rejects(() => db.exec("SELECT fn_check_requisition_stock('missing',1)"), /ไม่พบสินค้า/)
  await db.exec('SET ROLE authenticated')
  await assert.rejects(() => db.exec("SELECT fn_check_requisition_stock('990000055',1)"), /permission denied/)
  console.log('PASS: request limits, duplicate lines, invalid quantities, stale approvals, picking contention and internal function permissions')
} finally { await db.close() }
