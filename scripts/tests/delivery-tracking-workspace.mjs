import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'
const db = new PGlite()
await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL AS $$ SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::UUID $$;
 CREATE TABLE us_users(id UUID PRIMARY KEY,role TEXT);
 INSERT INTO us_users VALUES(auth.uid(),'superadmin');
 CREATE TABLE channels(channel_code TEXT PRIMARY KEY,is_self_pickup BOOLEAN DEFAULT false);
 INSERT INTO channels VALUES('SHOP',false),('SHOPP',true);
 CREATE TABLE or_orders(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),bill_no TEXT,channel_order_no TEXT,
  tracking_number TEXT,created_at TIMESTAMPTZ,status TEXT,shipped_time TIMESTAMPTZ,channel_code TEXT,
  recipient_name TEXT,customer_name TEXT,fulfillment_method TEXT);
`)
for (const name of ['571_transport_delivery_check','572_delivery_check_cross_import_duplicates','640_delivery_tracking_workspace']) {
 await db.exec(await fs.readFile(`supabase/migrations/${name}.sql`,'utf8'))
}
const scalar = async sql => (await db.query(sql)).rows[0].value
const workspace = async (args = "NULL,NULL,'all'") => scalar(`SELECT tr_delivery_tracking_workspace(${args}) value`)
await db.exec(`INSERT INTO or_orders(bill_no,tracking_number,created_at,status,shipped_time,channel_code,fulfillment_method) VALUES
 ('OLD','OLD-T','2026-08-31 23:59:59+07','จัดส่งแล้ว','2026-09-02 09:00+07','SHOP','shipping'),
 ('BOUNDARY','BOUND-T','2026-09-01 00:00+07','จัดส่งแล้ว','2026-09-02 09:00+07','SHOP','shipping'),
 ('UNPACKED','PENDING','2026-09-01 10:00+07','ตรวจสอบแล้ว',NULL,'SHOP','shipping'),
 ('NO-TRACK',NULL,'2026-09-01 10:00+07','จัดส่งแล้ว','2026-09-02 09:00+07','SHOP','shipping'),
 ('PICKUP',NULL,'2026-09-01 10:00+07','ตรวจสอบแล้ว',NULL,'SHOPP','self_pickup'),
 ('CANCEL','CANCEL-T','2026-09-01 10:00+07','ยกเลิก',NULL,'SHOP','shipping');
 INSERT INTO tr_delivery_check_imports(carrier,file_name,file_hash,pickup_date_from,pickup_date_to)
 VALUES('FLASH','day1.xlsx','day1','2026-09-02','2026-09-02'),('FLASH','day2.xlsx','day2','2026-09-03','2026-09-03');
