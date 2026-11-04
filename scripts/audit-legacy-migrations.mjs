// Catalog-only audit: migration SQL is parsed, never executed.
// npm install --prefix .tmp/migration-audit-runtime --no-save --package-lock=false pg pgsql-parser
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import pg from '../.tmp/migration-audit-runtime/node_modules/pg/lib/index.js'
import { parse } from '../.tmp/migration-audit-runtime/node_modules/pgsql-parser/index.js'

const s = item => item?.String?.sval
const parts = list => list?.map(s) || []
const qualified = names => names.length > 1 ? names.slice(-2).join('.') : `public.${names[0]}`
const relation = r => `${r.schemaname || 'public'}.${r.relname}`
const norm = body => body?.replace(/\r\n/g, '\n').trim()
let db
try {
  const output = execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx --yes supabase@2.54.11 db dump --linked --dry-run'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 })
  const vars = Object.fromEntries([...output.matchAll(/^export (PG\w+)=(.*)$/gm)].map(m => [m[1], m[2].trim().replace(/^['"]|['"]$/g, '')]))
  const ref = fs.readFileSync('supabase/.temp/project-ref', 'utf8').trim()
  if (!vars.PGHOST || !vars.PGPASSWORD || !(vars.PGHOST.includes(ref) || vars.PGUSER?.includes(ref)) || !fs.readFileSync('.env', 'utf8').includes(`${ref}.supabase.co`)) throw new Error('target')
  db = new pg.Client({ host: vars.PGHOST, port: Number(vars.PGPORT), user: vars.PGUSER, password: vars.PGPASSWORD, database: vars.PGDATABASE, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 })
  await db.connect()
  await db.query('SET ROLE postgres')
  await db.query('BEGIN READ ONLY')
  await db.query("SET LOCAL statement_timeout='20s'")
  const history = (await db.query('SELECT * FROM supabase_migrations.schema_migrations ORDER BY version')).rows
  const functions = (await db.query(`SELECT n.nspname AS schema,p.proname AS name,p.prosrc AS body,
    ARRAY(SELECT t.typname FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY a(oid,idx) JOIN pg_type t ON t.oid=a.oid ORDER BY a.idx)::text[] AS types,
    pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','storage','auth') AND p.prokind IN ('f','p')`)).rows
  const relations = (await db.query(`SELECT n.nspname AS schema,c.relname AS name,c.relkind,c.relrowsecurity,
    ARRAY(SELECT a.attname FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum)::text[] AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','storage','auth')`)).rows
  const policies = (await db.query("SELECT schemaname,tablename,policyname,cmd,qual,with_check FROM pg_policies WHERE schemaname IN ('public','storage','auth')")).rows
  const triggers = (await db.query("SELECT n.nspname AS schema,c.relname AS table,t.tgname AS name,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('public','storage','auth')")).rows
  await db.query('ROLLBACK')
  fs.mkdirSync('.tmp/legacy-migration-audit', { recursive: true })
  if(!fs.existsSync('.tmp/legacy-migration-audit/history-before.json'))fs.writeFileSync('.tmp/legacy-migration-audit/history-before.json', JSON.stringify(history,null,2))
  if(!fs.existsSync('.tmp/legacy-migration-audit/catalog-before.json'))fs.writeFileSync('.tmp/legacy-migration-audit/catalog-before.json', JSON.stringify({functions,relations,policies,triggers},null,2))
  fs.writeFileSync('.tmp/legacy-migration-audit/catalog-latest.json',JSON.stringify({functions,relations,policies,triggers},null,2))
  const live = new Map()
  for (const f of functions) live.set(`function:${f.schema}.${f.name}(${f.types.join(',')})`, f)
  for (const r of relations) {
    live.set(`relation:${r.schema}.${r.name}`,r)
    for (const col of r.columns) live.set(`column:${r.schema}.${r.name}.${col}`,r)
  }
  for (const p of policies) live.set(`policy:${p.schemaname}.${p.tablename}.${p.policyname}`,p)
  for (const t of triggers) live.set(`trigger:${t.schema}.${t.table}.${t.name}`,t)
  const latest = new Map(), reports = []
  const files=fs.readdirSync('supabase/legacy-migrations/pre-baseline-20261104').filter(f=>/^\d+_.*\.sql$/.test(f)).sort()
  for(const file of files) {
    const sql=fs.readFileSync(`supabase/legacy-migrations/pre-baseline-20261104/${file}`,'utf8')
    const report={file,sha256:createHash('sha256').update(sql).digest('hex'),objects:[],statementTypes:{},unresolved:[]}
    reports.push(report)
    const add=(key,details={})=>{const object={key,...details,file};report.objects.push(object);latest.set(key,object)}
    let ast
    try {ast=await parse(sql)} catch {report.unresolved.push('SQL parse error');continue}
    for(const raw of ast.stmts || []) {
      const [type,node]=Object.entries(raw.stmt)[0]
      report.statementTypes[type]=(report.statementTypes[type]||0)+1
      if(type==='CreateStmt') {
        const rel=relation(node.relation);add(`relation:${rel}`)
        for(const col of node.tableElts || [])if(col.ColumnDef)add(`column:${rel}.${col.ColumnDef.colname}`)
      } else if(type==='CreateFunctionStmt') {
        const name=qualified(parts(node.funcname))
        const types=(node.parameters||[]).map(p=>p.FunctionParameter).filter(p=>!['FUNC_PARAM_OUT','FUNC_PARAM_TABLE'].includes(p.mode)).map(p=>(p.argType.arrayBounds?'_':'')+parts(p.argType.names).at(-1))
        const body=node.options?.find(o=>o.DefElem.defname==='as')?.DefElem.arg.List.items[0].String.sval
        add(`function:${name}(${types.join(',')})`,{body})
      } else if(type==='IndexStmt' && node.idxname) add(`relation:${node.relation.schemaname||'public'}.${node.idxname}`,{parent:relation(node.relation)})
      else if(type==='CreatePolicyStmt')add(`policy:${relation(node.table)}.${node.policy_name}`,{parent:relation(node.table)})
      else if(type==='CreateTrigStmt')add(`trigger:${relation(node.relation)}.${node.trigname}`,{parent:relation(node.relation)})
      else if(type==='ViewStmt')add(`relation:${relation(node.view)}`)
      else if(type==='AlterTableStmt') {
        const rel=relation(node.relation)
        for(const wrapper of node.cmds||[]) {
          const c=wrapper.AlterTableCmd
          if(c.subtype==='AT_AddColumn' && c.def?.ColumnDef)add(`column:${rel}.${c.def.ColumnDef.colname}`)
          if(c.subtype==='AT_DropColumn')add(`column:${rel}.${c.name}`,{dropped:true})
        }
      } else if(type==='DropStmt') {
        for(const object of node.objects||[]) {
          const names=parts(object.List?.items)
          if(['OBJECT_TABLE','OBJECT_INDEX','OBJECT_VIEW','OBJECT_MATVIEW'].includes(node.removeType)&&names.length)add(`relation:${qualified(names)}`,{dropped:true})
          if(['OBJECT_POLICY','OBJECT_TRIGGER'].includes(node.removeType)&&names.length>=2) {
            const name=names.pop();add(`${node.removeType==='OBJECT_POLICY'?'policy':'trigger'}:${qualified(names)}.${name}`,{dropped:true})
          }
          if(node.removeType==='OBJECT_FUNCTION' && object.ObjectWithArgs) {
            const o=object.ObjectWithArgs
            const types=(o.objargs||[]).map(t=>(t.TypeName.arrayBounds?'_':'')+parts(t.TypeName.names).at(-1))
            add(`function:${qualified(parts(o.objname))}(${types.join(',')})`,{dropped:true})
          }
        }
      }
      if(['DoStmt','RenameStmt'].includes(type))report.unresolved.push(type)
    }
  }
  for(const report of reports)for(const object of report.objects) {
    if(latest.get(object.key)!==object){object.status='superseded';delete object.body;continue}
    const parent=object.parent || (object.key.startsWith('column:')?object.key.slice(7).split('.').slice(0,-1).join('.'):null)
    if(parent&&latest.get(`relation:${parent}`)?.dropped&&!live.has(`relation:${parent}`)){object.status='parent-removed';delete object.body;continue}
    const deployed=live.get(object.key)
    object.status=object.dropped ? (deployed?'drop-not-reflected':'absent-as-expected') : !deployed?'missing':object.body!==undefined?(norm(object.body)===norm(deployed.body)?'body-matches':'body-differs'):'exists'
    delete object.body
  }
  const duplicates=Object.entries(Object.groupBy(files,f=>f.split('_')[0])).filter(([,v])=>v.length>1)
  const findings=reports.flatMap(r=>r.objects.filter(o=>['missing','body-differs','drop-not-reflected'].includes(o.status)))
  const result={project:ref,checkedAt:new Date().toISOString(),readOnly:true,files:files.length,historyRows:history.length,duplicates:Object.fromEntries(duplicates),findings,reports}
  fs.writeFileSync('.tmp/legacy-migration-audit/report.json',JSON.stringify(result,null,2))
  console.log(JSON.stringify({project:ref,files:files.length,historyRows:history.length,duplicateGroups:duplicates.length,findings:findings.length,statusCounts:Object.fromEntries(Object.entries(Object.groupBy(reports.flatMap(r=>r.objects),o=>o.status)).map(([k,v])=>[k,v.length])),parseErrors:reports.filter(r=>r.unresolved.includes('SQL parse error')).map(r=>r.file)},null,2))
} catch(error) {
  console.error(`Legacy catalog audit failed (${error.code||error.name}); credentials were not logged.`)
  console.error(error.stack?.split('\n').slice(1,4).join('\n'))
  process.exitCode=1
} finally {if(db)await db.end().catch(()=>{})}
