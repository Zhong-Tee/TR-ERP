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
  console.log('Marketplace database guards passed: legacy mapping, review lock, rejection, field normalization, normal/QT/PC isolation, opening and approval.')
} finally {
  await db.close()
}
