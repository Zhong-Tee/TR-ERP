// Isolated PostgreSQL tests; never connects to the application database.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'

const db = new PGlite()
await db.exec(`
  CREATE ROLE authenticated;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid $$;
  CREATE TABLE or_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bill_no text UNIQUE, total_amount numeric, created_at timestamptz DEFAULT now(), status text);
  CREATE TABLE inv_returns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ref_bill_no text, status text DEFAULT 'pending');
  CREATE TABLE ac_ecommerce_channels(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, display_name text);
  CREATE TABLE mp_channel_configs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ecommerce_channel_id uuid);
  CREATE TABLE mp_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), config_id uuid, marketplace_order_no text, status text, order_total numeric, billed_at timestamptz, tracking_no text, billed_order_id uuid, billed_bill_no text, order_date timestamptz, is_current boolean DEFAULT true);
  CREATE TABLE ac_ecommerce_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel_id uuid, order_no text, platform_status text, delivery_status text, refund_status text, buyer_username text, ordered_at timestamptz, paid_at timestamptz, shipped_at timestamptz, completed_at timestamptz, tracking_no text, buyer_paid numeric, merchandise_total numeric, order_total numeric, province text);
  CREATE TABLE ac_ecommerce_order_lines(order_id uuid, qty numeric, returned_qty numeric);
  CREATE TABLE ac_ecommerce_settlements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel_id uuid, order_no text, settled_at timestamptz, gross_sales numeric, platform_fee_total numeric, seller_cost_total numeric, fee_category_count int, payout_amount numeric, fee_breakdown jsonb);
  CREATE TABLE ac_ecommerce_wallet_transactions(channel_id uuid, order_no text, amount numeric, transaction_at timestamptz);
  CREATE TABLE ac_ecommerce_reconciliation_overrides(channel_id uuid, order_no text, manual_status text, note text, updated_at timestamptz);
  INSERT INTO or_orders(bill_no,status,total_amount) VALUES ('A','จัดส่งแล้ว',100),('B','จัดส่งแล้ว',100),('C','จัดส่งแล้ว',100);
  INSERT INTO inv_returns(ref_bill_no) VALUES ('A');
  INSERT INTO ac_ecommerce_channels(code,display_name) VALUES ('shopee','Shopee');
  INSERT INTO mp_channel_configs(ecommerce_channel_id) SELECT id FROM ac_ecommerce_channels;
  INSERT INTO mp_orders(config_id,marketplace_order_no,status,order_total,billed_at,billed_order_id,billed_bill_no)
    SELECT c.id, o.bill_no, 'billed', 100, now(), o.id, o.bill_no FROM or_orders o CROSS JOIN mp_channel_configs c;
`)
const migration = await fs.readFile('supabase/migrations/654_parcel_return_order_status.sql', 'utf8')
await db.exec(migration)
const scalar = async (sql) => (await db.query(sql)).rows[0].value
const marker = (bill) => scalar(`SELECT has_parcel_return value FROM or_orders WHERE bill_no='${bill}'`)
const status = (bill) => scalar(`SELECT reconciliation_status value FROM ac_v_ecommerce_marketplace_bill_reconciliation WHERE erp_bill_no='${bill}'`)
assert.equal(await marker('A'), true, 'historical pending RTN is backfilled')
assert.equal(await marker('B'), false)
assert.equal(await status('A'), 'parcel_returned', 'missing imported Order still shows the RTN status')
await db.exec(`INSERT INTO inv_returns(ref_bill_no) VALUES ('B'),('B')`)
assert.equal(await marker('B'), true, 'new pending RTN applies immediately')
assert.equal(await scalar(`SELECT status value FROM or_orders WHERE bill_no='B'`), 'จัดส่งแล้ว')
await db.exec(`DELETE FROM inv_returns WHERE id=(SELECT id FROM inv_returns WHERE ref_bill_no='B' LIMIT 1)`)
assert.equal(await marker('B'), true, 'another RTN still references this bill')
await db.exec(`UPDATE inv_returns SET status='received' WHERE ref_bill_no='B'`)
assert.equal(await marker('B'), true)
await db.exec(`UPDATE inv_returns SET ref_bill_no='C' WHERE ref_bill_no='B'`)
assert.equal(await marker('B'), false)
assert.equal(await marker('C'), true)
await db.exec(`UPDATE or_orders SET has_parcel_return=false WHERE bill_no='A'`)
assert.equal(await marker('A'), true, 'marker cannot be manually cleared')
await db.exec(`INSERT INTO ac_ecommerce_reconciliation_overrides(channel_id,order_no,manual_status) SELECT id,'A','cancelled' FROM ac_ecommerce_channels`)
assert.equal(await status('A'), 'parcel_returned', 'RTN takes priority over manual reconciliation')
await db.exec(`
  INSERT INTO ac_ecommerce_orders(channel_id,order_no,delivery_status) SELECT id,'C','delivered' FROM ac_ecommerce_channels;
  INSERT INTO ac_ecommerce_settlements(channel_id,order_no,payout_amount) SELECT id,'C',100 FROM ac_ecommerce_channels;
  INSERT INTO ac_ecommerce_wallet_transactions(channel_id,order_no,amount) SELECT id,'C',100 FROM ac_ecommerce_channels;
`)
assert.equal(await status('C'), 'parcel_returned', 'RTN takes priority over imported delivery and fully paid income')
const pageCall = (filter, aging = 'all') => scalar(`SELECT ac_ecommerce_marketplace_bill_page_v2((SELECT id FROM ac_ecommerce_channels), 'billed_at', now()-interval '1 day', now()+interval '1 day', NULL, '${filter}', '${aging}') value`)
assert.deepEqual((await pageCall('parcel_returned')).map(r => r.erp_bill_no).sort(), ['A','C'])
assert.equal((await pageCall('cancelled_returned')).length, 2)
assert.equal((await pageCall('parcel_returned', 'within_7')).length, 0, 'RTNs excluded from payment aging')
const summary = (await db.query(`SELECT * FROM ac_ecommerce_marketplace_bill_summary_v2((SELECT id FROM ac_ecommerce_channels),'billed_at',now()-interval '1 day',now()+interval '1 day',NULL,'parcel_returned','all')`)).rows[0]
assert.equal(Number(summary.erp_order_count ?? summary.order_count), 2)
assert.equal(Number(summary.returned_count), 2)
await db.exec(`DELETE FROM inv_returns WHERE ref_bill_no='C'`)
assert.equal(await marker('C'), false, 'last RTN removal clears the marker')
assert.equal(await status('C'), 'paid', 'normal reconciliation restored when last RTN is removed')
await db.exec(`
  CREATE ROLE warehouse_test;
  GRANT INSERT ON inv_returns TO warehouse_test;
  SET ROLE warehouse_test;
  INSERT INTO inv_returns(ref_bill_no) VALUES ('B');
  RESET ROLE;
`)
assert.equal(await marker('B'), true, 'warehouse role can create RTN without order update privileges')
await db.exec(`INSERT INTO inv_returns(ref_bill_no) VALUES ('FUTURE'); INSERT INTO or_orders(bill_no,status) VALUES ('FUTURE','จัดส่งแล้ว')`)
assert.equal(await marker('FUTURE'), true, 'late-created order derives its marker')
await db.exec(migration)
assert.equal(await marker('A'), true, 'migration can be reapplied')
await db.close()
console.log('Passed: historical/new RTNs, shipping preserved, duplicate RTNs, receiving, reassignment/deletion, protected marker, reconciliation filters/summary/aging, late order and idempotency.')
