import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'
const dump = execFileSync('supabase',['db','dump','--linked','--dry-run'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000})
const vars = {}
for (const m of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'')
const client = new pg.Client({host:vars.PGHOST,port:Number(vars.PGPORT),user:vars.PGUSER,password:vars.PGPASSWORD,database:vars.PGDATABASE,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000})
try {
 await client.connect()
 await client.query('SET ROLE postgres')
 await client.query('BEGIN READ ONLY')
 await client.query("SET LOCAL statement_timeout='45s'")
 const rows=(await client.query(`SELECT fg.product_code fg_code,fg.product_name fg_name,c.sheets_per_roll,c.pairing_group_id,
 coalesce(b.on_hand,0) fg_on_hand,coalesce(b.reserved,0) reserved,
 round(sum(coalesce(rb.on_hand,0))*c.sheets_per_roll,2) calculated,
 jsonb_agg(jsonb_build_object('code',rm.product_code,'on_hand',rb.on_hand,'fg_count',(SELECT count(DISTINCT config_id) FROM roll_material_config_rms WHERE rm_product_id=rm.id))) rm
 FROM roll_material_configs c JOIN pr_products fg ON fg.id=c.fg_product_id
 JOIN roll_material_config_rms m ON m.config_id=c.id JOIN pr_products rm ON rm.id=m.rm_product_id
 LEFT JOIN inv_stock_balances b ON b.product_id=fg.id LEFT JOIN inv_stock_balances rb ON rb.product_id=rm.id
 GROUP BY c.id,fg.product_code,fg.product_name,b.on_hand,b.reserved ORDER BY fg.product_code`)).rows
 const guards=(await client.query(`SELECT strpos(pg_get_functiondef('public.fn_auto_convert_rm_to_fg_on_movement()'::regprocedure),'LIMIT 1')>0 AS receipt_single_pair`)).rows[0]
 await client.query('ROLLBACK')
 await fs.writeFile('reports/roll-pair-balances-2026-10-10.json',JSON.stringify({guards,rows},null,2))
 console.log(JSON.stringify({guards,pairs:rows.length,mismatches:rows.filter(r=>r.calculated!==null&&Number(r.calculated)!==Number(r.fg_on_hand)).length,pvc:rows.filter(r=>r.fg_name.startsWith('PVC')),shared:rows.filter(r=>r.rm.some(m=>m.fg_count>1))}))
} catch(e) { console.error(e.message);process.exitCode=1 } finally {await client.end()}
