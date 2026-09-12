// แจ้งเตือนพนักงานเข้าใหม่เข้ากลุ่ม HR (Telegram)
// เรียกจาก client หลังสร้างพนักงานใหม่: body = { employee_ids: string[] }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface EmployeeRow {
  id: string
  employee_code: string
  prefix: string | null
  first_name: string
  last_name: string
  nickname: string | null
  photo_url: string | null
  hire_date: string | null
  department: { name: string } | null
  position: { name: string } | null
}

function fullName(e: EmployeeRow): string {
  return [e.prefix, e.first_name, e.last_name].filter(Boolean).join(' ')
}

function escapeHtml(value: unknown): string {
  return String(value ?? '-').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function hireDateText(d: string | null): string {
  if (!d) return '-'
  return new Date(d + 'T00:00:00').toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { employee_ids } = await req.json()
    if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
      throw new Error('employee_ids required')
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: settings } = await supabase
      .from('hr_notification_settings')
      .select('bot_token, hr_group_chat_id')
      .limit(1)
      .single()

    if (!settings?.bot_token || !settings.hr_group_chat_id) {
      return new Response(JSON.stringify({ skipped: 'no bot token or HR group configured' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: employees, error } = await supabase
      .from('hr_employees')
      .select('id, employee_code, prefix, first_name, last_name, nickname, photo_url, hire_date, department:hr_departments!department_id(name), position:hr_positions!position_id(name)')
      .in('id', employee_ids)
    if (error || !employees?.length) throw new Error('employees not found: ' + error?.message)

    const botBase = `https://api.telegram.org/bot${settings.bot_token}`
    const chatId = settings.hr_group_chat_id
    const rows = employees as unknown as EmployeeRow[]

    let ok = false
    let detail = ''

    if (rows.length === 1) {
      // คนเดียว: ส่งพร้อมรูปโปรไฟล์ (bucket hr-photos เป็น public)
      const e = rows[0]
      const caption = [
        `🎉 <b>พนักงานเข้าใหม่</b>`,
        `🆔 <b>รหัส:</b> ${escapeHtml(e.employee_code)}`,
        `👤 <b>ชื่อ:</b> ${escapeHtml(fullName(e))}`,
        `🏷️ <b>ชื่อเล่น:</b> ${escapeHtml(e.nickname ?? '-')}`,
        `🏢 <b>แผนก:</b> ${escapeHtml(e.department?.name ?? '-')}`,
        `💼 <b>ตำแหน่ง:</b> ${escapeHtml(e.position?.name ?? '-')}`,
        `📅 <b>วันที่เริ่มงาน:</b> ${escapeHtml(hireDateText(e.hire_date))}`,
      ].join('\n')

      const photoUrl = e.photo_url
        ? e.photo_url.startsWith('http')
          ? e.photo_url
          : `${supabaseUrl}/storage/v1/object/public/hr-photos/${e.photo_url}`
        : null

      const res = photoUrl
        ? await fetch(`${botBase}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption, parse_mode: 'HTML' }),
          })
        : await fetch(`${botBase}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: caption, parse_mode: 'HTML' }),
          })
      ok = res.ok
      detail = ok ? caption : await res.text()
    } else {
      // หลายคน (จาก Import): สรุปเป็นข้อความเดียว
      const blocks = rows.map((e, index) => [
        `👤 <b>คนที่ ${index + 1}</b>`,
        `🆔 <b>รหัส:</b> ${escapeHtml(e.employee_code)}`,
        `📛 <b>ชื่อ:</b> ${escapeHtml(fullName(e))}`,
        `🏷️ <b>ชื่อเล่น:</b> ${escapeHtml(e.nickname ?? '-')}`,
        `🏢 <b>แผนก:</b> ${escapeHtml(e.department?.name ?? '-')}`,
        `💼 <b>ตำแหน่ง:</b> ${escapeHtml(e.position?.name ?? '-')}`,
        `📅 <b>วันที่เริ่มงาน:</b> ${escapeHtml(hireDateText(e.hire_date))}`,
      ].join('\n'))
      const header = `🎉 <b>พนักงานเข้าใหม่ ${rows.length} คน</b>`
      const messages: string[] = []
      let current = header
      for (const block of blocks) {
        const next = `${current}\n\n${block}`
        if (next.length > 3800 && current !== header) {
          messages.push(current)
          current = `${header}\n\n${block}`
        } else {
          current = next
        }
      }
      messages.push(current)
      ok = true
      const sentTexts: string[] = []
      for (const text of messages) {
        const res = await fetch(`${botBase}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
        })
        if (!res.ok) {
          ok = false
          sentTexts.push(await res.text())
        } else {
          sentTexts.push(text)
        }
      }
      detail = sentTexts.join('\n\n')
    }

    await supabase.from('hr_notification_logs').insert({
      type: 'new_employee',
      target_chat_id: chatId,
      message: detail,
      status: ok ? 'sent' : 'failed',
      related_id: rows[0].id,
    })

    return new Response(JSON.stringify({ success: ok }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
