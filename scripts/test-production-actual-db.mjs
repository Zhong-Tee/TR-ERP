import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '../.tmp/production-actual-tests/node_modules/@electric-sql/pglite/dist/index.js'
// Isolated PostgreSQL engine. No connection to the deployed database.
// Setup: npm install --prefix .tmp/production-actual-tests --no-save @electric-sql/pglite@0.5.11
// Run: node scripts/test-production-actual-db.mjs
const db = new PGlite()
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE TABLE us_users(id uuid primary key,role text,is_active boolean);
CREATE TABLE pr_products(id uuid primary key,product_code text,product_name text,landed_cost numeric,unit_cost numeric);
CREATE TABLE pp_recipes(id uuid primary key,product_id uuid,max_stock numeric);
CREATE TABLE pp_recipe_includes(id uuid primary key,recipe_id uuid,product_id uuid,qty numeric);
CREATE TABLE pp_recipe_removes(id uuid primary key,recipe_id uuid,product_id uuid,qty numeric,unit_cost numeric);
CREATE TABLE pp_production_orders(id uuid primary key,status text,started_by uuid,started_at timestamptz,completed_by uuid,completed_at timestamptz);
CREATE TABLE pp_production_order_items(id uuid primary key,order_id uuid references pp_production_orders(id),product_id uuid,qty numeric(12,2),unit_cost numeric(14,4),total_cost numeric(14,2));
CREATE TABLE inv_stock_balances(product_id uuid primary key,on_hand numeric,reserved numeric,safety_stock numeric,updated_at timestamptz);
CREATE TABLE inv_stock_movements(id uuid primary key default gen_random_uuid(),product_id uuid,movement_type text,qty numeric,ref_type text,ref_id uuid,note text,created_by uuid,unit_cost numeric(14,4),total_cost numeric(14,2));
CREATE TABLE inv_stock_lots(id uuid primary key default gen_random_uuid(),product_id uuid,qty_initial numeric(12,2),qty_remaining numeric(12,2),unit_cost numeric(14,4),ref_type text,ref_id uuid,created_at timestamptz default now(),is_safety_stock boolean default false);
CREATE TABLE inv_lot_consumptions(id uuid default gen_random_uuid(),lot_id uuid,movement_id uuid,qty numeric,unit_cost numeric);
`)
const functionSQL = (sql,name) => {
 const match = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION (?:public\\.)?${name}\\([\\s\\S]*?\\$\\$;`))
 assert.ok(match, name)
 return match[0]
}
await db.exec(functionSQL(await fs.readFile('supabase/migrations/504_reconcile_fifo_lots_before_wms_deduction.sql','utf8'),'fn_consume_stock_fifo'))
await db.exec(functionSQL(await fs.readFile('supabase/migrations/099_fifo_stock_lots.sql','utf8'),'fn_recalc_product_landed_cost'))
const workflowSQL = await fs.readFile('supabase/migrations/402_internal_production_workflow.sql','utf8')
await db.exec(functionSQL(workflowSQL,'guard_pp_production_max_stock'))
await db.exec(`CREATE TRIGGER trg_guard_pp_production_max_stock BEFORE UPDATE ON pp_production_orders FOR EACH ROW EXECUTE FUNCTION guard_pp_production_max_stock();`)
await db.exec(await fs.readFile('supabase/migrations/668_internal_production_actual_completion.sql','utf8'))
const accessSQL = await fs.readFile('supabase/migrations/620_packing_sub_warehouse_and_internal_production_access.sql','utf8')
await db.exec(functionSQL(accessSQL,'guard_pp_production_status_roles'))
await db.exec(functionSQL(accessSQL,'rpc_start_production_order'))
await db.exec('CREATE TRIGGER trg_guard_pp_status_roles BEFORE UPDATE ON pp_production_orders FOR EACH ROW EXECUTE FUNCTION guard_pp_production_status_roles()')
const receiptAccessSQL = await fs.readFile('supabase/migrations/676_internal_production_store_receipt.sql','utf8')
await db.exec(receiptAccessSQL)
await db.exec(receiptAccessSQL) // Reapplication must be safe.

