// Setup: npm install --prefix .tmp/production-actual-tests --no-save @electric-sql/pglite@0.5.11
// Run: node scripts/test-audit-sub-warehouse-db.mjs (isolated, no live DB connection)
import { PGlite } from '../.tmp/production-actual-tests/node_modules/@electric-sql/pglite/dist/index.js'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const db=new PGlite()
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.sub',true)::uuid$$;
CREATE TABLE us_users(id uuid,role text,is_active boolean);
CREATE TABLE inv_audits(id uuid primary key,frozen_at timestamptz,created_at timestamptz);
CREATE TABLE inv_audit_items(id uuid primary key,audit_id uuid,product_id uuid,system_qty numeric,counted_qty numeric);
CREATE TABLE wh_sub_warehouses(id uuid primary key,name text,is_active boolean,created_at timestamptz);
CREATE TABLE wh_sub_warehouse_products(sub_warehouse_id uuid,product_id uuid,created_at timestamptz);
CREATE TABLE wh_sub_warehouse_stock_moves(sub_warehouse_id uuid,product_id uuid,qty_delta numeric,created_at timestamptz);
INSERT INTO us_users VALUES('${id(1)}','store',true),('${id(2)}','production',true);
INSERT INTO inv_audits VALUES('${id(3)}','2026-10-20','2026-10-20');
INSERT INTO inv_audit_items VALUES('${id(4)}','${id(3)}','${id(5)}',35,0);
INSERT INTO wh_sub_warehouses VALUES('${id(10)}','คลังผลิต',true,'2026-01-01'),('${id(11)}','คลังแพ็ก',true,'2026-01-01'),('${id(12)}','คลังใหม่',true,'2026-10-21'),('${id(13)}','คลังที่ปิด',false,'2026-01-01');
INSERT INTO wh_sub_warehouse_products VALUES('${id(10)}','${id(5)}','2026-01-01'),('${id(11)}','${id(5)}','2026-01-01'),('${id(12)}','${id(5)}','2026-10-21');
INSERT INTO wh_sub_warehouse_stock_moves VALUES('${id(10)}','${id(5)}',100,'2026-10-19'),('${id(10)}','${id(5)}',-20,'2026-10-19'),('${id(10)}','${id(5)}',999,'2026-10-21'),('${id(13)}','${id(5)}',7,'2026-10-19'),('${id(10)}','${id(50)}',1234,'2026-10-19');
ALTER TABLE inv_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_audit_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_audits ON inv_audits FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role='store' AND is_active));
CREATE POLICY store_items ON inv_audit_items FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role='store' AND is_active));
CREATE POLICY store_insert ON inv_audit_items FOR INSERT TO authenticated WITH CHECK(EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role='store' AND is_active));
GRANT USAGE ON SCHEMA public,auth TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT INSERT ON inv_audit_items TO authenticated;`)
await db.exec(await fs.readFile('supabase/migrations/669_audit_sub_warehouse_snapshot.sql','utf8'))
const q=async(sql,args=[])=>(await db.query(sql,args)).rows
let count=0
async function test(name,fn){await fn();console.log(`PASS ${name}`);count++}
await db.exec(`SELECT set_config('request.jwt.claim.sub','${id(1)}',false);SET ROLE authenticated;`)
await test('store sees named historical sub warehouses and zero assigned balance',async()=>{
 const rows=await q('SELECT * FROM rpc_get_audit_legacy_sub_warehouse_snapshots($1)',[id(3)])
 assert.equal(rows.length,1)
 const map=new Map(rows[0].snapshot.map(w=>[w.name,w.qty]))
 assert.equal(map.get('คลังผลิต'),80);assert.equal(map.get('คลังแพ็ก'),0);assert.equal(map.get('คลังที่ปิด'),7);assert.equal(map.has('คลังใหม่'),false)
 assert.equal(map.size,3)
})
await test('new snapshot ignores forged client value and stays frozen',async()=>{
 await q('INSERT INTO inv_audit_items(id,audit_id,product_id,system_qty,counted_qty,sub_warehouse_snapshot) VALUES($1,$2,$3,35,0,$4)',[id(6),id(3),id(5),JSON.stringify([{name:'forged',qty:123}])])
 const r=(await q('SELECT sub_warehouse_snapshot FROM inv_audit_items WHERE id=$1',[id(6)]))[0]
 assert.equal(r.sub_warehouse_snapshot.find(w=>w.name==='คลังผลิต').qty,80)
 await db.exec('RESET ROLE')
 await q('INSERT INTO wh_sub_warehouse_stock_moves VALUES($1,$2,12345,$3)',[id(10),id(5),'2026-10-22'])
 const after=(await q('SELECT sub_warehouse_snapshot FROM inv_audit_items WHERE id=$1',[id(6)]))[0]
 assert.deepEqual(after,r)
 await assert.rejects(()=>q("UPDATE inv_audit_items SET sub_warehouse_snapshot='[]' WHERE id=$1",[id(6)]),/ไม่สามารถเปลี่ยน/)
 await db.exec('SET ROLE authenticated')
})
await test('legacy lookup never changes main quantity or saved count',async()=>{
 await q('SELECT * FROM rpc_get_audit_legacy_sub_warehouse_snapshots($1)',[id(3)])
 const rows=await q('SELECT system_qty,counted_qty FROM inv_audit_items')
 for(const r of rows){assert.equal(Number(r.system_qty),35);assert.equal(Number(r.counted_qty),0)}
})
await test('product with no sub warehouse has an explicit empty snapshot',async()=>{
 await q('INSERT INTO inv_audit_items(id,audit_id,product_id,system_qty,counted_qty) VALUES($1,$2,$3,1,0)',[id(8),id(3),id(99)])
 assert.deepEqual((await q('SELECT sub_warehouse_snapshot FROM inv_audit_items WHERE id=$1',[id(8)]))[0].sub_warehouse_snapshot,[])
})
await test('caller without audit access cannot read legacy audit snapshots',async()=>{
 await db.exec(`SELECT set_config('request.jwt.claim.sub','${id(2)}',false)`)
 assert.deepEqual(await q('SELECT * FROM rpc_get_audit_legacy_sub_warehouse_snapshots($1)',[id(3)]),[])
})
await db.exec('RESET ROLE;SET ROLE anon')
await test('anonymous access blocked',async()=>{await assert.rejects(()=>q('SELECT * FROM rpc_get_audit_legacy_sub_warehouse_snapshots($1)',[id(3)]),/permission denied/)})
await db.close();console.log(`${count} database scenarios passed`)
