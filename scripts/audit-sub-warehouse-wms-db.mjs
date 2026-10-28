// Read-only inspection by default. Rehearse rolls back; apply installs migration 673 only.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'
const mode=process.argv[2] || 'inspect'
assert.ok(['inspect','verify','rehearse','apply'].includes(mode))
const dump=execFileSync('supabase',['db','dump','--linked','--dry-run'],{encoding:'utf8',stdio:['ignore','pipe','pipe']})
const vars={}
for(const m of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'')
const db=new pg.Client({host:vars.PGHOST,port:Number(vars.PGPORT),user:vars.PGUSER,password:vars.PGPASSWORD,database:vars.PGDATABASE,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000})
try {
 await db.connect()
 await db.query('SET ROLE postgres')
 await db.query(['inspect','verify'].includes(mode)?'BEGIN READ ONLY':'BEGIN ISOLATION LEVEL REPEATABLE READ')
 await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'")
 const q=async(label,sql,args=[])=>{const rows=(await db.query(sql,args)).rows;console.log(JSON.stringify({label,rows}));return rows}
 if(mode==='inspect') {
  await q('triggers',`SELECT tgname,tgenabled,pg_get_triggerdef(oid) definition,pg_get_functiondef(tgfoid) function FROM pg_trigger WHERE tgrelid='inv_audit_items'::regclass AND NOT tgisinternal`)
  await q('scope',`SELECT a.id,a.status,a.created_at,count(*) items,count(*) FILTER(WHERE i.sub_warehouse_snapshot IS NOT NULL) saved,count(*) FILTER(WHERE i.sub_warehouse_snapshot IS NULL) legacy FROM inv_audits a JOIN inv_audit_items i ON i.audit_id=a.id GROUP BY a.id ORDER BY a.created_at DESC`)
  await q('policies',`SELECT tablename,policyname,roles,qual FROM pg_policies WHERE tablename IN ('wms_orders','wms_order_summaries','wms_requisitions','or_work_orders','or_orders')`)
 } else if(mode==='verify') {
  const result=(await db.query(`SELECT
    EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='673' AND name='fix_audit_sub_warehouse_wms_snapshot') installed,
    (SELECT count(*)::int FROM inv_audit_sub_warehouse_corrections) repaired_items,
    (SELECT count(*)::int FROM inv_audit_sub_warehouse_corrections c JOIN inv_audit_items i ON i.id=c.item_id
      WHERE i.sub_warehouse_snapshot IS DISTINCT FROM c.corrected_snapshot) repair_mismatches,
    (SELECT count(*)::int FROM inv_audit_items WHERE sub_warehouse_snapshot IS NULL) legacy_items_still_null,
    (SELECT sub_warehouse_snapshot FROM inv_audit_items WHERE id='49991f52-87e6-44bc-a070-9d6d2839fb9d') saved_example,
    fn_audit_sub_warehouse_snapshot('32c0f81f-28e1-4615-8ad5-098344734202','2026-10-27T09:03:46.429Z') recomputed_example
  `)).rows[0]
  assert.equal(result.installed,true)
  assert.equal(result.repair_mismatches,0)
  assert.equal(result.saved_example[0].qty,46)
  assert.deepEqual(result.saved_example,result.recomputed_example)
  await db.query('ROLLBACK')
  const path='reports/audit-sub-warehouse-wms-apply-2026-10-28.json'
  const report=JSON.parse(await fs.readFile(path,'utf8'))
  report.committed=true
  report.post_commit_verification={verified_at:new Date().toISOString(),...result}
  await fs.writeFile(path,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(result))
 } else {
  await db.query("SELECT pg_advisory_xact_lock(67320261028)")
  assert.equal((await db.query("SELECT count(*)::int n FROM supabase_migrations.schema_migrations WHERE version='673'")).rows[0].n,0,'Migration 673 is already installed')
  const fingerprints=async()=>(await db.query(`SELECT
    (SELECT md5(COALESCE(string_agg(to_jsonb(a)::text,'' ORDER BY a.id),'')) FROM inv_audits a) audits,
    (SELECT md5(COALESCE(string_agg((to_jsonb(i)-'sub_warehouse_snapshot')::text,'' ORDER BY i.id),'')) FROM inv_audit_items i) item_counts,
    (SELECT md5(COALESCE(string_agg(to_jsonb(s)::text,'' ORDER BY s.product_id),'')) FROM inv_stock_balances s) main_stock,
    (SELECT md5(COALESCE(string_agg(to_jsonb(s)::text,'' ORDER BY s.id),'')) FROM wh_sub_warehouse_stock_moves s) sub_moves,
    (SELECT md5(COALESCE(string_agg(to_jsonb(s)::text,'' ORDER BY s.id),'')) FROM wms_orders s) wms_orders
  `)).rows[0]
  const before=await fingerprints()
  console.log('Reconstructing original sub-warehouse balances at each Audit cutoff')
  await db.query(`CREATE TEMP TABLE audit_sub_wms_before ON COMMIT DROP AS
    SELECT i.id,i.audit_id,i.product_id,a.audit_no,a.status,COALESCE(a.frozen_at,a.created_at) cutoff_at,
      i.sub_warehouse_snapshot IS NOT NULL saved,
      COALESCE(i.sub_warehouse_snapshot,fn_audit_sub_warehouse_snapshot(i.product_id,COALESCE(a.frozen_at,a.created_at))) previous_snapshot
    FROM inv_audit_items i JOIN inv_audits a ON a.id=i.audit_id
    WHERE EXISTS(SELECT 1 FROM wh_sub_warehouse_products p WHERE p.product_id=i.product_id)
      OR EXISTS(SELECT 1 FROM wh_sub_warehouse_stock_moves m WHERE m.product_id=i.product_id)
      OR jsonb_array_length(i.sub_warehouse_snapshot)>0`)
  const path='supabase/migrations/673_fix_audit_sub_warehouse_wms_snapshot.sql'
  const source=await fs.readFile(path,'utf8')
  const sql=source.replace(/^BEGIN;\s*/,'').replace(/^COMMIT;$/m,'')
  await db.query(sql)
  assert.deepEqual(await fingerprints(),before,'Audit counts, headers, or stock were modified')
  console.log('Comparing saved and reconstructed legacy snapshots')
  const details=(await db.query(`SELECT b.*,p.product_code,p.product_name,
    CASE WHEN b.saved THEN i.sub_warehouse_snapshot
      ELSE fn_audit_sub_warehouse_snapshot(b.product_id,b.cutoff_at) END corrected_snapshot
    FROM audit_sub_wms_before b JOIN inv_audit_items i ON i.id=b.id
    JOIN pr_products p ON p.id=b.product_id ORDER BY b.cutoff_at DESC,p.product_code`)).rows
  const changed=details.filter(r=>JSON.stringify(r.previous_snapshot)!==JSON.stringify(r.corrected_snapshot))
  const summaries=new Map()
  for(const r of changed) {
   const s=summaries.get(r.audit_id)||{audit_id:r.audit_id,audit_no:r.audit_no,status:r.status,cutoff_at:r.cutoff_at,saved_items_corrected:0,legacy_items_corrected:0}
   s[r.saved?'saved_items_corrected':'legacy_items_corrected']++
   summaries.set(r.audit_id,s)
  }
  const example=details.find(r=>r.product_code==='110000022' && r.saved)
  assert.ok(example,'Reported product not found')
  assert.equal(example.corrected_snapshot.find(w=>w.name==='คลังแผนกซับลิเมชั่น')?.qty,46)
  const triggers=(await db.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='inv_audit_items'::regclass AND NOT tgisinternal ORDER BY tgname")).rows
  assert.ok(triggers.every(t=>t.tgenabled==='O'),'Validation triggers were not restored')
  // Check the legacy RPC with an actual Store JWT role, not only as postgres.
  const store=(await db.query("SELECT id FROM us_users WHERE role='store' AND is_active ORDER BY id LIMIT 1")).rows[0]
  assert.ok(store,'Active Store user required for permission validation')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",[store.id])
  await db.query('SET LOCAL ROLE authenticated')
  const legacy=changed.find(r=>!r.saved)
  if(legacy) {
   const rpc=(await db.query('SELECT * FROM rpc_get_audit_legacy_sub_warehouse_snapshots($1)',[legacy.audit_id])).rows
   assert.deepEqual(rpc.find(r=>r.item_id===legacy.id)?.snapshot,legacy.corrected_snapshot,'Store legacy RPC differs from expected snapshot')
  }
  await db.query('SET LOCAL ROLE postgres')
  const totals=(await db.query('SELECT count(*)::int items,count(DISTINCT audit_id)::int audits FROM inv_audit_items')).rows[0]
  const report={mode,migration:'673',committed:false,checked_at:new Date().toISOString(),totals,evaluated_sub_warehouse_items:details.length,
   affected_audits:summaries.size,saved_items_corrected:changed.filter(r=>r.saved).length,legacy_items_corrected:changed.filter(r=>!r.saved).length,
   audit_counts_and_stock_unchanged:true,store_legacy_rpc_verified:true,triggers,example,audits:[...summaries.values()],details:changed}
  await fs.mkdir('reports',{recursive:true})
  await fs.writeFile(`reports/audit-sub-warehouse-wms-${mode}-2026-10-28.json`,JSON.stringify(report,null,2)+'\n')
  if(mode==='apply') {
   await db.query("INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES('673','fix_audit_sub_warehouse_wms_snapshot',$1::text[])",[[sql]])
   await db.query('COMMIT')
   report.committed=true
  } else await db.query('ROLLBACK')
  await fs.writeFile(`reports/audit-sub-warehouse-wms-${mode}-2026-10-28.json`,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({...report,details:undefined,example:undefined,audits:undefined,committed:mode==='apply'}))
 }
 if(mode==='inspect') await db.query('ROLLBACK')
} catch(e) {await db.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1} finally {await db.end()}
