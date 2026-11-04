import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { parseVatResponse } from './parser.ts'
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
serve(async req => {
  const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405)
  try {
    const caller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('authorization') || '' } } })
    const { data: { user }, error } = await caller.auth.getUser()
    if (error || !user) return reply({ error: 'Unauthorized' }, 401)
    const { data: actor } = await caller.from('us_users').select('role').eq('id', user.id).single()
    if (!actor || !['superadmin', 'admin', 'account', 'sales-tr', 'sales-pump'].includes(actor.role)) return reply({ error: 'Forbidden' }, 403)
    const { taxId, branch } = await req.json()
    if (typeof taxId !== 'string' || !/^\d{13}$/.test(taxId) || typeof branch !== 'string' || !/^\d{5}$/.test(branch)) return reply({ error: 'Invalid tax ID or branch' }, 400)
    const sum = [...taxId.slice(0,12)].reduce((n,d,i) => n + Number(d) * (13-i), 0)
    if (/^0+$/.test(taxId) || (11-sum%11)%10 !== Number(taxId[12])) return reply({ error: 'Invalid tax ID checksum' }, 400)
    const response = await fetch('https://rdws.rd.go.th/jsonRD/vatserviceRD3.asmx', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(9000),
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"https://rdws.rd.go.th/JserviceRD3/vatserviceRD3/Service"' },
      body: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><Service xmlns="https://rdws.rd.go.th/JserviceRD3/vatserviceRD3"><username>anonymous</username><password>anonymous</password><TIN>${taxId}</TIN><Name></Name><ProvinceCode>0</ProvinceCode><BranchNumber>${Number(branch)}</BranchNumber><AmphurCode>0</AmphurCode></Service></soap:Body></soap:Envelope>`,
    })
    if (!response.ok) throw new Error('VAT service unavailable')
    return reply(parseVatResponse(await response.text(), taxId, branch))
  } catch { return reply({ status: 'unavailable', error: 'ยังตรวจสอบไม่ได้' }, 502) }
})
