// Uses the existing Supabase CLI linked connection. Never prints connection credentials.
// node scripts/reconciliation-workspace-db.mjs audit|rehearse|apply
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import pg from '../.reservation-test-runtime/node_modules/pg/lib/index.js'
const dump = execFileSync('supabase', ['db', 'dump', '--linked', '--dry-run'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const vars = {}
for (const match of dump.matchAll(/^export (PG\w+)=(.*)$/gm)) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
const client = new pg.Client({ host: vars.PGHOST, port: Number(vars.PGPORT), user: vars.PGUSER, password: vars.PGPASSWORD, database: vars.PGDATABASE, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 })

try {
 await client.connect(); await client.query('SET ROLE postgres');
 console.log(JSON.stringify((await client.query("SELECT column_name FROM information_schema.columns WHERE table_name='or_orders' ORDER BY ordinal_position")).rows));
 const actor=(await client.query("SELECT id FROM us_users WHERE role='superadmin' LIMIT 1")).rows[0];
 await client.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[actor.id]);
 console.log(JSON.stringify((await client.query(`WITH w AS (SELECT bank_sales_workspace(NULL,NULL,'no_evidence') j), b AS (SELECT o.* FROM or_orders o WHERE o.created_at >= TIMESTAMPTZ '2026-10-01 00:00+07' AND COALESCE(o.status,'') NOT IN ('ยกเลิก','รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ') AND NOT EXISTS(SELECT 1 FROM ac_bank_reconciliation_allocations a WHERE a.order_id=o.id) AND NOT EXISTS(SELECT 1 FROM ac_order_receipt_certifications c WHERE c.order_id=o.id AND c.revoked_at IS NULL) AND NOT EXISTS(SELECT 1 FROM ac_verified_slips s WHERE s.order_id=o.id AND COALESCE(s.is_deleted,false)=false AND s.verified_amount>0 AND s.easyslip_date IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM ac_manual_slip_checks m WHERE m.order_id=o.id AND m.status='approved')) SELECT status,payment_method,channel_code,count(*) n,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM ac_verified_slips s WHERE s.order_id=b.id AND COALESCE(s.is_deleted,false)=false)) any_verified_slip,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM ac_manual_slip_checks m WHERE m.order_id=b.id)) any_manual_slip FROM b GROUP BY status,payment_method,channel_code ORDER BY n DESC`)).rows));
} finally {await client.end()}
