import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const allowedRoles = new Set(['superadmin', 'admin', 'hr', 'account'])

function escapeHtml(value: unknown): string {
  return String(value ?? '-').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' }
  try {
    const authorization = req.headers.get('Authorization') || ''
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const caller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } })
    const { data: authData, error: authError } = await caller.auth.getUser()
    if (authError || !authData.user) throw new Error('Unauthorized')

    const admin = createClient(supabaseUrl, serviceKey)
    const { data: appUser } = await admin.from('us_users').select('role, is_active').eq('id', authData.user.id).single()
    if (!appUser?.is_active || !allowedRoles.has(appUser.role)) throw new Error('Forbidden')

    const body = await req.json()
    const employeeIds = Array.isArray(body?.employee_ids)
      ? [...new Set(body.employee_ids.map(String))].slice(0, 200)
      : []
    if (!employeeIds.length) throw new Error('employee_ids required')

    const { data: settings } = await admin.from('hr_notification_settings').select('bot_token').limit(1).single()
    if (!settings?.bot_token) throw new Error('ยังไม่ได้ตั้งค่า Telegram Bot Token')

    const { data: employees, error } = await admin.from('hr_employees')
      .select('id, employee_code, prefix, first_name, last_name, nickname, telegram_chat_id')
      .in('id', employeeIds)
      .order('employee_code')
    if (error) throw error

    const botUrl = `https://api.telegram.org/bot${settings.bot_token}/sendMessage`
    const results = []
    for (const employee of employees || []) {
      const name = [employee.prefix, employee.first_name, employee.last_name].filter(Boolean).join(' ')
      if (!String(employee.telegram_chat_id || '').trim()) {
        results.push({ employee_id: employee.id, employee_code: employee.employee_code, name, ok: false, error: 'ยังไม่ได้กรอก Telegram ID' })
        continue
      }
      const text = [
        '✅ <b>ทดสอบการเชื่อมต่อ Telegram สำเร็จ</b>',
        `🆔 <b>รหัสพนักงาน:</b> ${escapeHtml(employee.employee_code)}`,
        `👤 <b>ชื่อ:</b> ${escapeHtml(name)}`,
        `🏷️ <b>ชื่อเล่น:</b> ${escapeHtml(employee.nickname || '-')}`,
        '',
        'ข้อความนี้ส่งจากระบบ TR-ERP เพื่อยืนยันว่า Telegram ID ถูกต้อง',
      ].join('\n')
      let ok = false
      let detail = ''
      try {
        const response = await fetch(botUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: String(employee.telegram_chat_id).trim(), text, parse_mode: 'HTML' }),
        })
        const telegram = await response.json().catch(() => ({}))
        ok = response.ok && telegram?.ok === true
        detail = ok ? 'ส่งสำเร็จ' : String(telegram?.description || `Telegram HTTP ${response.status}`)
      } catch (sendError) {
        detail = sendError instanceof Error ? sendError.message : String(sendError)
      }
      results.push({ employee_id: employee.id, employee_code: employee.employee_code, name, ok, error: ok ? null : detail })
      await admin.from('hr_notification_logs').insert({
        type: 'telegram_test_personal', target_chat_id: String(employee.telegram_chat_id),
        message: ok ? text : detail, status: ok ? 'sent' : 'failed', related_id: employee.id,
      })
    }
    return new Response(JSON.stringify({ success: true, results }), { status: 200, headers: jsonHeaders })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message === 'Unauthorized' ? 401 : message === 'Forbidden' ? 403 : 400
    return new Response(JSON.stringify({ error: message }), { status, headers: jsonHeaders })
  }
})
