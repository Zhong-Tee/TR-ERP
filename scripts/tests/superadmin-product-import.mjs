// Isolated PostgreSQL test; no production connection or credentials.
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const db = new PGlite()
const run = sql => db.exec(sql)
const query = async (sql, args) => (await db.query(sql, args)).rows
const ids = Object.fromEntries(['superadmin','account','admin','store','sales-tr','inactive'].map((r,i) => [r, `00000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`]))
const login = async role => {
  await run('RESET ROLE')
  await query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)", [ids[role] || ''])
  await run('SET ROLE authenticated')
}
const row = (code, extra={}) => ({product_code:code,product_name:`Product ${code}`,unit_cost:12,unit_name:'ชิ้น',unit_multiplier:1,product_type:'FG',channel_prices:{SHOP:25},...extra})
const call = items => query('SELECT rpc_import_products($1::jsonb) result', [JSON.stringify(items)])
try {
  await run(`
    CREATE ROLE authenticated; CREATE ROLE anon;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
    CREATE TABLE us_users(id uuid PRIMARY KEY, role text, is_active boolean DEFAULT true);
    CREATE TABLE pr_products(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_code text UNIQUE NOT NULL,
      product_name text NOT NULL,seller_name text,product_name_cn text,order_point text,order_point_days integer,
      product_category text,product_type text,rubber_code text,storage_location text,unit_cost numeric,
      unit_name text,unit_multiplier numeric,is_active boolean DEFAULT true,landed_cost numeric DEFAULT 0);
    CREATE TABLE channels(channel_code text PRIMARY KEY);
    CREATE TABLE pr_product_channel_prices(product_id uuid REFERENCES pr_products,channel_code text REFERENCES channels,
      sale_price numeric NOT NULL CHECK(sale_price>=0),PRIMARY KEY(product_id,channel_code));
    CREATE TABLE inv_po(id uuid,total_amount numeric);
    CREATE TABLE inv_po_items(id uuid,unit_price numeric);
    CREATE TABLE inv_pr_items(id uuid,estimated_price numeric);
    CREATE TABLE inv_stock_balances(product_id uuid,on_hand numeric);
    GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
    DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['pr_products','inv_po','inv_po_items','inv_pr_items'] LOOP
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
      EXECUTE format('CREATE POLICY original_access ON %I FOR ALL TO authenticated USING (auth.uid() IS NOT NULL)',t);
    END LOOP; END $$;
    INSERT INTO channels VALUES('SHOP');
    INSERT INTO pr_products(product_code,product_name,unit_cost,landed_cost,is_active) VALUES('OLD','Old',5,9,false);
    INSERT INTO inv_stock_balances SELECT id,123 FROM pr_products;
  `)
  for (const [role,id] of Object.entries(ids)) await query('INSERT INTO us_users VALUES($1,$2,$3)',[id,role==='inactive'?'superadmin':role,role!=='inactive'])
  const migration = async name => readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8')
  // Exercise the actual cost masking/grants introduced by 616/617.
  const costHelper = (await migration('616_purchase_receiving_cases.sql')).split('CREATE OR REPLACE FUNCTION public.erp_can_manage_receiving_cases')[0]
  await run(`${costHelper}\nCOMMIT;`)
  const masking = (await migration('617_purchase_cost_read_security.sql')).split('-- Preserve the deployed converter')[0]
  await run(`${masking}\nCOMMIT;`)
  await run(await migration('666_superadmin_product_import.sql'))

  await login('superadmin')
  await assert.rejects(run("INSERT INTO pr_products(product_code,product_name,unit_cost) VALUES('OLD','Old',20) ON CONFLICT(product_code) DO UPDATE SET unit_cost=excluded.unit_cost"),/permission denied/)
  assert.deepEqual((await call([row('NEW'),row('OLD',{unit_cost:20,is_active:true,landed_cost:999})]))[0].result,{inserted:1,updated:1})
  assert.equal((await query("SELECT unit_cost FROM v_cost_safe_pr_products WHERE product_code='OLD'"))[0].unit_cost,'20')
  await run('RESET ROLE')
  const old = (await query("SELECT id,is_active,landed_cost FROM pr_products WHERE product_code='OLD'"))[0]
  assert.equal(old.is_active,false)
  assert.equal(old.landed_cost,'9')
  assert.equal((await query('SELECT on_hand FROM inv_stock_balances'))[0].on_hand,'123')
  assert.equal((await query('SELECT count(*) n FROM pr_product_channel_prices'))[0].n,2)
  await login('superadmin')
  await call([row('OLD',{channel_prices:{}})])
  assert.equal((await query('SELECT count(*) n FROM pr_product_channel_prices WHERE product_id=$1',[old.id]))[0].n,0)
  await assert.rejects(call([row('AAA'),row('ZZZ',{channel_prices:{UNKNOWN:10}})]),/foreign key/)
  assert.equal((await query("SELECT count(*) n FROM v_cost_safe_pr_products WHERE product_code='AAA'"))[0].n,0)
  await assert.rejects(call([row('OLD',{unit_cost:99}),row('ZZZ',{channel_prices:{SHOP:-1}})]),/check constraint/)
  assert.equal((await query("SELECT unit_cost FROM v_cost_safe_pr_products WHERE product_code='OLD'"))[0].unit_cost,'12')
  await assert.rejects(call([row('DUP'),row('dup')]),/รหัสสินค้าซ้ำ/)
  await assert.rejects(call([row('BAD',{product_name:''})]),/ข้อมูลสินค้าไม่ถูกต้อง/)
  await assert.rejects(call({}),/ข้อมูลนำเข้า/)

  for (const role of ['account','admin','store','sales-tr','inactive','unknown']) {
    await login(role)
    await assert.rejects(call([row('DENIED')]),/เฉพาะ superadmin/)
    await assert.rejects(run('SELECT unit_cost FROM pr_products'),/permission denied/)
    if (['store','sales-tr'].includes(role)) {
      assert.equal((await query("SELECT unit_cost,landed_cost FROM v_cost_safe_pr_products WHERE product_code='NEW'"))[0].unit_cost,null)
      assert.equal((await query("SELECT landed_cost FROM v_cost_safe_pr_products WHERE product_code='NEW'"))[0].landed_cost,null)
    }
    if (['account','admin'].includes(role)) assert.equal((await query("SELECT unit_cost FROM v_cost_safe_pr_products WHERE product_code='NEW'"))[0].unit_cost,'12')
  }
  await run('RESET ROLE; SET ROLE anon')
  await assert.rejects(call([row('ANON')]),/permission denied/)
  console.log('PASS: superadmin insert/update, preserved inactive/stock/cost metadata, channel prices, atomic rollback, role denials and existing cost masking')
} finally { await db.close() }
