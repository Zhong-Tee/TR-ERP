import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'
process.on('uncaughtException', e => { console.error(e.message, e.where || ''); process.exit(1) })
const db = new PGlite()
await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL AS $$ SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::UUID $$;
 CREATE TABLE us_users(id UUID PRIMARY KEY,role TEXT);
 INSERT INTO us_users VALUES(auth.uid(),'superadmin');
 CREATE TABLE channels(channel_code TEXT PRIMARY KEY,is_self_pickup BOOLEAN DEFAULT false,default_carrier TEXT DEFAULT 'OTHER');
 INSERT INTO channels(channel_code,is_self_pickup) VALUES('SHOP',false),('SHOPP',true);
 CREATE TABLE or_orders(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),bill_no TEXT,channel_order_no TEXT,
  tracking_number TEXT,created_at TIMESTAMPTZ,status TEXT,shipped_time TIMESTAMPTZ,channel_code TEXT,
  recipient_name TEXT,customer_name TEXT,customer_address TEXT,billing_details JSONB,fulfillment_method TEXT);
`)
for (const name of ['571_transport_delivery_check','572_delivery_check_cross_import_duplicates','573_delivery_check_duplicate_confirmation','575_delete_delivery_check_import','576_update_delivery_check_for_new_carrier_file','621_delivery_check_free_text_consignment']) {
 await db.exec(await fs.readFile(`supabase/migrations/${name}.sql`,'utf8'))
}
const scalar = async sql => (await db.query(sql)).rows[0].value
await db.exec(`INSERT INTO or_orders(bill_no,tracking_number,created_at,status,shipped_time,channel_code,fulfillment_method)
 VALUES('PUMP26100001','TH123','2026-10-06','จัดส่งแล้ว','2026-10-06','SHOP','shipping')`)
const sql=`SELECT tr_delivery_check_import('FLASH','retry.xlsx','same-file-sha256','Sheet1','2026-10-06','2026-10-06','[]',
 '[{"source_row_number":2,"pickup_at":"2026-10-06T12:00:00+07:00","order_no":"PUMP26100001","tracking_no":"TH123","sender":"test","consignee":"test","raw_data":{"สถานะงานรับ":"รับพัสดุแล้ว"}}]'::JSONB) value`
const first=await scalar(sql)
assert.equal(first.matched_count,1)
await assert.rejects(scalar(sql),/ไฟล์นี้เคยนำเข้า/)
await scalar(`SELECT tr_delivery_check_delete_import('${first.import_id}') value`)
assert.equal(Number(await scalar('SELECT count(*) value FROM tr_delivery_check_imports')),0)
assert.equal(Number(await scalar('SELECT count(*) value FROM tr_delivery_check_rows')),0)
assert.equal(await scalar("SELECT tracking_number value FROM or_orders WHERE bill_no='PUMP26100001'"),'TH123')
const again=await scalar(sql)
assert.notEqual(again.import_id,first.import_id)
assert.equal(again.matched_count,1)
assert.equal(Number(await scalar('SELECT count(*) value FROM tr_delivery_check_imports')),1)
console.log('Passed: first import, duplicate-file rejection, DB deletion cascade, unchanged ERP tracking, and successful same-file reimport.')
await db.close()
