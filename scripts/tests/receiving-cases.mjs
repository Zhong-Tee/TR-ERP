// Run after: npm install --prefix node_modules/.tmp/receiving-case-tests --no-save --package-lock=false @electric-sql/pglite
// Uses an isolated in-memory PostgreSQL instance. Never reads .env or production data.
import { PGlite } from '../../node_modules/.tmp/receiving-case-tests/node_modules/@electric-sql/pglite/dist/index.js'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const db = new PGlite()
const run = sql => db.exec(sql)
const one = async sql => (await db.query(sql)).rows[0]
let assertions = 0
const check = (value, expected) => { assert.deepEqual(value, expected); assertions++ }
const reject = async (sql, pattern) => { await assert.rejects(run(sql), pattern); assertions++ }
const admin = '00000000-0000-0000-0000-000000000001'
const store = '00000000-0000-0000-0000-000000000002'
const account = '00000000-0000-0000-0000-000000000003'
const sales = '00000000-0000-0000-0000-000000000004'
const po = '10000000-0000-0000-0000-000000000001'
const item = '20000000-0000-0000-0000-000000000001'
const prod = '30000000-0000-0000-0000-000000000001'
async function login(id, role='authenticated') {
  await run(`RESET ROLE; SELECT set_config('request.jwt.claim.sub','${id}',false); SELECT set_config('request.jwt.claim.role','${role}',false); SET ROLE ${role};`)
}
await run(`
CREATE ROLE authenticated; CREATE ROLE anon;
CREATE SCHEMA auth; CREATE SCHEMA storage;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
CREATE TABLE us_users(id uuid PRIMARY KEY,role text,username text);
CREATE TABLE st_user_menus(role text,menu_key text,has_access boolean);
CREATE TABLE pr_products(id uuid PRIMARY KEY,product_code text,product_name text,unit_cost numeric,landed_cost numeric,is_active boolean DEFAULT true);
CREATE TABLE inv_pr(id uuid PRIMARY KEY,status text);
CREATE TABLE inv_pr_items(id uuid PRIMARY KEY,pr_id uuid,product_id uuid,qty numeric,estimated_price numeric,last_purchase_price numeric);
CREATE TABLE inv_po(id uuid PRIMARY KEY,pr_id uuid,status text,po_no text,supplier_name text,total_amount numeric,grand_total numeric,intl_shipping_cost_thb numeric,updated_at timestamptz);
CREATE TABLE inv_po_items(id uuid PRIMARY KEY,po_id uuid REFERENCES inv_po,product_id uuid REFERENCES pr_products,qty numeric,qty_received_total numeric DEFAULT 0,resolution_qty numeric DEFAULT 0,resolution_type text,resolution_note text,resolved_by uuid,resolved_at timestamptz,unit_price numeric,subtotal numeric,unit text);
CREATE TABLE inv_gr(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),po_id uuid,gr_no text,received_at timestamptz DEFAULT now());
CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array($1,'/') $$;
CREATE FUNCTION rpc_receive_gr(uuid,jsonb,jsonb,uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
  UPDATE inv_po_items SET qty_received_total=qty_received_total+($2->0->>'qty_received')::numeric WHERE po_id=$1;
  INSERT INTO inv_gr(po_id) VALUES($1);
  UPDATE inv_po SET status=CASE WHEN EXISTS(SELECT 1 FROM inv_po_items WHERE po_id=$1 AND qty_received_total+resolution_qty<qty) THEN 'partial' ELSE 'received' END WHERE id=$1;
  RETURN '{}'::jsonb;
END $$;
CREATE FUNCTION rpc_resolve_po_shortage(p_po_id uuid,p_resolutions jsonb,p_user_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION rpc_convert_pr_to_po(uuid,uuid,text,jsonb,text,uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"id":"x","total_amount":100,"grand_total":120}'::jsonb $$;
CREATE FUNCTION rpc_update_po(uuid,text,date,jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RETURN '{}'::jsonb; END $$;
CREATE FUNCTION rpc_update_po_nonfinancial(uuid,text,date,jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RETURN '{}'::jsonb; END $$;
INSERT INTO us_users(id,role) VALUES('${admin}','admin'),('${store}','store'),('${account}','account'),('${sales}','sales-tr');
INSERT INTO st_user_menus VALUES('store','purchase-gr',true),('sales-tr','purchase-gr',true);
INSERT INTO pr_products VALUES('${prod}','SKU','Product',50,55,true);
INSERT INTO inv_po VALUES('${po}',NULL,'partial','PO-TEST','Seller',5000,5020,20,now());
INSERT INTO inv_po_items(id,po_id,product_id,qty,qty_received_total,unit_price,subtotal) VALUES('${item}','${po}','${prod}',100,90,50,5000);
GRANT USAGE ON SCHEMA public,auth,storage TO authenticated,anon;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public,storage TO authenticated;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['pr_products','inv_po','inv_po_items','inv_pr_items'] LOOP
EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
EXECUTE format('CREATE POLICY original_read ON %I FOR ALL TO authenticated USING (auth.uid() IS NOT NULL)',t);
END LOOP; END $$;
`)
for (const name of ['616_purchase_receiving_cases.sql','617_purchase_cost_read_security.sql']) await run(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url),'utf8'))
await login(store)
check((await one('SELECT unit_price FROM v_cost_safe_inv_po_items')).unit_price, null)
check((await one('SELECT total_amount,intl_shipping_cost_thb FROM v_cost_safe_inv_po')).intl_shipping_cost_thb, '20')
await reject('SELECT unit_price FROM inv_po_items', /permission denied/)
await reject('SELECT unit_cost FROM pr_products', /permission denied/)
check((await one('SELECT id FROM inv_po_items')).id,item)
const create = async (method, qty) => (await one(`SELECT rpc_create_receiving_case('${po}','${method}','Supplier agreement','[{"po_item_id":"${item}","qty":${qty}}]') AS id`)).id
const action = (id, name, data={}) => `SELECT rpc_receiving_case_action('${id}','${name}','${JSON.stringify(data)}')`
const c = await create('refund',4)
await reject(`SELECT rpc_create_receiving_case('${po}','refund','Duplicate','[{"po_item_id":"${item}","qty":7}]')`,/จำนวนเกิน/)
await reject(action(c,'approve',{amount:200,currency:'THB'}),/เฉพาะ/)
await reject(`UPDATE inv_po_items SET resolution_qty=10 WHERE id='${item}'`,/ต้องปิดยอด/)
await login(admin)
check((await one('SELECT unit_price FROM v_cost_safe_inv_po_items')).unit_price,'50')
await reject(action(c,'approve',{amount:0,currency:'THB'}),/ระบุยอดเงิน/)
check((await one('SELECT resolution_qty FROM inv_po_items')).resolution_qty,'0')
await run(action(c,'approve',{amount:200,currency:'THB'}))
check((await one('SELECT qty_received_total,resolution_qty FROM inv_po_items')), { qty_received_total:'90',resolution_qty:'4.00' })
await reject(action(c,'approve',{amount:200,currency:'THB'}),/ไม่ได้รออนุมัติ/)
await reject(action(c,'settle',{amount:201,reference:'OVER',settled_on:'2026-09-30'}),/จำนวนเงิน/)
await run(action(c,'settle',{amount:80,reference:'PAY-1',settled_on:'2026-09-30'}))
check((await one(`SELECT status FROM inv_receiving_cases WHERE id='${c}'`)).status,'refund_pending')
await reject(action(c,'settle',{amount:80,reference:'PAY-1',settled_on:'2026-09-30'}),/unique/)
await login(account)
await run(action(c,'settle',{amount:120,reference:'PAY-2',settled_on:'2026-09-30'}))
check((await one(`SELECT status FROM inv_receiving_cases WHERE id='${c}'`)).status,'completed')
await login(store)
check((await db.query('SELECT * FROM inv_receiving_case_finance')).rows.length,0)
check((await db.query('SELECT * FROM inv_receiving_case_settlements')).rows.length,0)
const dispute = await create('dispute',2)
check((await one('SELECT resolution_qty FROM inv_po_items')).resolution_qty,'4.00')
await run(action(dispute,'resubmit',{method:'vendor_refused',note:'Final vendor refusal'}))
await login(admin)
await run(action(dispute,'approve'))
check((await one(`SELECT status FROM inv_receiving_cases WHERE id='${dispute}'`)).status,'completed')
await login(store)
const unpaid = await create('cancel_unpaid',2)
await login(admin)
await run(action(unpaid,'approve',{amount:100,currency:'CNY'}))
await run(action(unpaid,'settle',{amount:100,reference:'ADJ-1',settled_on:'2026-09-30'}))
check((await one(`SELECT status FROM inv_receiving_cases WHERE id='${unpaid}'`)).status,'completed')
const stale = await create('refund',2)
await run(`SELECT rpc_receive_gr('${po}','[{"product_id":"${prod}","qty_received":1}]')`)
await reject(action(stale,'approve',{amount:100,currency:'THB'}),/รับสินค้าเพิ่ม/)
await run(action(stale,'reject',{note:'Refresh quantity'}))
const final = await create('vendor_refused',1)
await run(action(final,'approve'))
check((await one('SELECT status FROM inv_po')).status,'closed')
check((await one('SELECT qty_received_total,resolution_qty FROM inv_po_items')), { qty_received_total:'91',resolution_qty:'9.00' })
check((await one('SELECT count(*)::int AS n FROM inv_gr')).n,1)
await reject(`SELECT rpc_receive_gr('${po}','[{"product_id":"${prod}","qty_received":1}]')`,/เกิน/)
await reject(`SELECT rpc_receive_gr_before_cases('${po}','[]','{}','${admin}')`,/permission denied/)
await reject(`SELECT rpc_resolve_po_shortage('${po}','[]')`,/เมนูติดตาม/)
await login(sales)
check((await one('SELECT unit_price FROM v_cost_safe_inv_po_items')).unit_price,null)
await reject(action(c,'settle',{amount:1}),/เฉพาะ/)
await run(`INSERT INTO storage.objects(bucket_id,name) VALUES('receiving-case-evidence','${c}/${sales}/evidence.pdf')`)
check((await one('SELECT count(*)::int AS n FROM storage.objects')).n,1)
await login(store)
check((await one('SELECT count(*)::int AS n FROM storage.objects')).n,0)
await login(account)
check((await one('SELECT count(*)::int AS n FROM storage.objects')).n,1)
await reject(`INSERT INTO inv_po(id,status) VALUES(gen_random_uuid(),'closed')`,/ต้องปิดยอด/)
await reject(`INSERT INTO inv_po_items(id,po_id,product_id,qty,resolution_qty) VALUES(gen_random_uuid(),'${po}','${prod}',1,1)`,/ต้องปิดยอด/)
await login('', 'anon')
await reject('SELECT * FROM v_cost_safe_inv_po',/permission denied/)
await reject(`SELECT rpc_create_receiving_case('${po}','refund','x','[]')`,/permission denied/)
console.log(`Receiving cases: ${assertions} PostgreSQL assertions passed`)
await db.close()
