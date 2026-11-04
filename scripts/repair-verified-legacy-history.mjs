import {assertLegacyMigrationReplayAllowed} from './lib/legacy-migration-guard.mjs'
if(process.argv.includes('--repair-history'))assertLegacyMigrationReplayAllowed('--repair-history')
// Default: read-only. --repair-history stores metadata only; never executes migration SQL.
import fs from 'node:fs'
import {createHash} from 'node:crypto'
import {parse} from '../.tmp/migration-audit-runtime/node_modules/pgsql-parser/index.js'
import {connectMigrationAuditDatabase} from './lib/migration-audit-db.mjs'
const sha=value=>createHash('sha256').update(value).digest('hex')
const names=list=>(list||[]).map(x=>x.String.sval)
const qualify=ns=>ns.length>1?ns.slice(-2).join('.'):`public.${ns[0]}`
const types=list=>list.map(t=>(t.arrayBounds?'_':'')+names(t.names).at(-1)).join(',')
const sig=n=>`${qualify(names(n.funcname))}(${types((n.parameters||[]).map(p=>p.FunctionParameter).filter(p=>!['FUNC_PARAM_OUT','FUNC_PARAM_TABLE'].includes(p.mode)).map(p=>p.argType))})`
function canonical(node){
  function clean(v,key=''){
    if(Array.isArray(v)){const r=v.map(x=>clean(x));if(key==='options')r.sort((a,b)=>a.DefElem.defname.localeCompare(b.DefElem.defname));return r}
    if(!v||typeof v!=='object')return v
    const r={}
    for(const k of Object.keys(v).sort()){
      if(['location','stmt_location','stmt_len','replace'].includes(k))continue
      if(k==='names'&&v.typemod!==undefined){const ns=names(v[k]);r[k]=['public','pg_catalog'].includes(ns[0])?ns.slice(1):ns;continue}
      r[k]=clean(v[k],k)
    }
    if(r.funcname)r.funcname=qualify(names(v.funcname))
    if(r.DefElem?.defname==='as')for(const item of r.DefElem.arg.List.items)if(item.String)item.String.sval=item.String.sval.replace(/\r\n/g,'\n').trim()
    return r
  }
  return JSON.stringify(clean(node))
}
const catalogSql=`SELECT p.oid::text,n.nspname||'.'||p.proname||'('||array_to_string(ARRAY(SELECT t.typname FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY a(oid,idx) JOIN pg_type t ON t.oid=a.oid ORDER BY a.idx),',')||')' AS signature,pg_get_functiondef(p.oid) AS definition,
coalesce((SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable)) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),'[]') AS acl
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' ORDER BY p.oid`
let db
try{
  const conn=await connectMigrationAuditDatabase();db=conn.db
  await db.query('BEGIN READ ONLY');await db.query("SET LOCAL statement_timeout='20s'")
  const history=(await db.query('SELECT * FROM supabase_migrations.schema_migrations ORDER BY version')).rows
  const catalog=(await db.query(catalogSql)).rows,map=new Map()
  for(const f of catalog)map.set(f.signature,{...f,canonical:canonical((await parse(f.definition)).stmts[0].stmt.CreateFunctionStmt)})
  const existing=new Set(history.map(h=>h.version)),candidates=[],deferred=[]
  const allow=new Set(['CreateFunctionStmt','GrantStmt','TransactionStmt','NotifyStmt'])
  for(const file of fs.readdirSync('supabase/legacy-migrations/pre-baseline-20261104').filter(f=>/^\d+_.*\.sql$/.test(f)).sort()){
    const version=file.split('_')[0];if(existing.has(version))continue
    const bytes=fs.readFileSync(`supabase/legacy-migrations/pre-baseline-20261104/${file}`),sql=bytes.toString('utf8');let ast
    try{ast=await parse(sql)}catch{deferred.push({file,reason:'parse-error'});continue}
    const reasons=[],checks=[],acls=new Map()
    for(const raw of ast.stmts||[]){
      const [type,n]=Object.entries(raw.stmt)[0]
      if(!allow.has(type)){reasons.push(type);continue}
      if(type==='TransactionStmt'&&!['TRANS_STMT_BEGIN','TRANS_STMT_COMMIT'].includes(n.kind))reasons.push(type)
      if(type==='CreateFunctionStmt'){
        const key=sig(n),f=map.get(key)
        if(!f||canonical(n)!==f.canonical)reasons.push(`definition:${key}`)
        checks.push(key)
      }
      if(type==='GrantStmt'){
        if(n.objtype!=='OBJECT_FUNCTION'||n.targtype!=='ACL_TARGET_OBJECT'||(n.privileges||[]).some(p=>p.AccessPriv.priv_name.toLowerCase()!=='execute')){reasons.push('non-function-grant');continue}
        for(const object of n.objects||[]){
          const o=object.ObjectWithArgs;if(!o){reasons.push('unresolved-grant');continue}
          const key=`${qualify(names(o.objname))}(${types((o.objargs||[]).map(a=>a.TypeName))})`
          for(const g of n.grantees||[]){const role=g.RoleSpec.roletype==='ROLESPEC_PUBLIC'?'PUBLIC':g.RoleSpec.rolename
            if(!role){reasons.push('unresolved-role');continue}
            acls.set(`${key}:${role}`,{key,role,grant:!!n.is_grant,grantOption:!!n.grant_option})
          }
        }
      }
    }
    for(const a of acls.values()){
      const f=map.get(a.key),acl=f?.acl.find(p=>p.role===a.role&&p.privilege==='EXECUTE')
      if(!f||!!acl!==a.grant||(a.grantOption&&!acl?.grantable))reasons.push(`acl:${a.key}:${a.role}`)
    }
    if(!checks.length)reasons.push('no-verified-function')
    if(reasons.length)deferred.push({file,reason:[...new Set(reasons)].join(';')})
    else candidates.push({file,version,name:file.slice(version.length+1,-4),sha256:sha(bytes),checks})
  }
  await db.query('ROLLBACK')
  const plan={project:conn.ref,checkedAt:new Date().toISOString(),candidates,deferred,migrationSQLExecuted:false}
  fs.writeFileSync('.tmp/legacy-migration-audit/verified-history-plan.json',JSON.stringify(plan,null,2))
  console.log(JSON.stringify({verified:candidates.length,deferred:deferred.length,files:candidates.map(c=>c.file)},null,2))
  if(process.argv.includes('--repair-history')&&candidates.length){
    fs.writeFileSync('.tmp/legacy-migration-audit/history-before-verified-repair.json',JSON.stringify(history,null,2))
    await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");await db.query("SET LOCAL statement_timeout='20s'")
    try{
      await db.query('LOCK TABLE supabase_migrations.schema_migrations IN SHARE ROW EXCLUSIVE MODE')
      if(JSON.stringify((await db.query('SELECT * FROM supabase_migrations.schema_migrations ORDER BY version')).rows)!==JSON.stringify(history))throw new Error('history changed')
      if(JSON.stringify((await db.query(catalogSql)).rows)!==JSON.stringify(catalog))throw new Error('catalog changed')
      for(const c of candidates){
        const bytes=fs.readFileSync(`supabase/legacy-migrations/pre-baseline-20261104/${c.file}`);if(sha(bytes)!==c.sha256)throw new Error('file changed')
        await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3)',[c.version,c.name,[bytes.toString('utf8')]])
      }
      await db.query('COMMIT')
      fs.writeFileSync('docs/legacy-migration-verified-repair-2026-11-04.json',JSON.stringify({...plan,deferred:undefined,repairedAt:new Date().toISOString(),historyOnly:true},null,2)+'\n')
      console.log(`Registered ${candidates.length} verified records. No migration SQL executed.`)
    }catch(error){await db.query('ROLLBACK');throw error}
  }
}catch(error){console.error(`Verified history audit failed (${error.code||error.name}); credentials were not logged.`);console.error(error.stack?.split('\n').slice(1,3).join('\n'));process.exitCode=1}
finally{if(db)await db.end().catch(()=>{})}