const q = async (sql,params=[]) => (await db.query(sql,params)).rows
const scalar = async sql => Object.values((await q(sql))[0])[0]
async function seed() {
 await db.exec(`TRUNCATE inv_lot_consumptions,inv_stock_movements,inv_stock_lots,inv_stock_balances,pp_recipe_removes,pp_recipe_includes,pp_recipes,pp_production_order_items,pp_production_orders,pr_products,us_users CASCADE;
 INSERT INTO us_users VALUES('${id(1)}','store',true);
 SELECT set_config('request.jwt.claim.sub','${id(1)}',false);
 INSERT INTO pr_products VALUES('${id(2)}','PP','Finished',0,0),('${id(3)}','RM','Material',2,2),('${id(4)}','BY','Byproduct',1,1);
 INSERT INTO pp_recipes VALUES('${id(5)}','${id(2)}',10000);
 INSERT INTO pp_recipe_includes VALUES('${id(6)}','${id(5)}','${id(3)}',2);
 INSERT INTO pp_production_orders(id,status) VALUES('${id(7)}','processing');
 INSERT INTO pp_production_order_items(id,order_id,product_id,qty) VALUES('${id(8)}','${id(7)}','${id(2)}',5200);
 INSERT INTO inv_stock_balances VALUES('${id(3)}',10400,0,0,now());
 INSERT INTO inv_stock_lots(product_id,qty_initial,qty_remaining,unit_cost,created_at) VALUES('${id(3)}',10000,10000,2,'2026-01-01'),('${id(3)}',400,400,3,'2026-02-01');`)
 return [{item_id:id(8), actual_qty:5050,reason_code:'วัตถุดิบในห่อไม่ครบ',reason:'ห่อไม่ครบ',materials:[{product_id:id(3),used_qty:10100,returned_qty:100,waste_qty:0,shortage_qty:200,reason:'นับพบขาด 200'}],byproducts:[]}]
}
const complete = items => q('SELECT rpc_complete_production_order_actual($1,$2::jsonb)',[id(7),JSON.stringify(items)])
const report = async () => (await q('SELECT completion_report FROM pp_production_order_items'))[0].completion_report
let passed=0
async function test(name, fn) {await fn(); console.log(`PASS ${name}`);passed++}
await test('short receipt, retained returns, shortage valuation, FIFO and closed status',async()=>{
 const items=await seed();await complete(items)
 assert.equal(Number(await scalar(`SELECT on_hand FROM inv_stock_balances WHERE product_id='${id(2)}'`)),5050)
 assert.equal(Number(await scalar(`SELECT on_hand FROM inv_stock_balances WHERE product_id='${id(3)}'`)),100)
 assert.equal(Number(await scalar(`SELECT sum(qty_remaining) FROM inv_stock_lots WHERE product_id='${id(3)}'`)),100)
 const r=await report();assert.equal(r.material_cost,20300);assert.equal(r.shortage_cost,600);assert.equal(r.total_cost,20300);assert.equal(r.unit_cost,4.0198)
 assert.equal(Number(await scalar('SELECT qty FROM pp_production_order_items')),5200)
 assert.equal(await scalar('SELECT status FROM pp_production_orders'),'completed')
 assert.equal(await scalar('SELECT completion_short FROM pp_production_orders'),true)
 assert.equal(Number(await scalar("SELECT total_cost FROM inv_stock_movements WHERE movement_type='pp_shortage'")),-600)
 await assert.rejects(()=>complete(items),/ปิดงานแล้ว/)
 assert.equal(Number(await scalar(`SELECT on_hand FROM inv_stock_balances WHERE product_id='${id(2)}'`)),5050)
 await assert.rejects(()=>q('UPDATE pp_production_order_items SET qty=1'),/ปิดงานแล้ว/)
 await assert.rejects(()=>q('DELETE FROM pp_production_orders'),/ปิดงานแล้ว/)
})
await test('full receipt uses planned materials and preserves normal completion',async()=>{
 const items=await seed();items[0].actual_qty=5200;Object.assign(items[0].materials[0],{used_qty:10400,returned_qty:0,shortage_qty:0,reason:''});await complete(items)
 assert.equal(await scalar('SELECT completion_short FROM pp_production_orders'),false)
 const r=await report();assert.equal(r.total_cost,21200);assert.equal(r.shortage_cost,0)
})
await test('waste included, byproduct valued separately and credited against output',async()=>{
 const items=await seed();Object.assign(items[0].materials[0],{used_qty:10000,waste_qty:100,returned_qty:100,shortage_qty:200})
 await db.exec(`INSERT INTO pp_recipe_removes VALUES('${id(9)}','${id(5)}','${id(4)}',0.1,1)`)
 items[0].byproducts=[{product_id:id(4),qty:400}];await complete(items)
 const r=await report();assert.equal(r.material_cost,20300);assert.equal(r.byproduct_cost,400);assert.equal(r.total_cost,19900)
 assert.equal(Number(await scalar(`SELECT on_hand FROM inv_stock_balances WHERE product_id='${id(4)}'`)),400)
 assert.equal(Number(await scalar(`SELECT qty_remaining FROM inv_stock_lots WHERE product_id='${id(4)}'`)),400)
})
await test('zero output records whole-job loss without creating a zero lot',async()=>{
 const items=await seed();items[0].actual_qty=0;await complete(items)
 const r=await report();assert.equal(r.production_loss_cost,20300);assert.equal(r.total_cost,0);assert.equal(r.unit_cost,0)
 assert.equal(Number(await scalar("SELECT count(*) FROM inv_stock_movements WHERE movement_type='pp_produce'")),0)
})
const invalidCases=[
 ['missing output reason',x=>{x[0].reason=''},/เหตุผล/],
 ['negative actual',x=>{x[0].actual_qty=-1},/ไม่ถูกต้อง/],
 ['overproduction',x=>{x[0].actual_qty=5201},/เกิน/],
 ['fractional precision',x=>{x[0].actual_qty=1.001},/ไม่ถูกต้อง/],
 ['null actual',x=>{x[0].actual_qty=null},/ไม่ถูกต้อง/],
 ['missing material',x=>{x[0].materials=[]},/ไม่ตรง/],
 ['duplicate material',x=>{x[0].materials.push({...x[0].materials[0]})},/ไม่ตรง/],
 ['unbalanced material',x=>{x[0].materials[0].used_qty=10101},/ไม่ตรง/],
 ['missing material reason',x=>{x[0].materials[0].reason=''},/เหตุผล/],
 ['negative material',x=>{x[0].materials[0].waste_qty=-1},/ไม่ถูกต้อง/],
 ['missing item',x=>{x.length=0},/ผลผลิตจริง/],
 ['duplicate item',x=>{x.push({...x[0]})},/ไม่ตรง/],
 ['foreign item',x=>{x[0].item_id=id(99)},/ไม่ตรง/]
]
for(const [name,mutate,pattern] of invalidCases) await test(`${name} rolls back completely`,async()=>{const x=await seed();mutate(x);await assert.rejects(()=>complete(x),pattern);assert.equal(Number(await scalar(`SELECT on_hand FROM inv_stock_balances WHERE product_id='${id(3)}'`)),10400);assert.equal(Number(await scalar('SELECT count(*) FROM inv_stock_movements')),0);assert.equal(await scalar('SELECT status FROM pp_production_orders'),'processing')})
await test('insufficient stock rejects entire receipt',async()=>{const x=await seed();await db.exec('UPDATE inv_stock_balances SET on_hand=100');await assert.rejects(()=>complete(x),/ไม่เพียงพอ/);assert.equal(Number(await scalar('SELECT count(*) FROM inv_stock_movements')),0)})
await test('insufficient FIFO lots rolls back even after first consumption',async()=>{const x=await seed();await db.exec('UPDATE inv_stock_lots SET qty_remaining=100');await assert.rejects(()=>complete(x),/insufficient sellable lots/);assert.equal(Number(await scalar('SELECT sum(qty_remaining) FROM inv_stock_lots')),200);assert.equal(Number(await scalar('SELECT count(*) FROM inv_stock_movements')),0)})
await test('max-stock failure rolls back prior FIFO writes',async()=>{const x=await seed();await db.exec('UPDATE pp_recipes SET max_stock=5000');await assert.rejects(()=>complete(x),/Max/);assert.equal(Number(await scalar('SELECT sum(qty_remaining) FROM inv_stock_lots')),10400);assert.equal(Number(await scalar('SELECT count(*) FROM inv_stock_movements')),0)})
await test('byproduct value greater than consumed cost rejects entire transaction',async()=>{const x=await seed();await db.exec(`INSERT INTO pp_recipe_removes VALUES('${id(9)}','${id(5)}','${id(4)}',1,100)`);x[0].byproducts=[{product_id:id(4),qty:500}];await assert.rejects(()=>complete(x),/เกินต้นทุน/);assert.equal(Number(await scalar('SELECT count(*) FROM inv_stock_movements')),0)})
for (const role of ['production','packing_staff','account','sales-tr','manager','admin-tr','production_mb','picker']) {
 await test(`${role} cannot receive via RPC or forge completed status`,async()=>{
  const x=await seed();await q('UPDATE us_users SET role=$1',[role])
  await assert.rejects(()=>complete(x),/ไม่มีสิทธิ์/)
  await assert.rejects(()=>q("UPDATE pp_production_orders SET status='completed'"),/ไม่มีสิทธิ์/)
  assert.equal(await scalar('SELECT status FROM pp_production_orders'),'processing')
  assert.equal(Number(await scalar('SELECT count(*) FROM inv_stock_movements')),0)
 })
}
for (const role of ['store','admin','superadmin']) {
 await test(`${role} can receive as authenticated with actual stock and actor recorded`,async()=>{
  const x=await seed();await q('UPDATE us_users SET role=$1',[role])
  await db.exec('GRANT USAGE ON SCHEMA public,auth TO authenticated; GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA public TO authenticated; SET ROLE authenticated')
  try { await complete(x) } finally { await db.exec('RESET ROLE') }
  assert.equal(await scalar('SELECT status FROM pp_production_orders'),'completed')
  assert.equal(await scalar('SELECT completed_by FROM pp_production_orders'),id(1))
  assert.equal(Number(await scalar(`SELECT on_hand FROM inv_stock_balances WHERE product_id='${id(2)}'`)),5050)
 })
}
for (const role of ['production','packing_staff','admin','superadmin','store','account']) {
 const allowed=['production','packing_staff','admin','superadmin'].includes(role)
 await test(`${role} ${allowed?'can':'cannot'} start processing`,async()=>{
  await seed();await db.exec("UPDATE pp_production_orders SET status='approved'")
  await q('UPDATE us_users SET role=$1',[role])
  await db.exec('SET ROLE authenticated')
  try {
   if(allowed) await q('SELECT rpc_start_production_order($1)',[id(7)])
   else {
    await assert.rejects(()=>q('SELECT rpc_start_production_order($1)',[id(7)]),/ไม่มีสิทธิ์/)
    await assert.rejects(()=>q("UPDATE pp_production_orders SET status='processing'"),/ไม่มีสิทธิ์/)
   }
  } finally { await db.exec('RESET ROLE') }
  assert.equal(await scalar('SELECT status FROM pp_production_orders'),allowed?'processing':'approved')
  if(allowed) assert.equal(await scalar('SELECT started_by FROM pp_production_orders'),id(1))
 })
}
for (const role of ['store','admin','superadmin','production','packing_staff']) {
 await test(`inactive ${role} cannot start or receive`,async()=>{
  const x=await seed();await q('UPDATE us_users SET role=$1,is_active=false',[role])
  await assert.rejects(()=>complete(x),/ไม่มีสิทธิ์/)
  await assert.rejects(()=>q('SELECT rpc_start_production_order($1)',[id(7)]),/ไม่มีสิทธิ์/)
 })
}
await test('unauthenticated caller cannot start or receive',async()=>{
 const x=await seed();await q("SELECT set_config('request.jwt.claim.sub','',false)")
 await assert.rejects(()=>complete(x),/ไม่มีสิทธิ์/)
 await assert.rejects(()=>q('SELECT rpc_start_production_order($1)',[id(7)]),/ไม่มีสิทธิ์/)
})
await test('legacy completion fails closed',async()=>{await seed();await assert.rejects(()=>q('SELECT rpc_complete_production_order($1)',[id(7)]),/ผลผลิตจริง/)})
await test('authenticated role can execute RPC but cannot forge completion',async()=>{
 const x=await seed();await db.exec('GRANT USAGE ON SCHEMA public,auth TO authenticated; GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA public TO authenticated; SET ROLE authenticated;')
 await assert.rejects(()=>q("UPDATE pp_production_orders SET status='completed'"),/ผลผลิตจริง/)
 await assert.rejects(()=>q('UPDATE pp_production_order_items SET actual_qty=1'),/ผลผลิตจริง/)
 await complete(x);await db.exec('RESET ROLE');assert.equal(await scalar('SELECT status FROM pp_production_orders'),'completed')
})
await test('multiple outputs sharing a material are deducted once per allocation',async()=>{
 const x=await seed()
 await db.exec(`INSERT INTO pr_products VALUES('${id(12)}','PP2','Second finished',0,0);
 INSERT INTO pp_recipes VALUES('${id(15)}','${id(12)}',10000);
 INSERT INTO pp_recipe_includes VALUES('${id(16)}','${id(15)}','${id(3)}',2);
 INSERT INTO pp_production_order_items(id,order_id,product_id,qty) VALUES('${id(18)}','${id(7)}','${id(12)}',100);
 UPDATE inv_stock_balances SET on_hand=10600;
 INSERT INTO inv_stock_lots(product_id,qty_initial,qty_remaining,unit_cost,created_at) VALUES('${id(3)}',200,200,4,'2026-03-01');`)
 x.push({item_id:id(18),actual_qty:100,materials:[{product_id:id(3),used_qty:200,returned_qty:0,waste_qty:0,shortage_qty:0,reason:''}],byproducts:[]})
 await complete(x)
 assert.equal(Number(await scalar(`SELECT on_hand FROM inv_stock_balances WHERE product_id='${id(3)}'`)),100)
 assert.equal(Number(await scalar(`SELECT on_hand FROM inv_stock_balances WHERE product_id='${id(12)}'`)),100)
 assert.equal(Number(await scalar('SELECT sum(total_cost) FROM pp_production_order_items')),21000)
 assert.equal(Number(await scalar(`SELECT sum(qty_remaining) FROM inv_stock_lots WHERE product_id='${id(3)}'`)),100)
})
await test('second output failure rolls back first receipt and all material deductions',async()=>{
 const x=await seed()
 await db.exec(`INSERT INTO pr_products VALUES('${id(12)}','PP2','Second finished',0,0);
 INSERT INTO pp_recipes VALUES('${id(15)}','${id(12)}',10000);
 INSERT INTO pp_recipe_includes VALUES('${id(16)}','${id(15)}','${id(3)}',2);
 INSERT INTO pp_production_order_items(id,order_id,product_id,qty) VALUES('${id(18)}','${id(7)}','${id(12)}',100);`)
 x.push({item_id:id(18),actual_qty:100,materials:[{product_id:id(3),used_qty:200,returned_qty:0,waste_qty:0,shortage_qty:0,reason:''}],byproducts:[]})
 await assert.rejects(()=>complete(x),/ไม่เพียงพอ/)
 assert.equal(Number(await scalar('SELECT count(*) FROM inv_stock_movements')),0)
 assert.equal(Number(await scalar('SELECT sum(qty_remaining) FROM inv_stock_lots')),10400)
 assert.equal(Number(await scalar('SELECT count(*) FROM pp_production_order_items WHERE actual_qty IS NOT NULL')),0)
})
await test('changed recipe is detected before committing completion',async()=>{
 const x=await seed();await db.exec('UPDATE pp_recipe_includes SET qty=3')
 await assert.rejects(()=>complete(x),/ไม่ตรง/)
 assert.equal(Number(await scalar('SELECT count(*) FROM inv_stock_movements')),0)
})
await test('completed report stays unchanged when recipes are edited later',async()=>{
 const x=await seed();await complete(x);const before=await report()
 await db.exec('UPDATE pp_recipe_includes SET qty=3')
 assert.deepEqual(await report(),before)
})
await test('fractional BOM requirements round to inventory precision',async()=>{
 const x=await seed();await db.exec('UPDATE pp_production_order_items SET qty=0.25; UPDATE pp_recipe_includes SET qty=0.1;')
 Object.assign(x[0],{actual_qty:0.25,reason:'',reason_code:''})
 Object.assign(x[0].materials[0],{used_qty:0.03,returned_qty:0,waste_qty:0,shortage_qty:0,reason:''})
 await complete(x);const r=await report();assert.equal(r.materials[0].planned_qty,0.03);assert.equal(r.material_cost,0.06)
})
await db.close();console.log(`${passed} database integration scenarios passed`)
