// Offline integrity checks by default. --remote checks migration metadata read-only.
import fs from 'node:fs'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
const sha=x=>createHash('sha256').update(x).digest('hex')
const manifest=JSON.parse(fs.readFileSync('docs/production-baseline-2026-11-04.json','utf8'))
const sql=fs.readFileSync(`supabase/migrations/${manifest.file}`)
assert.equal(sha(sql),manifest.baselineSha256,'Baseline SQL has changed')
for(const legacy of manifest.legacyFiles)assert.equal(sha(fs.readFileSync(`${manifest.archive}/${legacy.file}`)),legacy.sha256,`Archived SQL changed: ${legacy.file}`)
const archived=fs.readdirSync(manifest.archive).filter(f=>f.endsWith('.sql')).sort()
assert.deepEqual(archived,manifest.legacyFiles.map(f=>f.file).sort(),'Archive must preserve every historical SQL file')
const history=JSON.parse(fs.readFileSync(`${manifest.archive}/migration-history-before-baseline.json`,'utf8'))
assert.deepEqual(history.map(h=>({version:h.version,name:h.name,statementsSha256:sha(JSON.stringify(h.statements))})),manifest.priorHistory,'Archived history changed')
const active=fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort()
const versions=active.map(f=>f.split('_')[0])
assert.equal(versions.length,new Set(versions).size,'Duplicate active migration version')
for(const f of active)assert.match(f,/^\d{14}_.+\.sql$/,'Use timestamped versions after baseline')
assert.equal(active[0],manifest.file,'No migration may precede the adopted baseline')
assert.throws(()=>fs.readFileSync('supabase/migrations/001_initial_schema.sql'),'Legacy SQL must not remain in the active directory')
if(process.argv.includes('--remote')){
  const {connectMigrationAuditDatabase}=await import('./lib/migration-audit-db.mjs')
  const {db,ref}=await connectMigrationAuditDatabase()
  try{
    assert.equal(ref,manifest.project)
    await db.query('BEGIN READ ONLY')
    const rows=(await db.query('SELECT version,name,statements FROM supabase_migrations.schema_migrations ORDER BY version')).rows
    const record=rows.find(r=>r.version===manifest.version)
    assert.ok(record,'Remote baseline history missing')
    assert.equal(sha(record.statements.join('')),manifest.baselineSha256,'Remote baseline content differs')
    for(const row of rows)assert.ok(versions.includes(row.version),`Remote history not in active migrations: ${row.version}`)
    await db.query('ROLLBACK')
  }finally{await db.end()}
}
console.log(`PASS: baseline hash, ${archived.length} archived SQL files, ${history.length} preserved history rows, unique timestamp versions${process.argv.includes('--remote')?', remote history verified read-only':''}`)
