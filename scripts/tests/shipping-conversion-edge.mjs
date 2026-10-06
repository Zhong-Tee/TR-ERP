// Tests the actual Edge Function handler with mocked auth/database/EasySlip transport.
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
const source = await readFile('supabase/functions/verify-shipping-conversion/index.ts','utf8')
const compiled = ts.transpileModule(source.replace(/^import .*$/gm,''), { compilerOptions: { target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None } }).outputText
const userId='sales-user'
const requestId='request-1'
const path=`slip-images/shipping-conversion/${requestId}/${userId}/slip.png`
const receipt={success:true,amount:50,accountNameMatch:true,bankCodeMatch:true,easyslipResponse:{data:{transRef:'trusted-ref'}}}
async function run(options={},body={requestId,storagePath:path}) {
 let handler, apiCalls=0, rpcCalls=0, saved, sent
 const request={id:requestId,status:'pending',shipping_cost:50,requested_by:userId,or_orders:{channel_code:'SHOPP'},...options.request}
 const actor={role:options.role || 'sales-tr'}
 function createClient(_url,key) {
  return {
   auth:{getUser:async()=>options.noAuth?{data:{user:null},error:new Error('no auth')}:{data:{user:{id:userId}},error:null}},
   from(table){
    const result=table==='us_users'?actor:table==='or_shipping_conversion_requests'?request:table==='bank_settings_channels'?(options.noBank?[]:[{bank_setting_id:'bank-1'}]):(options.banks || [{account_number:'configured-account',bank_code:'configured-bank'}])
    const chain={update(){return this},select(){return this},eq(){return this},in(){return this},single(){return Promise.resolve({data:result,error:null})},then(resolve){return Promise.resolve({data:result,error:null}).then(resolve)}}
    return chain
   },
   rpc:async(name,args)=>{assert.equal(key,'service-key');assert.equal(name,'or_record_shipping_payment');rpcCalls++;saved=args;return {data:options.ready ?? true,error:options.saveError?{message:options.saveError}:null}}
  }
 }
 const context=vm.createContext({Request,Response,console,JSON,Number,Error,Deno:{env:{get:(name)=>({SUPABASE_URL:'https://test.invalid',SUPABASE_ANON_KEY:'anon-key',SUPABASE_SERVICE_ROLE_KEY:'service-key'})[name]}},createClient,serve:(fn)=>{handler=fn},fetch:async(url,opts)=>{apiCalls++;assert.equal(url,'https://test.invalid/functions/v1/verify-slip');sent=JSON.parse(opts.body);if(options.apiThrows)throw new Error('API offline');return new Response(JSON.stringify(options.receipt || receipt),{status:options.apiStatus || 200})}})
 vm.runInContext(compiled,context)
 const response=await handler(new Request('https://test.invalid/function',{method:'POST',headers:{Authorization:'Bearer valid-user','Content-Type':'application/json'},body:JSON.stringify(body)}))
 return {status:response.status,data:await response.json(),apiCalls,rpcCalls,saved,sent}
}
let count=0
async function test(name,action){await action();count++;console.log(`PASS ${name}`)}
await test('Valid proof uses server bank settings and trusted API amount/reference',async()=>{const r=await run({}, {requestId,storagePath:path,amount:999,bankAccount:'attacker'});assert.equal(r.data.success,true);assert.equal(r.sent.bankAccount,'configured-account');assert.equal(r.sent.bankCode,'configured-bank');assert.equal(r.saved.p_amount,50);assert.equal(r.saved.p_trans_ref,'trusted-ref')})
await test('Unauthenticated and packing callers cannot verify',async()=>{for(const opts of [{noAuth:true},{role:'packing_staff'},{role:'production'},{role:'account'}]){const r=await run(opts);assert(r.status>=400);assert.equal(r.apiCalls,0);assert.equal(r.rpcCalls,0)}})
await test('Foreign requests and storage outside the request/user folder are rejected',async()=>{for(const [options,body] of [[{request:{requested_by:'someone-else'}},{requestId,storagePath:path}],[{},{requestId,storagePath:'slip-images/other/slip.png'}],[{},{requestId,storagePath:path+'/../fake'}]]){const r=await run(options,body);assert(r.status>=400);assert.equal(r.rpcCalls,0)}})
await test('Zero shipping requires approval before spending API quota',async()=>{const r=await run({request:{shipping_cost:0,zero_approved_by:null}});assert.equal(r.status,400);assert.equal(r.apiCalls,0)})
await test('Missing active configured banks cannot fall back to another account',async()=>{for(const opts of [{noBank:true},{banks:[]},{banks:[{account_number:'x',bank_code:null}]}]){const r=await run(opts);assert.equal(r.status,400);assert.equal(r.rpcCalls,0)}})
await test('Wrong receiver/bank and absent references cannot release packing',async()=>{for(const proof of [{...receipt,accountNameMatch:false},{...receipt,bankCodeMatch:false},{...receipt,success:false},{...receipt,easyslipResponse:{data:{}}},{...receipt,amount:0}]){const r=await run({receipt:proof});assert.equal(r.status,400);assert.equal(r.rpcCalls,0)}})
await test('API errors fail closed without saving payment',async()=>{for(const opts of [{apiThrows:true},{apiStatus:503}]){const r=await run(opts);assert.equal(r.status,400);assert.equal(r.rpcCalls,0)}})
await test('SQL duplicate rejection is returned as failure',async()=>{const r=await run({saveError:'สลิปนี้เคยใช้แล้ว'});assert.equal(r.status,400);assert.equal(r.data.error,'สลิปนี้เคยใช้แล้ว')})
await test('Partial payment success does not claim packing ready',async()=>{const r=await run({ready:false});assert.equal(r.data.success,true);assert.equal(r.data.ready,false)})
await test('Completed/rejected requests cannot accept more money',async()=>{for(const status of ['ready','rejected','cancelled']){const r=await run({request:{status}});assert.equal(r.status,400);assert.equal(r.apiCalls,0)}})
console.log(`${count} Edge Function scenarios passed`)
