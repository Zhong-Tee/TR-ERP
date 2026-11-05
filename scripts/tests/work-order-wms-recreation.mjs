// Isolated PostgreSQL regression fixture; never connects to production.
// Runs the existing WMS/reservation/deduction functions. FIFO/cost helpers are
// recorded stubs: this tests orchestration, not the FIFO implementation itself.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'

const db = new PGlite()
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const migration = async name => fs.readFile(new URL(`../../supabase/legacy-migrations/pre-baseline-20261104/${name}.sql`, import.meta.url), 'utf8')
const fn = (sql, name) => {
  const match = sql.match(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION (?:public\\.)?${name}\\([\\s\\S]*?\\$\\$;`))
  assert.ok(match, `Missing function ${name}`)
  return match[0]
}
const old502 = await migration('502_fix_wms_picker_plan_atomic_sub_warehouse')
const old161 = await migration('161_wms_auto_consume_non_pick')
const old625 = await migration('625_document_stock_reservations')
const old627 = await migration('627_sales_draft_no_reservation')
const patch = await migration('672_defer_work_order_auto_wms_until_linked')
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
    CREATE TABLE us_users(id uuid PRIMARY KEY,role text);
    INSERT INTO us_users VALUES('${id(1)}','production'),('${id(2)}','sales-tr');
    SELECT set_config('test.actor','${id(1)}',false);
    CREATE TABLE or_work_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_order_name text,status text,order_count int,created_at timestamptz DEFAULT now());
    CREATE TABLE or_orders(id uuid PRIMARY KEY,bill_no text,status text,channel_code text,work_order_id uuid,work_order_name text,
      plan_released_from_work_order text,plan_released_from_work_order_id uuid,plan_released_at timestamptz,
      stock_reservation_enabled boolean DEFAULT true,claim_shipping_confirmed_at timestamptz);
    CREATE TABLE pr_products(id uuid PRIMARY KEY,product_code text,product_name text,product_category text,storage_location text,unit_name text);
    CREATE TABLE or_order_items(id uuid PRIMARY KEY,order_id uuid,product_id uuid,product_name text,quantity numeric,is_detail_row boolean DEFAULT false,cancellation_stock_action text);
    CREATE TABLE plan_jobs(id text PRIMARY KEY,date text,name text,work_order_id uuid,cut text,qty jsonb,tracks jsonb,line_assignments jsonb,manual_plan_starts jsonb,locked_plans jsonb,order_index int);
    CREATE TABLE wms_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_order_id uuid,order_id text,source_order_id uuid,source_order_item_id uuid,
      product_code text,product_name text,location text,qty numeric,unit_name text,status text,assigned_to uuid,fulfillment_mode text,end_time timestamptz);
    CREATE TABLE inv_stock_balances(product_id uuid PRIMARY KEY,on_hand numeric,reserved numeric,safety_stock numeric,updated_at timestamptz);
    CREATE TABLE inv_stock_movements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_id uuid,movement_type text,qty numeric,ref_type text,ref_id uuid,note text);
    CREATE TABLE inv_document_reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_type text,source_id uuid,product_id uuid,qty numeric,expires_on date,updated_at timestamptz,UNIQUE(source_type,source_id,product_id));
    CREATE TABLE inv_document_reservation_history(id bigint GENERATED ALWAYS AS IDENTITY,reservation_id uuid,source_type text,source_id uuid,product_id uuid,old_qty numeric,new_qty numeric);
    CREATE TABLE or_prebill_documents(id uuid PRIMARY KEY,stock_reservation_enabled boolean,status text,valid_until date);
    CREATE TABLE or_prebill_items(document_id uuid,product_id uuid,quantity numeric,is_detail_row boolean);
    CREATE TABLE helper_calls(name text,product_id uuid,qty numeric);
    CREATE TABLE wms_calls(ready boolean);
    CREATE FUNCTION fn_wms_item_fulfillment_mode(uuid,text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT $2 $$;
    CREATE FUNCTION merge_plan_tracks_by_work_order_id(uuid,text,jsonb) RETURNS void LANGUAGE sql AS $$ UPDATE plan_jobs SET tracks=jsonb_build_object($2,$3) WHERE work_order_id=$1 $$;
    CREATE FUNCTION fn_reconcile_sellable_lots_to_on_hand(uuid) RETURNS void LANGUAGE sql AS $$ INSERT INTO helper_calls VALUES('reconcile',$1,NULL) $$;
    CREATE FUNCTION fn_consume_stock_fifo(uuid,numeric,uuid) RETURNS void LANGUAGE sql AS $$ INSERT INTO helper_calls VALUES('fifo',$1,$2) $$;
    CREATE FUNCTION fn_recalc_product_landed_cost(uuid) RETURNS void LANGUAGE sql AS $$ INSERT INTO helper_calls VALUES('cost',$1,NULL) $$;
    CREATE FUNCTION fn_reverse_wms_stock(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
  `)
  for (const name of ['fn_set_document_reservation', 'fn_document_reservation_changed', 'fn_transfer_document_reservation_to_wms', 'fn_sync_wms_document_reservation', 'inv_deduct_stock_on_wms_picked']) {
    await db.exec(fn(old625, name))
  }
  await db.exec(fn(old627, 'fn_sync_document_reservations'))
  await db.exec(fn(old502, 'fn_wms_try_auto_consume_non_pick').replace('fn_wms_try_auto_consume_non_pick(', 'fn_wms_auto_impl('))
  await db.exec(`
    CREATE FUNCTION fn_wms_try_auto_consume_non_pick(text) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO wms_calls SELECT (SELECT count(*) FROM or_orders o WHERE o.work_order_name=$1)>=order_count FROM or_work_orders WHERE work_order_name=$1;
      PERFORM fn_wms_auto_impl($1);
    END $$;
  `)
  await db.exec(fn(old161, 'trg_or_work_orders_try_auto_non_pick'))
  await db.exec(fn(old161, 'trg_or_orders_try_auto_non_pick'))
  await db.exec(fn(old502, 'rpc_create_work_order_with_plan'))
  await db.exec(`
    CREATE TRIGGER header_auto AFTER INSERT OR UPDATE OF status,work_order_name ON or_work_orders FOR EACH ROW EXECUTE FUNCTION trg_or_work_orders_try_auto_non_pick();
    CREATE TRIGGER link_auto AFTER INSERT OR UPDATE OF work_order_name ON or_orders FOR EACH ROW EXECUTE FUNCTION trg_or_orders_try_auto_non_pick();
    CREATE TRIGGER zzz_document_reservation AFTER INSERT OR UPDATE OR DELETE ON or_orders FOR EACH ROW EXECUTE FUNCTION fn_document_reservation_changed();
    CREATE TRIGGER aa_transfer_document_reservation BEFORE UPDATE OF status ON wms_orders FOR EACH ROW EXECUTE FUNCTION fn_transfer_document_reservation_to_wms();
    CREATE TRIGGER trg_inv_deduct AFTER UPDATE OF status ON wms_orders FOR EACH ROW EXECUTE FUNCTION inv_deduct_stock_on_wms_picked();
    CREATE TRIGGER zzz_sync_wms_document_reservation AFTER UPDATE OR DELETE ON wms_orders FOR EACH ROW EXECUTE FUNCTION fn_sync_wms_document_reservation();
  `)

  await db.exec(`
    ALTER TABLE wms_orders ADD stock_action text, ADD created_at timestamptz DEFAULT now();
    ALTER TABLE or_work_orders ADD wms_review_completed_at timestamptz;
    ALTER TABLE pr_products ADD rubber_code text;
    CREATE TABLE wms_order_summaries(order_id text,checked_at timestamptz);
    CREATE FUNCTION is_current_wms_store_backup() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE FUNCTION fn_sync_plan_pick_end_from_wms(uuid,timestamptz DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
    INSERT INTO us_users VALUES('${id(3)}','picker'),('${id(4)}','picker');
  `)
  await db.exec(fn(await migration('595_reliable_wms_completion_for_sub_warehouse'),'fn_stamp_wms_review_completed_at'))
  const repair=await fs.readFile(new URL('../../supabase/migrations/20261105110000_preserve_wms_on_work_order_recreation.sql',import.meta.url),'utf8')
  await db.exec(repair.split('CREATE OR REPLACE FUNCTION public.rpc_get_sub_warehouse_daily_stock_sheet')[0]+'COMMIT;')
  for(const [n,mode] of [[10,'warehouse_pick'],[11,'system_complete'],[12,'sub_warehouse_skip']]) {
    await db.query('INSERT INTO pr_products(id,product_code,product_name,product_category,storage_location,unit_name) VALUES($1,$2,$3,$4,$5,$6)',[id(n),'P'+n,'Test '+n,mode,'A','ชิ้น'])
    await db.query('INSERT INTO inv_stock_balances VALUES($1,100,0,0,now())',[id(n)])
  }
  await db.query("INSERT INTO or_orders(id,bill_no,status,channel_code) VALUES($1,'B1','ใบสั่งงาน','FSPTR')",[id(20)])
  for(let n=10;n<=12;n++) await db.query('INSERT INTO or_order_items(id,order_id,product_id,product_name,quantity) VALUES($1,$2,$3,$4,1)',[id(n+20),id(20),id(n),'Test '+n])
  const create=async(name,job,orders=[id(20)])=>(await db.query("SELECT rpc_create_work_order_with_plan($1,$2::uuid[],$3,'2026-11-05','10:00','{}',1) r",[name,orders,job])).rows[0].r.work_order_id
  const assign=async(wo,picker=id(3))=>(await db.query('SELECT rpc_assign_wms_for_work_order_v2($1,$2) r',[wo,picker])).rows[0].r
  const cancel=wo=>db.query('SELECT rpc_cancel_work_order_preserve_wms($1)',[wo])
  const queue=async()=>(await db.query('SELECT rpc_wms_work_orders_needing_picker() r')).rows[0].r
  const stock=async()=>(await db.query('SELECT product_id,on_hand,reserved FROM inv_stock_balances ORDER BY product_id')).rows
  const wo1=await create('FSPTR-051169-R1','J1')
  assert((await queue()).includes('FSPTR-051169-R1'))
  assert.equal((await assign(wo1)).warehouse_pick_main,1)
  await db.query("UPDATE wms_orders SET status='picked' WHERE work_order_id=$1 AND fulfillment_mode='warehouse_pick'",[wo1])
  await db.query("UPDATE wms_orders SET status='correct',end_time=now() WHERE work_order_id=$1 AND fulfillment_mode='warehouse_pick'",[wo1])
  const beforeStock=await stock()
  const beforeRows=(await db.query('SELECT * FROM wms_orders ORDER BY id')).rows
  const beforeMoves=(await db.query('SELECT * FROM inv_stock_movements ORDER BY id')).rows
  await cancel(wo1)
  const wo2=await create('FSPTR-051169-R2','J2')
  const afterRows=(await db.query('SELECT * FROM wms_orders ORDER BY id')).rows
  assert.equal(afterRows.length,3)
  assert.deepEqual(await stock(),beforeStock)
  assert.deepEqual((await db.query('SELECT * FROM inv_stock_movements ORDER BY id')).rows,beforeMoves)
  for(let i=0;i<3;i++) {
    assert.equal(afterRows[i].id,beforeRows[i].id)
    assert.equal(afterRows[i].work_order_id,wo2)
    for(const key of ['qty','status','assigned_to','end_time','stock_action']) assert.deepEqual(afterRows[i][key],beforeRows[i][key])
  }
  assert.equal((await db.query('SELECT count(*) n FROM wms_work_order_relinks')).rows[0].n,3)
  assert.equal((await db.query('SELECT fn_relink_wms_to_work_order($1) n',[wo2])).rows[0].n,0)
  assert(!(await queue()).includes('FSPTR-051169-R2'))
  assert.equal((await assign(wo2)).success,false)
  // New items alongside reused completed items must remain assignable.
  await cancel(wo2)
  await db.query("INSERT INTO or_orders(id,bill_no,status,channel_code) VALUES($1,'B2','ใบสั่งงาน','FSPTR')",[id(21)])
  await db.query("INSERT INTO or_order_items(id,order_id,product_id,product_name,quantity) VALUES($1,$2,$3,'new',1)",[id(40),id(21),id(10)])
  const wo3=await create('FSPTR-051169-R3','J3',[id(20),id(21)])
  assert((await queue()).includes('FSPTR-051169-R3'))
  const result=await assign(wo3,id(4))
  assert.equal(result.success,true);assert.equal(result.warehouse_pick_main,1)
  assert.equal((await db.query("SELECT count(*) n FROM wms_orders WHERE status='pending'")).rows[0].n,1)
  assert.deepEqual((await stock()).map(r=>r.on_hand),beforeStock.map(r=>r.on_hand))
  // A second assignment cannot duplicate spare or item rows or pretend to succeed.
  assert.equal((await assign(wo3,id(4))).success,false)
  assert.equal((await db.query('SELECT count(*) n FROM wms_orders')).rows[0].n,4)
  // Changed quantities must stop recreation atomically, keeping stock/history intact.
  await cancel(wo3)
  await assert.rejects(db.query("UPDATE wms_orders SET status='picked' WHERE status='pending'"),/ใบงานถูกยกเลิก/)
  await db.query('UPDATE or_order_items SET quantity=2 WHERE id=$1',[id(30)])
  const beforeConflict=await stock()
  await assert.rejects(create('FSPTR-051169-R4','J4',[id(20),id(21)]),/จำนวน/)
  assert.equal((await db.query("SELECT count(*) n FROM or_work_orders WHERE work_order_name='FSPTR-051169-R4'")).rows[0].n,0)
  assert.deepEqual(await stock(),beforeConflict)
  await db.query("SELECT set_config('test.actor',$1,false)",[id(2)])
  await assert.rejects(cancel(wo3),/ไม่มีสิทธิ์/)
  await db.query("SELECT set_config('test.actor',$1,false)",[id(1)])
  await db.query('UPDATE or_order_items SET quantity=1 WHERE id=$1',[id(30)])
  const wo4=await create('FSPTR-051169-R4','J4',[id(20),id(21)])
  // An unfinished assignment follows its bill; it must keep the same Picker.
  const pending=(await db.query("SELECT assigned_to,status FROM wms_orders WHERE status='pending'")).rows
  assert.equal(pending.length,1);assert.equal(pending[0].assigned_to,id(4))
  assert.equal((await assign(wo4,id(3))).success,false)
  // Unlinked spare rows cannot be silently orphaned by cancellation.
  await db.query("INSERT INTO wms_orders(work_order_id,order_id,product_code,qty,status,fulfillment_mode) VALUES($1,'FSPTR-051169-R4','SPARE_PART',1,'pending','warehouse_pick')",[wo4])
  await assert.rejects(cancel(wo4),/อะไหล่/)
  assert.equal((await db.query('SELECT count(*) n FROM or_orders WHERE work_order_id=$1',[wo4])).rows[0].n,2)
  assert.equal((await db.query('SELECT status FROM or_work_orders WHERE id=$1',[wo4])).rows[0].status,'กำลังผลิต')
  console.log('PASS: completed fulfillment preserved, no extra stock/FIFO movement, idempotent relink, mixed missing-item assignment, no zero-row success, quantity conflict rollback, and role guard')
} finally { await db.close() }
