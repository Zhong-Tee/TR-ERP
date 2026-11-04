// Exports schema only. --adopt changes migration metadata only, never application schema/data.
// Requires the temporary PG17 pg_dump tools plus the audit client documented in scripts/lib/migration-audit-db.mjs.
import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {parse} from '../.tmp/migration-audit-runtime/node_modules/pgsql-parser/index.js'
import {connectMigrationAuditDatabase} from './lib/migration-audit-db.mjs'
const version='20261104140132'
const file=`${version}_production_baseline.sql`
const archive='supabase/legacy-migrations/pre-baseline-20261104'
const sha=x=>createHash('sha256').update(x).digest('hex')
const qi=x=>'"'+x.replaceAll('"','""')+'"'
const literal=x=>"'"+x.replaceAll("'","''")+"'"
let db
try{
  const conn=await connectMigrationAuditDatabase();db=conn.db
  const parameters=db.connectionParameters
  const env={...process.env,PGHOST:parameters.host,PGPORT:String(parameters.port),PGUSER:parameters.user,PGPASSWORD:parameters.password,PGDATABASE:parameters.database,PGSSLMODE:'require',PGOPTIONS:'-c default_transaction_read_only=on'}
  function dump(){
    return execFileSync(path.resolve('.tmp/pg17-dump-tools/pg_dump.exe'),['--schema-only','--schema=public','--no-owner','--role=postgres','--lock-wait-timeout=5s'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000,maxBuffer:40*1024*1024})
      .replace(/^\\(?:un)?restrict .*\r?\n/gm,'').replace(/\r\n/g,'\n').replace(/^CREATE SCHEMA public;$/m,'CREATE SCHEMA IF NOT EXISTS public;')
  }
  await db.query('BEGIN READ ONLY');await db.query("SET LOCAL statement_timeout='20s'")
  const history=(await db.query('SELECT * FROM supabase_migrations.schema_migrations ORDER BY version')).rows
  const policies=(await db.query("SELECT schemaname,tablename,policyname,permissive,roles::text[] AS roles,cmd,qual,with_check FROM pg_policies WHERE schemaname IN ('auth','storage') ORDER BY schemaname,tablename,policyname")).rows
  const extensions=(await db.query("SELECT e.extname,n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname<>'plpgsql' ORDER BY e.extname")).rows
  const buckets=(await db.query('SELECT id,name,public,file_size_limit,allowed_mime_types FROM storage.buckets ORDER BY id')).rows
  const publications=(await db.query("SELECT schemaname,tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' ORDER BY tablename")).rows
  await db.query('ROLLBACK')
  fs.mkdirSync('.tmp/production-baseline-20261104',{recursive:true})
  if(!fs.existsSync('.tmp/production-baseline-20261104/history-before.json'))fs.writeFileSync('.tmp/production-baseline-20261104/history-before.json',JSON.stringify(history,null,2))
  const publicSchema=dump()
  // Never write credential-bearing function source to a repository artifact.
  if(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|sb_secret_[A-Za-z0-9_-]+|postgres(?:ql)?:\/\/[^\s'";]*:[^\s'";]*@/.test(publicSchema))throw new Error('secret scan')
  let sql=`-- Production schema baseline adopted on 2026-11-04; no business rows included.\n-- Existing production is registered as applied; NEVER replay this baseline there.\n-- Legacy SQL/history remain archived; no legacy statements were executed during adoption.\n\n`
  for(const schema of new Set(extensions.map(e=>e.nspname)))sql+=`CREATE SCHEMA IF NOT EXISTS ${qi(schema)};\n`
  for(const e of extensions)sql+=`CREATE EXTENSION IF NOT EXISTS ${qi(e.extname)} WITH SCHEMA ${qi(e.nspname)};\n`
  sql+='\n'+publicSchema+'\n-- Application storage/auth policies on Supabase-managed tables.\n'
  for(const p of policies){
    sql+=`DROP POLICY IF EXISTS ${qi(p.policyname)} ON ${qi(p.schemaname)}.${qi(p.tablename)};\nCREATE POLICY ${qi(p.policyname)} ON ${qi(p.schemaname)}.${qi(p.tablename)} AS ${p.permissive} FOR ${p.cmd} TO ${p.roles.map(r=>r==='public'?'PUBLIC':qi(r)).join(', ')}`
    if(p.qual)sql+=` USING (${p.qual})`;if(p.with_check)sql+=` WITH CHECK (${p.with_check})`;sql+=';\n'
  }
  sql+='\n-- Bucket configuration only; no object/file contents.\n'
  for(const b of buckets)sql+=`INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES (${literal(b.id)},${literal(b.name)},${b.public},${b.file_size_limit??'NULL'},${b.allowed_mime_types?'ARRAY['+b.allowed_mime_types.map(literal).join(',')+']::text[]':'NULL'}) ON CONFLICT(id) DO NOTHING;\n`
  sql+='\n-- Realtime membership; Supabase-managed publication must already exist.\n'
  for(const p of publications)sql+=`ALTER PUBLICATION supabase_realtime ADD TABLE ${qi(p.schemaname)}.${qi(p.tablename)};\n`
  const parsed=await parse(sql)
  const dangerous=parsed.stmts.filter(s=>['UpdateStmt','DeleteStmt','TruncateStmt'].some(t=>t in s.stmt))
  if(dangerous.length)throw new Error('unexpected data mutation in schema snapshot')
  // Ensure no concurrent public DDL was missed between export and catalog capture.
  if(sha(publicSchema)!==sha(dump()))throw new Error('schema changed during export')
  const files=fs.readdirSync('supabase/migrations').filter(f=>/^\d+_.*\.sql$/.test(f)).sort()
  if(files.includes(file))throw new Error('baseline already prepared; inspect existing artifacts')
  const manifest={project:conn.ref,version,file,archive,preparedAt:new Date().toISOString(),baselineSha256:sha(sql),publicSchemaSha256:sha(publicSchema),statementCount:parsed.stmts.length,policies:policies.length,buckets:buckets.length,realtimeTables:publications.length,
    priorHistory:history.map(h=>({version:h.version,name:h.name,statementsSha256:sha(JSON.stringify(h.statements))})),legacyFiles:files.map(f=>({file:f,sha256:sha(fs.readFileSync(`supabase/migrations/${f}`))})),businessDataChanged:false,baselineExecuted:false}
  fs.writeFileSync('.tmp/production-baseline-20261104/baseline.sql',sql)
  fs.writeFileSync('.tmp/production-baseline-20261104/manifest.json',JSON.stringify(manifest,null,2))
  console.log(JSON.stringify({prepared:true,file,legacyFiles:files.length,statements:parsed.stmts.length,policyCount:policies.length,bucketCount:buckets.length,baselineSha256:manifest.baselineSha256},null,2))
  if(process.argv.includes('--adopt')){
    // Read-only checks and all export/parse/backup work finish before metadata writes.
    if(fs.existsSync(archive))throw new Error('archive path already exists')
    fs.mkdirSync(archive,{recursive:true})
    const moved=[]
    try{
      const sourceRoot=path.resolve('supabase/migrations'),archiveRoot=path.resolve(archive)
      if(!archiveRoot.startsWith(path.resolve('supabase')+path.sep))throw new Error('archive outside project')
      for(const old of manifest.legacyFiles){
        const source=path.resolve(sourceRoot,old.file),target=path.resolve(archiveRoot,old.file)
        if(path.dirname(source)!==sourceRoot||path.dirname(target)!==archiveRoot||sha(fs.readFileSync(source))!==old.sha256)throw new Error('archive verification')
        fs.renameSync(source,target);moved.push(old.file)
      }
      fs.writeFileSync(`supabase/migrations/${file}`,sql)
      await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");await db.query("SET LOCAL statement_timeout='20s'")
      await db.query('LOCK TABLE supabase_migrations.schema_migrations IN SHARE ROW EXCLUSIVE MODE')
      if(JSON.stringify((await db.query('SELECT * FROM supabase_migrations.schema_migrations ORDER BY version')).rows)!==JSON.stringify(history))throw new Error('history changed during preparation')
      // Remove only the backed-up legacy history entries; no application tables are touched.
      const removed=await db.query('DELETE FROM supabase_migrations.schema_migrations WHERE version=ANY($1::text[])',[history.map(h=>h.version)])
      if(removed.rowCount!==history.length)throw new Error('unexpected history count')
      await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3)',[version,'production_baseline',[sql]])
      await db.query('COMMIT')
    }catch(error){
      await db.query('ROLLBACK').catch(()=>{})
      // Restore the original local layout if adoption did not commit.
      if(fs.existsSync(`supabase/migrations/${file}`))fs.unlinkSync(`supabase/migrations/${file}`)
      for(const f of moved.reverse())fs.renameSync(`${archive}/${f}`,`supabase/migrations/${f}`)
      throw error
    }
    fs.writeFileSync(`${archive}/migration-history-before-baseline.json`,JSON.stringify(history,null,2))
    fs.writeFileSync('docs/production-baseline-2026-11-04.json',JSON.stringify({...manifest,adoptedAt:new Date().toISOString(),historyOnly:true},null,2)+'\n')
    console.log('Baseline adopted: local archive preserved; only migration history changed in production.')
  }
}catch(error){console.error(`Baseline operation failed (${error.code||error.name}); credentials were not logged.`);console.error(error.stack?.split('\n').slice(1,3).join('\n'));process.exitCode=1}
finally{if(db)await db.end().catch(()=>{})}