`)
let result = await workspace()
assert.equal(result.count,4)
assert.equal(result.summary.states.awaiting_carrier,1)
assert.equal(result.summary.states.pending_pack,1)
assert.equal(result.summary.states.no_tracking,1)
assert.equal(result.summary.states.self_pickup,1)
assert.equal((await workspace("'2026-08-01','2026-08-31'")).count,0)
assert.equal((await workspace("'2026-09-02','2026-09-02','all','','','','packed'")).count,2)
await db.exec(`INSERT INTO tr_delivery_check_rows(import_id,source_row_number,pickup_at,order_no,order_no_normalized,
 tracking_no,tracking_no_normalized,order_id,match_status,raw_data)
 SELECT i.id,1,('2026-09-02 10:00+07')::TIMESTAMPTZ,'BOUNDARY','BOUNDARY','BOUND-T','BOUND-T',o.id,'matched','{"สถานะงานรับ":"รับพัสดุแล้ว"}'::JSONB
 FROM tr_delivery_check_imports i CROSS JOIN or_orders o WHERE i.file_hash='day1' AND o.bill_no='BOUNDARY';`)
result = await workspace()
assert.equal(result.summary.states.received,1)
assert.equal(new Date(result.rows.find(r=>r.bill_no==='BOUNDARY').packed_at).getTime(),new Date('2026-09-02T02:00:00Z').getTime())
await db.exec(`INSERT INTO tr_delivery_check_rows(import_id,source_row_number,pickup_at,order_no,order_no_normalized,
 tracking_no,tracking_no_normalized,order_id,match_status,has_previous_import,raw_data)
 SELECT i.id,1,('2026-09-03 10:00+07')::TIMESTAMPTZ,'BOUNDARY','BOUNDARY','BOUND-T','BOUND-T',o.id,'matched',true,'{"สถานะงานรับ":"รับพัสดุแล้ว"}'::JSONB
 FROM tr_delivery_check_imports i CROSS JOIN or_orders o WHERE i.file_hash='day2' AND o.bill_no='BOUNDARY';`)
result = await workspace()
assert.equal(result.count,4)
assert.equal(result.summary.states.received,1)
assert.equal(result.rows.find(r=>r.bill_no==='BOUNDARY').file_name,'day2.xlsx')
await db.exec(`UPDATE tr_delivery_check_rows SET raw_data='{"สถานะงานรับ":"รับพัสดุไม่สำเร็จ"}' WHERE import_id=(SELECT id FROM tr_delivery_check_imports WHERE file_hash='day2')`)
assert.equal((await workspace()).summary.states.pickup_issue,1)
await db.exec(`UPDATE tr_delivery_check_rows SET raw_data='{"สถานะงานรับ":"ยังไม่ได้รับพัสดุ"}' WHERE import_id=(SELECT id FROM tr_delivery_check_imports WHERE file_hash='day2')`)
assert.equal((await workspace()).summary.states.awaiting_pickup,1)
await db.exec(`UPDATE tr_delivery_check_rows SET raw_data='{}' WHERE import_id=(SELECT id FROM tr_delivery_check_imports WHERE file_hash='day2')`)
assert.equal((await workspace()).summary.states.carrier_recorded,1)
await db.exec(`UPDATE tr_delivery_check_rows SET raw_data='{"สถานะงานรับ":"รับพัสดุแล้ว"}',has_duplicate=true WHERE import_id=(SELECT id FROM tr_delivery_check_imports WHERE file_hash='day2')`)
assert.equal((await workspace()).summary.states.needs_review,1)
await db.exec(`UPDATE tr_delivery_check_rows SET has_duplicate=false,tracking_no_normalized='WRONG',review_status='resolved' WHERE import_id=(SELECT id FROM tr_delivery_check_imports WHERE file_hash='day2')`)
assert.equal((await workspace()).summary.states.needs_review,1)
// A reviewed mismatch must never certify a carrier pickup. Conflicting references remain visible.
await db.exec(`UPDATE tr_delivery_check_rows SET tracking_no_normalized='BOUND-T' WHERE import_id=(SELECT id FROM tr_delivery_check_imports WHERE file_hash='day2');
 INSERT INTO or_orders(bill_no,tracking_number,created_at,status,channel_code,fulfillment_method)
 VALUES('OTHER-BOUND','BOUND-T','2026-09-04','ตรวจสอบแล้ว','SHOP','shipping');`)
assert.equal((await workspace()).summary.states.needs_review,2)
await db.exec(`DELETE FROM or_orders WHERE bill_no='OTHER-BOUND';
 DELETE FROM tr_delivery_check_imports WHERE file_hash='day2';`)
assert.equal((await workspace()).rows.find(r=>r.bill_no==='BOUNDARY').file_name,'day1.xlsx')
assert.equal((await workspace("NULL,NULL,'all','','FLASH'")).count,1)
assert.equal((await workspace("NULL,NULL,'all','BOUNDARY'")).count,1)
await db.exec(`INSERT INTO or_orders(bill_no,created_at,status,channel_code,fulfillment_method)
 SELECT 'PAGE-'||n,'2026-09-05','ตรวจสอบแล้ว','SHOP','shipping' FROM generate_series(1,110) n;`)
result = await workspace()
assert.equal(result.count,114)
assert.equal(result.rows.length,50)
const page2 = await workspace("NULL,NULL,'all','','','','created',50")
assert.equal(page2.count,114)
assert.equal(page2.summary.bills,114)
assert.equal(new Set([...result.rows,...page2.rows].map(r=>r.id)).size,100)
// Exclude Ecommerce channels and both channel-based and bill-specific customer pickup.
await db.exec(await fs.readFile('supabase/migrations/641_exclude_ecommerce_pickup_delivery_tracking.sql','utf8'))
await db.exec(`INSERT INTO or_orders(bill_no,created_at,status,channel_code,fulfillment_method)
 SELECT 'ECOM-'||channel,'2026-09-05','จัดส่งแล้ว',channel,'shipping'
 FROM unnest(ARRAY['SPTR','FSPTR','TTTR','LZTR','PGTR','WY']) channel;
 INSERT INTO or_orders(bill_no,created_at,status,channel_code,fulfillment_method) VALUES
 ('SELF-OTHER','2026-09-05','จัดส่งแล้ว','SHOP','self_pickup'),
 ('PICKUP-CHANNEL','2026-09-05','จัดส่งแล้ว','SHOPP','shipping');`)
result = await workspace()
assert.equal(result.count,113)
assert.equal(result.summary.bills,113)
assert.equal(result.summary.states.self_pickup,undefined)
assert.deepEqual(result.channels,['SHOP'])
assert.equal((await workspace("NULL,NULL,'all','','','SPTR'")).count,0)
assert.equal((await workspace("NULL,NULL,'all','','','SHOPP'")).count,0)
assert.equal((await workspace("NULL,NULL,'all','SELF-OTHER'")).count,0)
assert.equal(Number(await scalar("SELECT count(*) value FROM or_orders WHERE bill_no LIKE 'ECOM-%'")),6)
await db.exec("UPDATE us_users SET role='account'")
await assert.rejects(workspace(), /ไม่มีสิทธิ์/)
console.log('Passed: cutoff, missing ERP bills, packing dates, cross-file deduplication, latest pickup status, mismatches, duplicate keys, deletion fallback, filters, pagination and authorization.')
await db.close()
