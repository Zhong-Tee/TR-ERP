// Isolated PostgreSQL regression fixture; never connects to production.
// Runs the existing WMS/reservation/deduction functions. FIFO/cost helpers are
// recorded stubs: this tests orchestration, not the FIFO implementation itself.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { PGlite } from '../../.reservation-test-runtime/node_modules/@electric-sql/pglite/dist/index.js'

const db = new PGlite()
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const migration = async name => fs.readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8')
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
  const seed = async (count, mode = 'system_complete', stock = 10000) => {
    await db.exec('TRUNCATE or_orders,or_order_items,or_work_orders,plan_jobs,wms_orders,pr_products,inv_stock_balances,inv_stock_movements,inv_document_reservations,inv_document_reservation_history,helper_calls,wms_calls')
    await db.query('INSERT INTO pr_products VALUES($1,$2,$3,$4,$5,$6)', [id(3), 'TEST', 'Test', mode, '', 'ชิ้น'])
    await db.query('INSERT INTO inv_stock_balances VALUES($1,$2,0,0,now())', [id(3), stock])
    for (let n = 0; n < count; n++) {
      await db.query("INSERT INTO or_orders(id,bill_no,status) VALUES($1,$2,'ใบสั่งงาน')", [id(100 + n), `B${n}`])
      await db.query('INSERT INTO or_order_items(id,order_id,product_id,product_name,quantity) VALUES($1,$2,$3,$4,2)', [id(1000 + n), id(100 + n), id(3), 'Test'])
    }
    await db.exec(`SELECT fn_sync_document_reservations('order',id) FROM or_orders`)
  }
  const create = async (count, job = 'J1') => db.query("SELECT rpc_create_work_order_with_plan('TEST-R1',$1::uuid[],$2,'2026-10-26','11:39','{}',0) result", [Array.from({ length: count }, (_, n) => id(100 + n)), job])
  const snapshot = async () => (await db.query(`SELECT
    (SELECT count(*)::int FROM wms_calls WHERE ready) ready_calls,
    (SELECT count(*)::int FROM wms_orders) wms_rows,
    (SELECT count(*)::int FROM wms_orders WHERE status='correct') correct_rows,
    (SELECT sum(on_hand)::text FROM inv_stock_balances) on_hand,
    (SELECT sum(reserved)::text FROM inv_stock_balances) reserved,
    (SELECT count(*)::int FROM inv_stock_movements) movements,
    (SELECT coalesce(sum(qty),0)::text FROM inv_stock_movements) movement_qty,
    (SELECT coalesce(sum(qty),0)::text FROM inv_document_reservations) document_reserved,
    (SELECT count(*)::int FROM helper_calls WHERE name='fifo') fifo_calls,
    (SELECT coalesce(sum(qty),0)::text FROM helper_calls WHERE name='fifo') fifo_qty,
    (SELECT count(*)::int FROM plan_jobs WHERE tracks ? 'เบิก') completed_plan_rows
  `)).rows[0]

  await seed(50)
  await create(50)
  const before = await snapshot()
  assert.equal(before.ready_calls, 51) // 50 row triggers + final RPC pass
  await db.exec(patch)
  await db.exec(patch) // safe to reapply
  await seed(50)
  await create(50)
  const after = await snapshot()
  assert.equal(after.ready_calls, 1)
  assert.deepEqual({ ...after, ready_calls: 0 }, { ...before, ready_calls: 0 })
  assert.equal(after.on_hand, '9900')
  assert.equal(after.reserved, '0')
  assert.equal(after.fifo_calls, 50)
  assert.equal(after.fifo_qty, '100')
  assert.equal(after.completed_plan_rows, 1)
  assert.equal((await db.query("SELECT current_setting('app.defer_auto_wms_work_order_id',true) value")).rows[0].value, '')
  await assert.rejects(create(50, 'J2'), /ไม่อยู่ในคิว/)
  assert.deepEqual(await snapshot(), after)

  // Reproduce the reported batch sizes and a mixed automatic/Picker job.
  // The caller's channel is intentionally irrelevant to these server functions;
  // actual product fulfillment mode determines automatic stock processing.
  const reportedBatches = []
  for (const [count, mixed] of [[37, false], [23, false], [37, true]]) {
    const prepare = async () => {
      await seed(count)
      if (!mixed) return
      for (const [product, mode] of [[4, 'warehouse_pick'], [5, 'sub_warehouse_skip']]) {
        await db.query('INSERT INTO pr_products VALUES($1,$2,$3,$4,$5,$6)', [id(product), `TEST${product}`, 'Test', mode, '', 'ชิ้น'])
        await db.query('INSERT INTO inv_stock_balances VALUES($1,10000,0,0,now())', [id(product)])
        const itemIds = Array.from({ length: count }, (_, n) => n).filter(n => n % 3 === product - 3).map(n => id(1000 + n))
        await db.query('UPDATE or_order_items SET product_id=$1 WHERE id=ANY($2::uuid[])', [id(product), itemIds])
      }
      await db.exec("SELECT fn_sync_document_reservations('order',id) FROM or_orders")
    }
    await db.exec(fn(old161, 'trg_or_orders_try_auto_non_pick'))
    await db.exec(fn(old502, 'rpc_create_work_order_with_plan'))
    await prepare()
    await create(count)
    const original = await snapshot()
    assert.equal(original.ready_calls, count + 1)
    await db.exec(patch)
    await prepare()
    await create(count)
    const optimized = await snapshot()
    assert.equal(optimized.ready_calls, 1)
    assert.deepEqual({ ...optimized, ready_calls: 0 }, { ...original, ready_calls: 0 })
    if (mixed) {
      assert.equal(optimized.wms_rows, 25)
      assert.equal(optimized.document_reserved, '24')
      assert.equal(optimized.completed_plan_rows, 0)
    }
    reportedBatches.push({ bills: count, mixed, scansBefore: original.ready_calls, scansAfter: optimized.ready_calls })
  }

  // Automatic sub-warehouse mode and all-picker mode preserve their behavior.
  for (const mode of ['sub_warehouse_skip', 'warehouse_pick']) {
    await seed(3, mode)
    await create(3)
    const result = await snapshot()
    assert.equal(result.ready_calls, 1)
    assert.equal(result.wms_rows, mode === 'warehouse_pick' ? 0 : 3)
    assert.equal(result.on_hand, mode === 'warehouse_pick' ? '10000' : '9994')
    assert.equal(result.document_reserved, mode === 'warehouse_pick' ? '6' : '0')
    assert.equal(result.completed_plan_rows, mode === 'warehouse_pick' ? 0 : 1)
  }

  // Direct/legacy attachment still fires automatically outside the RPC.
  await seed(1)
  await db.exec("INSERT INTO or_work_orders(work_order_name,status,order_count) VALUES('DIRECT','กำลังผลิต',1)")
  await db.exec("UPDATE or_orders SET work_order_id=(SELECT id FROM or_work_orders),work_order_name='DIRECT'")
  assert.equal((await snapshot()).correct_rows, 1)

  // Failure while linking rolls back links/header/setting; failure while
  // consuming stock also rolls back the plan, movements and reservations.
  await seed(2)
  await db.exec(`CREATE FUNCTION reject_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture link failure'; END $$;
    CREATE TRIGGER reject_link BEFORE UPDATE ON or_orders FOR EACH ROW EXECUTE FUNCTION reject_link();`)
  await assert.rejects(create(2), /fixture link failure/)
  await db.exec('DROP TRIGGER reject_link ON or_orders')
  assert.equal((await db.query("SELECT coalesce(current_setting('app.defer_auto_wms_work_order_id',true),'') value")).rows[0].value, '')
  assert.equal((await db.query('SELECT count(*)::int n FROM or_work_orders')).rows[0].n, 0)
  await db.exec('UPDATE inv_stock_balances SET on_hand=0')
  await assert.rejects(create(2), /ไม่เพียงพอ/)
  assert.equal((await db.query('SELECT count(*)::int n FROM or_work_orders')).rows[0].n, 0)
  assert.equal((await db.query('SELECT count(*)::int n FROM plan_jobs')).rows[0].n, 0)
  assert.equal((await snapshot()).wms_rows, 0)
  assert.equal((await snapshot()).document_reserved, '4')
  await db.exec(`SELECT set_config('test.actor','${id(2)}',false)`)
  await assert.rejects(create(2), /ไม่มีสิทธิ์/)
  console.log(JSON.stringify({ passed: true, before, after, reportedBatches, checked: ['bulk scan count', 'stock/reservations', 'FIFO helper inputs', 'auto and picker modes', 'direct attachment', 'retry guard', 'rollback', 'permissions'] }, null, 2))
} finally {
  await db.close()
}
