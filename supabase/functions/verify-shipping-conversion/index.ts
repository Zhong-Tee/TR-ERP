import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  let persistFailure: ((message: string) => Promise<void>) | null = null
  const fail = async (message: string) => { try { if (persistFailure) await persistFailure(message) } catch { /* Failure to log must never turn verification into success. */ } return reply({ error: message }, 400) }
  try {
    if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405)
    const url = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const authorization = req.headers.get('authorization') || ''
    const caller = createClient(url, anon, { global: { headers: { Authorization: authorization } } })
    const { data: { user }, error: authError } = await caller.auth.getUser()
    if (authError || !user) return reply({ error: 'Unauthorized' }, 401)
    const admin = createClient(url, key)
    const { data: actor } = await admin.from('us_users').select('role').eq('id', user.id).single()
    if (!actor || !['superadmin', 'admin', 'sales-tr', 'sales-pump'].includes(actor.role)) return reply({ error: 'ฝ่ายขายเท่านั้นที่ตรวจสลิปค่าส่งได้' }, 403)
    const { requestId, storagePath } = await req.json()
    const { data: request, error } = await caller.from('or_shipping_conversion_requests').select('*,or_orders(channel_code)').eq('id', requestId).single()
    if (error || !request || request.status !== 'pending') return reply({ error: 'ไม่พบคำขอที่รอดำเนินการ' }, 400)
    if (Number(request.shipping_cost) === 0 && !request.zero_approved_by) return reply({ error: 'รออนุมัติค่าส่ง 0 ก่อนตรวจสลิปเพิ่ม' }, 400)
    if (!['superadmin', 'admin'].includes(actor.role) && request.requested_by !== user.id) return reply({ error: 'ไม่มีสิทธิ์ตรวจสลิปคำขอนี้' }, 403)
    if (typeof storagePath !== 'string' || !storagePath.startsWith(`slip-images/shipping-conversion/${request.id}/${user.id}/`) || storagePath.includes('..')) return reply({ error: 'ที่เก็บสลิปไม่ถูกต้อง' }, 400)
    persistFailure = async (message) => { await admin.from('or_shipping_conversion_requests').update({ verification_error: message, last_verification_at: new Date().toISOString() }).eq('id', request.id).eq('status', 'pending') }
    const { data: links, error: linksError } = await admin.from('bank_settings_channels').select('bank_setting_id').eq('channel_code', request.or_orders.channel_code)
    if (linksError || !links?.length) return await fail('ยังไม่ได้ตั้งค่าบัญชีรับเงินของช่องทางนี้')
    const { data: banks, error: bankError } = await admin.from('bank_settings').select('account_number,bank_code').in('id', links.map((r) => r.bank_setting_id)).eq('is_active', true)
    if (bankError || !banks?.length) return await fail('ไม่พบบัญชีรับเงินที่ใช้งาน')
    // The caller cannot choose the receiving bank or submit a fabricated verification result.
    let verified: Record<string, any> | null = null
    for (const bank of banks) {
      if (!bank.account_number || !bank.bank_code) continue
      const response = await fetch(`${url}/functions/v1/verify-slip`, {
        method: 'POST', headers: { Authorization: authorization, apikey: anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'storage', storagePath, bankAccount: bank.account_number, bankCode: bank.bank_code }),
      })
      const result = await response.json()
      if (response.ok && result.success === true && result.accountNameMatch === true && result.bankCodeMatch === true && result.easyslipResponse?.data?.transRef && Number(result.amount) > 0) {
        verified = result
        break
      }
      if (!response.ok || !result.easyslipResponse?.data?.transRef) return await fail(result.error || result.message || 'EasySlip ตรวจสอบไม่สำเร็จ กรุณาลองใหม่')
    }
    if (!verified) return await fail('บัญชีรับเงินหรือธนาคารไม่ตรงกับช่องทางนี้')
    const { data: ready, error: saveError } = await admin.rpc('or_record_shipping_payment', {
      p_request_id: request.id, p_trans_ref: verified.easyslipResponse.data.transRef,
      p_amount: verified.amount, p_storage_path: storagePath, p_slip_image_url: `${url}/storage/v1/object/public/${storagePath}`, p_response: verified.easyslipResponse, p_verified_by: user.id,
    })
    if (saveError) return await fail(saveError.message)
    return reply({ success: true, ready, amount: verified.amount })
  } catch (error) {
    return await fail(error instanceof Error ? error.message : 'ตรวจสลิปไม่สำเร็จ')
  }
})
