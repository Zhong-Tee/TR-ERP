import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'
const mode=process.argv[2]||'rehearse'
if(!['rehearse','apply'].includes(mode)) throw Error('Expected rehearse|apply')
const dump=execFileSync('supabase',['db','dump','--linked','--dry-run'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000})
const vars={}
for(const m of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'')
const client=new pg.Client({host:vars.PGHOST,port:Number(vars.PGPORT),user:vars.PGUSER,password:vars.PGPASSWORD,database:vars.PGDATABASE,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000})
try {
 await client.connect();await client.query('SET ROLE postgres');await client.query('BEGIN')
 await client.query("SET LOCAL statement_timeout='60s'")
 const exists=(await client.query("SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='645'")).rowCount
 if(exists) throw Error('Migration already applied; do not repeat')
 const ids=(await client.query('SELECT fg_product_id id FROM roll_material_configs WHERE pairing_group_id IS NOT NULL GROUP BY fg_product_id')).rows.map(r=>r.id)
 const unchanged=async()=> (await client.query(`SELECT
 (SELECT md5(coalesce(string_agg(to_jsonb(b)::text,',' ORDER BY b.product_id),'')) FROM inv_stock_balances b WHERE NOT(product_id=ANY($1::uuid[]))) other_balances,
 (SELECT md5(coalesce(string_agg(to_jsonb(l)::text,',' ORDER BY l.id),'')) FROM inv_stock_lots l WHERE NOT(product_id=ANY($1::uuid[]))) other_lots,
 (SELECT md5(coalesce(string_agg(product_id::text||':'||coalesce(reserved,0)||':'||coalesce(safety_stock,0),',' ORDER BY product_id),'')) FROM inv_stock_balances WHERE product_id=ANY($1::uuid[])) protected_fg`,[ids])).rows[0]
 const before=await unchanged()
 const sql=await fs.readFile('supabase/migrations/645_initialize_multi_fg_pairing_stock.sql','utf8')
 await client.query(sql.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''))
 assert.deepEqual(await unchanged(),before,'Unrelated stock, RM, FG reservations and safety must stay unchanged')
 const rows=(await client.query(`SELECT p.product_code,b.on_hand,b.reserved,b.safety_stock,i.target_on_hand,
 (SELECT coalesce(sum(qty_remaining),0) FROM inv_stock_lots l WHERE l.product_id=p.id AND coalesce(is_safety_stock,false)=false) fifo
 FROM roll_pairing_stock_initializations i JOIN roll_material_configs c ON c.pairing_group_id=i.pairing_group_id
 JOIN pr_products p ON p.id=c.fg_product_id JOIN inv_stock_balances b ON b.product_id=p.id ORDER BY p.product_code`)).rows
 assert(rows.length>0)
 for(const r of rows){assert.equal(Number(r.on_hand),Number(r.target_on_hand));assert.equal(Number(r.fifo),Number(r.on_hand))}
 await client.query('SAVEPOINT tests')
 const actor=(await client.query("SELECT id FROM us_users WHERE role='superadmin' AND is_active IS TRUE LIMIT 1")).rows[0]
 await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[actor.id])
 const create=async(type)=>(await client.query("INSERT INTO pr_products(product_code,product_name,product_type,is_active) VALUES('PAIRINITTEST-'||gen_random_uuid()::text,'Rollback initialization test',$1,true) RETURNING id",[type])).rows[0].id
 const rm=await create('RM');const fgs=[await create('FG'),await create('FG')]
 await client.query('INSERT INTO inv_stock_balances(product_id,on_hand,reserved,safety_stock) VALUES($1,4,0,0)',[rm])
 await client.query('SELECT rpc_create_roll_pairing_group($1,$2,100)',[rm,fgs])
 assert.equal((await client.query('SELECT count(*)::int n FROM inv_stock_balances WHERE product_id=ANY($1::uuid[]) AND on_hand=400',[fgs])).rows[0].n,2)
 const group=(await client.query('SELECT pairing_group_id FROM roll_material_configs WHERE fg_product_id=$1',[fgs[0]])).rows[0].pairing_group_id
 await client.query('UPDATE inv_stock_balances SET on_hand=399 WHERE product_id=$1',[fgs[0]])
 await client.query('SELECT fn_initialize_multi_fg_pairing_stock($1)',[group])
 assert.equal(Number((await client.query('SELECT on_hand FROM inv_stock_balances WHERE product_id=$1',[fgs[0]])).rows[0].on_hand),399,'Repeated initialization must not undo a sale')
 assert.equal((await client.query("SELECT has_function_privilege('authenticated','public.fn_initialize_multi_fg_pairing_stock(uuid)','EXECUTE') allowed")).rows[0].allowed,false)
 await client.query('ROLLBACK TO SAVEPOINT tests')
 assert.deepEqual(await unchanged(),before)
 if(mode==='apply') {
  await client.query("INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES('645','initialize_multi_fg_pairing_stock',$1::text[])",[[sql]])
  await client.query('COMMIT')
 } else await client.query('ROLLBACK')
 await fs.writeFile(`reports/multi-fg-initialization-${mode}-2026-10-10.json`,JSON.stringify({mode,rows,checks:['all grouped FG initialized','FIFO matches FG','RM and unrelated stock unchanged','reservations and safety preserved','new pairing initialized atomically','repeat does not reset sales','private helper inaccessible'],committed:mode==='apply'},null,2))
 console.log(JSON.stringify({mode,rows,committed:mode==='apply',checksPassed:true}))
} catch(e) {await client.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1} finally {await client.end()}
