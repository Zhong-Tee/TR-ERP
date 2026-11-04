// npm install --prefix .tmp/migration-audit-runtime --no-save --package-lock=false pg pgsql-parser
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import pg from '../../.tmp/migration-audit-runtime/node_modules/pg/lib/index.js'
export async function connectMigrationAuditDatabase() {
  const output=execFileSync('cmd.exe',['/d','/s','/c','npx --yes supabase@2.54.11 db dump --linked --dry-run'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000})
  const v=Object.fromEntries([...output.matchAll(/^export (PG\w+)=(.*)$/gm)].map(m=>[m[1],m[2].trim().replace(/^['"]|['"]$/g,'')]))
  const ref=fs.readFileSync('supabase/.temp/project-ref','utf8').trim()
  if(!v.PGHOST||!v.PGPASSWORD||!(v.PGHOST.includes(ref)||v.PGUSER?.includes(ref))||!fs.readFileSync('.env','utf8').includes(`${ref}.supabase.co`))throw new Error('target')
  const db=new pg.Client({host:v.PGHOST,port:Number(v.PGPORT),user:v.PGUSER,password:v.PGPASSWORD,database:v.PGDATABASE,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000})
  try{await db.connect();await db.query('SET ROLE postgres');return {db,ref}}
  catch(error){await db.end().catch(()=>{});throw error}
}
