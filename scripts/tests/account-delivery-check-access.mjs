import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'

const db = new PGlite()
try {
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::UUID $$;
    SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',false);
    CREATE TABLE us_users(id UUID PRIMARY KEY,role TEXT);
    INSERT INTO us_users VALUES(auth.uid(),'account');
    CREATE TABLE st_user_menus(role TEXT,menu_key TEXT,menu_name TEXT,has_access BOOLEAN,
      UNIQUE(role,menu_key));
    INSERT INTO st_user_menus VALUES('account','transport','ทวนสอบขนส่ง',false);
    CREATE TABLE channels(channel_code TEXT PRIMARY KEY,is_self_pickup BOOLEAN DEFAULT false,default_carrier TEXT DEFAULT 'OTHER');
    INSERT INTO channels(channel_code,is_self_pickup) VALUES('SHOP',false);
    CREATE TABLE or_orders(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),bill_no TEXT,channel_order_no TEXT,
      tracking_number TEXT,created_at TIMESTAMPTZ,status TEXT,shipped_time TIMESTAMPTZ,channel_code TEXT,
      recipient_name TEXT,customer_name TEXT,customer_address TEXT,billing_details JSONB,fulfillment_method TEXT);
    INSERT INTO or_orders(bill_no,tracking_number,created_at,status,shipped_time,channel_code,fulfillment_method)
      VALUES('PUMP26100001','TH123','2026-10-06','จัดส่งแล้ว','2026-10-06','SHOP','shipping'),
        ('CANCEL26100001','TH123','2026-10-06','ยกเลิก',NULL,'SHOP','shipping');
    GRANT USAGE ON SCHEMA public,auth TO authenticated;
    GRANT SELECT ON us_users,or_orders TO authenticated;
  `)
  for (const name of ['571_transport_delivery_check','572_delivery_check_cross_import_duplicates',
    '573_delivery_check_duplicate_confirmation','575_delete_delivery_check_import',
    '576_update_delivery_check_for_new_carrier_file','621_delivery_check_free_text_consignment',
    '641_exclude_ecommerce_pickup_delivery_tracking','642_delivery_check_review_workflow']) {
    await db.exec(await fs.readFile(`supabase/migrations/${name}.sql`, 'utf8'))
  }
  const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0].value
  const workspace = () => scalar('SELECT tr_delivery_tracking_workspace() value')
  await assert.rejects(workspace(), /ไม่มีสิทธิ์/)
  const migration = await fs.readFile('supabase/migrations/665_account_delivery_check_access.sql', 'utf8')
  await db.exec(migration)
  await db.exec(migration) // Safe to reapply; the menu upsert updates existing permissions.
  assert.equal(await scalar("SELECT has_access value FROM st_user_menus WHERE role='account' AND menu_key='transport'"), true)
  const originalOrders = (await db.query('SELECT * FROM or_orders ORDER BY id')).rows
  await db.exec('SET ROLE authenticated') // Exercise RLS, not the table owner bypass.
  const importFile = () => scalar(`SELECT tr_delivery_check_import('FLASH','account.xlsx','account-file','Sheet1',
    '2026-10-06','2026-10-06','[]',
    '[{"source_row_number":2,"pickup_at":"2026-10-06T12:00:00+07:00","order_no":"PUMP26100001","tracking_no":"TH123","raw_data":{"สถานะงานรับ":"รับพัสดุแล้ว"}},
      {"source_row_number":3,"pickup_at":"2026-10-06T12:00:00+07:00","order_no":"ฝากส่ง","tracking_no":"CONSIGN"}]') value`)
  const imported = await importFile()
  assert.equal(Number(await scalar('SELECT count(*) value FROM tr_delivery_check_imports')), 1)
  assert.equal(Number(await scalar('SELECT count(*) value FROM tr_delivery_check_rows')), 2)
  const rows = (await db.query('SELECT * FROM tr_delivery_check_rows ORDER BY source_row_number')).rows
  assert.equal(rows[0].match_status, 'matched')
  assert.equal(rows[1].match_status, 'consignment')
  assert.equal(rows[0].import_id, imported.import_id)
  const tracking = await workspace()
  assert.equal(tracking.count, 1)
  // The existing workspace conservatively flags reused tracking references,
  // even though import matching correctly excludes the cancelled bill.
  assert.equal(tracking.rows[0].delivery_state, 'needs_review')
  assert.equal((await scalar("SELECT jsonb_agg(r) value FROM tr_delivery_check_find_previous_duplicates(ARRAY['TH123']) r")).length, 1)
  await assert.rejects(importFile(), /ไฟล์นี้เคยนำเข้า/)
  await scalar('SELECT tr_delivery_check_rebuild_system_only($1) value', [imported.import_id])
  const moved = await scalar('SELECT to_jsonb(tr_delivery_check_move_to_review($1,$2)) value', [rows[1].id, 'ตรวจรายการฝากส่ง'])
  assert.equal(moved.is_consignment, false)
  assert.equal(moved.match_status, 'unmatched')
  const reviewed = await scalar('SELECT to_jsonb(tr_delivery_check_review_row($1,$2,true)) value', [rows[1].id, 'ตรวจสอบเรียบร้อย'])
  assert.equal(reviewed.review_status, 'resolved')
  assert.equal(reviewed.note, 'ตรวจสอบเรียบร้อย')
  assert.equal(reviewed.reviewed_by, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  // Both USING and WITH CHECK permit Accounting's existing direct-table flows.
  await db.query('UPDATE tr_delivery_check_rows SET note=$1 WHERE id=$2', ['แก้หมายเหตุ', rows[0].id])
  assert.equal(await scalar('SELECT note value FROM tr_delivery_check_rows WHERE id=$1', [rows[0].id]), 'แก้หมายเหตุ')
  const deniedCalls = [
    () => workspace(), importFile,
    () => scalar("SELECT count(*) value FROM tr_delivery_check_find_previous_duplicates(ARRAY['TH123'])"),
    () => scalar('SELECT tr_delivery_check_rebuild_system_only($1) value', [imported.import_id]),
    () => scalar('SELECT tr_delivery_check_review_row($1,$2,true) value', [rows[0].id, 'denied']),
    () => scalar('SELECT tr_delivery_check_move_to_review($1,$2) value', [rows[1].id, 'denied']),
    () => scalar('SELECT tr_delivery_check_delete_import($1) value', [imported.import_id]),
  ]
  for (const role of ['store', 'production', null]) {
    await db.exec('RESET ROLE')
    await db.query('UPDATE us_users SET role=$1', [role])
    await db.exec('SET ROLE authenticated')
    assert.equal(Number(await scalar('SELECT count(*) value FROM tr_delivery_check_imports')), 0)
    assert.equal(Number(await scalar('SELECT count(*) value FROM tr_delivery_check_rows')), 0)
    for (const call of deniedCalls) await assert.rejects(call(), /ไม่มีสิทธิ์/)
    await assert.rejects(db.exec(`INSERT INTO tr_delivery_check_imports(carrier,file_name,file_hash,pickup_date_from,pickup_date_to)
      VALUES('FLASH','denied.xlsx','denied','2026-10-06','2026-10-06')`), /row-level security/)
  }
  await db.exec("RESET ROLE; UPDATE us_users SET role='account'; SET ROLE authenticated")
  await scalar('SELECT tr_delivery_check_delete_import($1) value', [imported.import_id])
  assert.equal(Number(await scalar('SELECT count(*) value FROM tr_delivery_check_imports')), 0)
  assert.equal(Number(await scalar('SELECT count(*) value FROM tr_delivery_check_rows')), 0)
  const reimported = await importFile()
  assert.notEqual(reimported.import_id, imported.import_id)
  for (const role of ['superadmin', 'admin', 'admin-tr', 'sales-tr', 'packing_staff']) {
    await db.exec('RESET ROLE')
    await db.query('UPDATE us_users SET role=$1', [role])
    await db.exec('SET ROLE authenticated')
    assert.equal((await workspace()).count, 1)
    assert.equal(Number(await scalar('SELECT count(*) value FROM tr_delivery_check_rows')), 2)
  }
  await db.exec('RESET ROLE')
  assert.deepEqual((await db.query('SELECT * FROM or_orders ORDER BY id')).rows, originalOrders)
  console.log('Passed: Account menu, authenticated RLS, import/reimport, duplicate lookup, tracking/export data, rebuild, review, move, delete cascade, existing roles, denied roles, and unchanged ERP orders.')
} catch (error) {
  console.error(error.message, error.where || '', error.stack?.split('\n').filter(line => line.includes('account-delivery-check-access.mjs')).join('\n'))
  process.exitCode = 1
} finally {
  await db.close()
}
