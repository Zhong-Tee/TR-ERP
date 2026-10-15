// Isolated database fixture. Does not connect to or change the live database.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'

const db = new PGlite()
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
try {
  await db.exec(`
    CREATE TABLE mp_orders(id uuid PRIMARY KEY, billed_order_id uuid);
    CREATE TABLE or_orders(id uuid PRIMARY KEY, status text, customer_name text, updated_at timestamptz DEFAULT now());
    CREATE TABLE pr_products(id uuid PRIMARY KEY, product_category text);
    CREATE TABLE pr_category_field_settings(category text PRIMARY KEY, font boolean, line_1 boolean, line_2 boolean, line_3 boolean);
    CREATE TABLE pr_product_field_overrides(product_id uuid PRIMARY KEY, font boolean, line_1 boolean, line_2 boolean, line_3 boolean, required_fields text[]);
    CREATE TABLE mp_order_items(id uuid PRIMARY KEY,mp_order_id uuid,product_id uuid,line_index integer);
    CREATE TABLE or_order_items(id uuid PRIMARY KEY,order_id uuid REFERENCES or_orders(id) ON DELETE CASCADE,
      product_id uuid,item_uid text,font text,line_1 text,line_2 text,line_3 text,no_name_line boolean DEFAULT false,
      product_type text,ink_color text,cartoon_pattern text,line_pattern text);
    INSERT INTO pr_products VALUES('${id(1)}','ETC'),('${id(2)}','NAME');
    INSERT INTO pr_category_field_settings VALUES('ETC',false,false,false,false),('NAME',true,true,true,true);
    INSERT INTO or_orders(id,status,customer_name) VALUES('${id(10)}','รอตรวจคำสั่งซื้อ','marketplace'),('${id(11)}','รอตรวจคำสั่งซื้อ','normal'),('${id(12)}','รอตรวจคำสั่งซื้อ','QT/PC');
    INSERT INTO mp_orders VALUES('${id(20)}','${id(10)}');
    INSERT INTO mp_order_items VALUES('${id(30)}','${id(20)}','${id(1)}',0);
    INSERT INTO or_order_items(id,order_id,product_id,item_uid,font,line_1) VALUES('${id(40)}','${id(10)}','${id(1)}','B-1','F01','legacy');
  `)
  await db.exec(await fs.readFile(new URL('../../supabase/migrations/655_marketplace_review_guards.sql', import.meta.url), 'utf8'))
  const row = async table => (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows[0]
  assert.equal((await row('or_orders')).source_marketplace_order_id, id(20))
  assert.equal((await row('or_order_items')).source_mp_order_item_id, id(30))
  // No destructive cleanup of historical data during migration.
  assert.equal((await row('or_order_items')).line_1, 'legacy')

  for (const sql of [
    `UPDATE or_orders SET customer_name='changed' WHERE id='${id(10)}'`,
    `UPDATE or_orders SET status='ลงข้อมูลผิด',customer_name='changed' WHERE id='${id(10)}'`,
    `UPDATE or_order_items SET line_1='changed' WHERE id='${id(40)}'`,
    `DELETE FROM or_order_items WHERE id='${id(40)}'`,
    `DELETE FROM or_orders WHERE id='${id(10)}'`,
    `INSERT INTO or_order_items(id,order_id,product_id) VALUES('${id(41)}','${id(10)}','${id(1)}')`,
  ]) await assert.rejects(db.exec(sql), /รอตรวจคำสั่งซื้อ/)

  // Ordinary bills and QT/PC remain editable, including their existing no-name semantics.
  for (const order of [11, 12]) {
    await db.exec(`UPDATE or_orders SET customer_name='unchanged behavior' WHERE id='${id(order)}';
      INSERT INTO or_order_items(id,order_id,product_id,font,line_1,no_name_line)
      VALUES('${id(order + 40)}','${id(order)}','${id(1)}','F01','preserved',true)`)
    const regular = (await db.query(`SELECT * FROM or_order_items WHERE order_id='${id(order)}'`)).rows[0]
    assert.equal(regular.line_1, 'preserved')
    assert.equal(regular.font, 'F01')
  }

  // Rejection is permitted, then correcting the product clears forbidden customization.
  await db.exec(`UPDATE or_orders SET status='ลงข้อมูลผิด' WHERE id='${id(10)}';
    UPDATE or_order_items SET font='F01',line_1='Alice',no_name_line=true WHERE id='${id(40)}'`)
  assert.equal((await row('or_order_items')).font, null)
  assert.equal((await row('or_order_items')).line_1, null)
  assert.equal((await row('or_order_items')).no_name_line, false)
  await db.exec(`UPDATE or_order_items SET product_id='${id(2)}',font='F01',line_1='Alice',line_2='B',no_name_line=true WHERE id='${id(40)}'`)
  assert.equal((await row('or_order_items')).font, 'F01')
  assert.equal((await row('or_order_items')).line_1, null)
  assert.equal((await row('or_order_items')).line_2, null)

  // Required override wins over category disabled settings.
  await db.exec(`INSERT INTO pr_product_field_overrides VALUES('${id(1)}',null,null,null,null,ARRAY['font','line_1']);
    UPDATE or_order_items SET product_id='${id(1)}',font='F02',line_1='Allowed',no_name_line=false WHERE id='${id(40)}'`)
  assert.equal((await row('or_order_items')).font, 'F02')
  assert.equal((await row('or_order_items')).line_1, 'Allowed')

  // A newly opened bill may insert its initial items before the Marketplace claim is finalized.
  await db.exec(`INSERT INTO mp_orders VALUES('${id(21)}',null);
    INSERT INTO or_orders(id,status,source_marketplace_order_id) VALUES('${id(13)}','รอตรวจคำสั่งซื้อ','${id(21)}');
    INSERT INTO or_order_items(id,order_id,product_id,font,line_1) VALUES('${id(43)}','${id(13)}','${id(1)}','F01','initial');
    UPDATE mp_orders SET billed_order_id='${id(13)}' WHERE id='${id(21)}'`)
  await assert.rejects(db.exec(`UPDATE or_order_items SET font='F03' WHERE id='${id(43)}'`), /รอตรวจคำสั่งซื้อ/)
  await assert.rejects(db.exec(`UPDATE or_orders SET source_marketplace_order_id=null WHERE id='${id(13)}'`), /ที่มา/)
  await db.exec(`UPDATE or_orders SET status='ใบสั่งงาน' WHERE id='${id(13)}'`)
  await db.exec(`INSERT INTO mp_orders VALUES('${id(22)}',null);
    INSERT INTO or_orders(id,status) VALUES('${id(14)}','รอตรวจคำสั่งซื้อ');
    UPDATE mp_orders SET billed_order_id='${id(14)}' WHERE id='${id(22)}'`)
  assert.equal((await db.query(`SELECT source_marketplace_order_id FROM or_orders WHERE id='${id(14)}'`)).rows[0].source_marketplace_order_id, id(22))
  // Apply the follow-up identity lock only after exercising the original migration's behavior.
  await db.exec(`ALTER TABLE mp_order_items ADD raw_snapshot jsonb DEFAULT '{}'::jsonb,
      ADD product_name_raw text, ADD sku_ref text, ADD is_free boolean DEFAULT false;
    ALTER TABLE or_order_items ADD product_name text, ADD is_free boolean DEFAULT false;`)
  await db.exec(await fs.readFile(new URL('../../supabase/migrations/656_marketplace_product_identity_lock.sql', import.meta.url), 'utf8'))
  for (const sql of [
    `UPDATE mp_order_items SET product_id='${id(2)}' WHERE id='${id(30)}'`,
    `UPDATE mp_order_items SET product_name_raw='manual replacement' WHERE id='${id(30)}'`,
    `UPDATE mp_order_items SET sku_ref='other SKU' WHERE id='${id(30)}'`,
    `UPDATE mp_order_items SET raw_snapshot=null WHERE id='${id(30)}'`,
    `UPDATE or_order_items SET product_id='${id(2)}' WHERE id='${id(40)}'`,
    `UPDATE or_order_items SET product_name='manual replacement' WHERE id='${id(40)}'`,
    `UPDATE or_order_items SET source_mp_order_item_id=null WHERE id='${id(40)}'`,
    `UPDATE or_order_items SET order_id='${id(11)}' WHERE id='${id(40)}'`,
  ]) await assert.rejects(db.exec(sql), /Marketplace/)
  await db.exec(`UPDATE or_order_items SET no_name_line=true,line_1='stale name' WHERE id='${id(40)}'`)
  assert.equal((await row('or_order_items')).line_1, null)
  assert.equal((await row('or_order_items')).no_name_line, true)
  // Imported free products are locked too; the free flag cannot bypass source identity.
  await db.exec(`UPDATE or_order_items SET is_free=true WHERE id='${id(40)}'`)
  await assert.rejects(db.exec(`UPDATE or_order_items SET product_id='${id(2)}' WHERE id='${id(40)}'`), /Marketplace/)
  for (const order of [11,12]) {
    await db.exec(`UPDATE or_order_items SET product_id='${id(2)}',product_name='normal product edit' WHERE order_id='${id(order)}'`)
    assert.equal((await db.query(`SELECT product_name FROM or_order_items WHERE order_id='${id(order)}'`)).rows[0].product_name, 'normal product edit')
  }
  // System-generated gifts can still follow ink changes; their source has no imported snapshot.
  await db.exec(`INSERT INTO mp_order_items(id,mp_order_id,product_id,line_index,raw_snapshot,is_free)
      VALUES('${id(31)}','${id(20)}','${id(1)}',1,null,true);
    INSERT INTO or_order_items(id,order_id,product_id,product_name,source_mp_order_item_id,is_free)
      VALUES('${id(44)}','${id(10)}','${id(1)}','automatic gift','${id(31)}',true);
    UPDATE mp_order_items SET product_id='${id(2)}',product_name_raw='next automatic gift' WHERE id='${id(31)}';
    UPDATE or_order_items SET product_id='${id(2)}',product_name='next automatic gift' WHERE id='${id(44)}'`)
  // Exercise the atomic save against the actual item-saving RPC and the Marketplace triggers.
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
    ALTER TABLE or_orders ADD bill_no text;
    ALTER TABLE or_order_items ADD quantity numeric DEFAULT 1, ADD unit_price numeric,
      ADD is_detail_row boolean DEFAULT false, ADD parent_item_id uuid, ADD notes text,
      ADD file_attachment text, ADD attachment_name text, ADD created_at timestamptz DEFAULT now(),
      ADD updated_at timestamptz DEFAULT now();
    CREATE TABLE inv_stock_balances(product_id uuid PRIMARY KEY);`)
  await db.exec(await fs.readFile(new URL('../../supabase/migrations/632_stable_bill_item_order.sql', import.meta.url), 'utf8'))
  await db.exec(await fs.readFile(new URL('../../supabase/migrations/657_atomic_marketplace_bill_save.sql', import.meta.url), 'utf8'))
  const payload = async () => (await db.query(`SELECT * FROM or_order_items WHERE order_id='${id(10)}' ORDER BY id`)).rows
  const save = (header, items) => db.query('SELECT rpc_save_marketplace_bill($1,$2::jsonb,$3::jsonb) AS status', [id(10),JSON.stringify(header),JSON.stringify(items)])
  let items = await payload()
  items[0] = { ...items[0], line_1: 'saved before review', no_name_line: false }
  const saved = await save({status:'รอตรวจคำสั่งซื้อ',customer_name:'atomic success'},items)
  assert.equal(saved.rows[0].status,'รอตรวจคำสั่งซื้อ')
  assert.equal((await row('or_order_items')).line_1,'saved before review')
  assert.equal((await row('or_orders')).customer_name,'atomic success')
  // The same endpoint cannot edit a bill already in the review queue.
  await assert.rejects(save({status:'ลงข้อมูลผิด'},items),/รอตรวจคำสั่งซื้อ/)
  await assert.rejects(db.exec(`UPDATE or_order_items SET line_1='bypass' WHERE id='${id(40)}'`),/รอตรวจคำสั่งซื้อ/)
  await db.exec(`UPDATE or_orders SET status='ลงข้อมูลผิด' WHERE id='${id(10)}'`)
  items = await payload()
  // An item error must not leave the header in pending review.
  await assert.rejects(save({status:'รอตรวจคำสั่งซื้อ',customer_name:'must not save'},[
    {...items[0],product_id:id(2)},...items.slice(1),
  ]),/Marketplace/)
  assert.equal((await row('or_orders')).status,'ลงข้อมูลผิด')
  assert.equal((await row('or_orders')).customer_name,'atomic success')
  // A header failure after items have been saved rolls back the item write too.
  await db.exec(`ALTER TABLE or_orders ADD CONSTRAINT test_header_failure CHECK(customer_name<>'reject-after-items')`)
  await assert.rejects(save({status:'รอตรวจคำสั่งซื้อ',customer_name:'reject-after-items'},[
    {...items[0],line_1:'must roll back'},...items.slice(1),
  ]),/test_header_failure/)
  assert.equal((await row('or_order_items')).line_1,'saved before review')
  assert.equal((await row('or_orders')).status,'ลงข้อมูลผิด')
  await assert.rejects(save({status:'รอตรวจคำสั่งซื้อ',source_marketplace_order_id:null},items),/ไม่อนุญาต/)
  await assert.rejects(save({status:'รอตรวจคำสั่งซื้อ'},[]),/SKU/)
  await assert.rejects(db.query('SELECT rpc_save_marketplace_bill($1,$2::jsonb,$3::jsonb)',[id(11),JSON.stringify({status:'รอตรวจคำสั่งซื้อ'}),JSON.stringify(items)]),/ไม่ได้มาจาก Marketplace/)
  await db.exec(`ALTER TABLE or_orders ADD channel_order_no text, ADD tracking_number text, ADD express_receipt_number text;
    UPDATE or_orders SET channel_order_no='MP-ORDER',tracking_number='TRACK-1' WHERE id='${id(10)}'`)
  await db.exec(await fs.readFile(new URL('../../supabase/migrations/658_marketplace_returned_reference_lock.sql', import.meta.url), 'utf8'))
  for (const sql of [
    `UPDATE or_orders SET channel_order_no='changed' WHERE id='${id(10)}'`,
    `UPDATE or_orders SET tracking_number='changed' WHERE id='${id(10)}'`,
    `UPDATE or_orders SET status='รอตรวจคำสั่งซื้อ',tracking_number='changed' WHERE id='${id(10)}'`,
  ]) await assert.rejects(db.exec(sql),/เลขคำสั่งซื้อหรือเลขพัสดุ/)
  // Reject changed references through the atomic endpoint and roll back item edits as well.
  items = await payload()
  await assert.rejects(save({status:'รอตรวจคำสั่งซื้อ',tracking_number:'changed'},[
    {...items[0],line_1:'must roll back reference failure'},...items.slice(1),
  ]),/เลขคำสั่งซื้อหรือเลขพัสดุ/)
  assert.equal((await row('or_order_items')).line_1,'saved before review')
  assert.equal((await row('or_orders')).status,'ลงข้อมูลผิด')
  // The extra receipt number is still editable. Ordinary and QT/PC bills remain unaffected.
  await db.exec(`UPDATE or_orders SET express_receipt_number='EXTRA-1' WHERE id='${id(10)}'`)
  for (const order of [11,12]) {
    await db.exec(`UPDATE or_orders SET status='ลงข้อมูลผิด',channel_order_no='normal-order',tracking_number='normal-track' WHERE id='${id(order)}';
      UPDATE or_orders SET channel_order_no='edited-order',tracking_number='edited-track' WHERE id='${id(order)}'`)
    assert.equal((await db.query(`SELECT tracking_number FROM or_orders WHERE id='${id(order)}'`)).rows[0].tracking_number,'edited-track')
  }
  // Completing a returned bill with its original references must still succeed.
  await save({status:'รอตรวจคำสั่งซื้อ',channel_order_no:'MP-ORDER',tracking_number:'TRACK-1'},items)
  assert.equal((await row('or_orders')).status,'รอตรวจคำสั่งซื้อ')
  assert.equal((await row('or_orders')).tracking_number,'TRACK-1')
  await db.exec(await fs.readFile(new URL('../../supabase/migrations/659_marketplace_returned_tracking_and_quantity.sql', import.meta.url), 'utf8'))
  await db.exec(`UPDATE or_orders SET status='ลงข้อมูลผิด' WHERE id='${id(10)}'`)
  items = await payload()
  await assert.rejects(db.exec(`UPDATE or_orders SET channel_order_no='still-locked' WHERE id='${id(10)}'`),/เลขคำสั่งซื้อ/)
  await assert.rejects(db.exec(`UPDATE or_order_items SET quantity=quantity+1 WHERE id='${id(40)}'`),/จำนวนสินค้า/)
  await assert.rejects(save({status:'รอตรวจคำสั่งซื้อ',tracking_number:'must roll back'},[
    {...items[0],quantity:Number(items[0].quantity)+1},...items.slice(1),
  ]),/จำนวนสินค้า/)
  assert.equal((await row('or_orders')).status,'ลงข้อมูลผิด')
  assert.equal((await row('or_orders')).tracking_number,'TRACK-1')
  // Tracking is editable in the returned state, including during atomic completion.
  await db.exec(`UPDATE or_orders SET tracking_number='TRACK-EDITED' WHERE id='${id(10)}'`)
  await save({status:'รอตรวจคำสั่งซื้อ',channel_order_no:'MP-ORDER',tracking_number:'TRACK-CORRECTED'},items)
  assert.equal((await row('or_orders')).status,'รอตรวจคำสั่งซื้อ')
  assert.equal((await row('or_orders')).tracking_number,'TRACK-CORRECTED')
  assert.equal((await row('or_order_items')).quantity,items[0].quantity)
  await assert.rejects(db.exec(`UPDATE or_orders SET tracking_number='pending edit' WHERE id='${id(10)}'`),/รอตรวจคำสั่งซื้อ/)
  for (const order of [11,12]) {
    await db.exec(`UPDATE or_order_items SET quantity=3 WHERE order_id='${id(order)}'`)
    assert.equal((await db.query(`SELECT quantity FROM or_order_items WHERE order_id='${id(order)}'`)).rows[0].quantity,'3')
  }
  await db.exec(`CREATE TABLE or_order_reviews(order_id uuid,status text,error_fields jsonb,reviewed_at timestamptz DEFAULT now());
    UPDATE or_orders SET status='ลงข้อมูลผิด' WHERE id='${id(10)}'`)
  const correctionErrors = {tracking_number:true,item_ids:[id(44),id(40)],items:[{line_2:true},{font:true}]}
  await db.query("INSERT INTO or_order_reviews(order_id,status,error_fields) VALUES($1,'rejected',$2::jsonb)",[id(10),JSON.stringify(correctionErrors)])
  await db.exec(await fs.readFile(new URL('../../supabase/migrations/660_marketplace_flagged_corrections_only.sql', import.meta.url), 'utf8'))
  // IDs deliberately differ from display order: permissions must stay on the correct item.
  await db.exec(`UPDATE or_order_items SET font='F03' WHERE id='${id(40)}';
    UPDATE or_order_items SET line_2='flagged gift name' WHERE id='${id(44)}';
    UPDATE or_orders SET tracking_number='FLAGGED-TRACK' WHERE id='${id(10)}'`)
  for (const sql of [
    `UPDATE or_order_items SET line_1='unflagged' WHERE id='${id(40)}'`,
    `UPDATE or_order_items SET font='unflagged' WHERE id='${id(44)}'`,
    `UPDATE or_orders SET customer_name='unflagged' WHERE id='${id(10)}'`,
    `UPDATE or_orders SET express_receipt_number='unflagged' WHERE id='${id(10)}'`,
    `DELETE FROM or_order_items WHERE id='${id(40)}'`,
    `DELETE FROM or_order_items WHERE id='${id(44)}'`,
    `INSERT INTO or_order_items(id,order_id,product_id) VALUES('${id(90)}','${id(10)}','${id(1)}')`,
  ]) await assert.rejects(db.exec(sql),/เฉพาะฟิลด์|เพิ่มหรือลบ/)
  items = await payload()
  // An unflagged header change also rolls back an otherwise allowed item correction.
  await assert.rejects(save({status:'รอตรวจคำสั่งซื้อ',customer_name:'unflagged'},[
    {...items[0],font:'must roll back'},...items.slice(1),
  ]),/เฉพาะฟิลด์/)
  assert.equal((await row('or_order_items')).font,'F03')
  assert.equal((await row('or_orders')).status,'ลงข้อมูลผิด')
  await save({status:'รอตรวจคำสั่งซื้อ',tracking_number:'FLAGGED-FINAL'},[
    {...items[0],font:'F04'},...items.slice(1),
  ])
  assert.equal((await row('or_order_items')).font,'F04')
  assert.equal((await row('or_order_items')).line_1,'saved before review')
  assert.equal((await row('or_orders')).status,'รอตรวจคำสั่งซื้อ')
  // Ordinary and QT/PC bills retain unrestricted item editing and structure changes.
  for (const order of [11,12]) {
    await db.exec(`UPDATE or_order_items SET font='normal edit' WHERE order_id='${id(order)}';
      INSERT INTO or_order_items(id,order_id,product_id) VALUES('${id(order+100)}','${id(order)}','${id(1)}');
      DELETE FROM or_order_items WHERE id='${id(order+100)}'`)
  }
  console.log('Marketplace correction guards passed: only flagged fields, stable item IDs, no insert/delete, atomic rollback, ordinary/QT/PC unchanged.')

} finally {
  await db.close()
}
