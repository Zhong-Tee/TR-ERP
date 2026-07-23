// แจ้งคำขอ OT ใหม่เข้ากลุ่ม Manager (Telegram)
// เรียกจาก client หลังพนักงานยื่นขอ OT สำเร็จ: body = { ot_id }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function escapeHtml(value: unknown): string {
  return String(value ?? '-').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { ot_id, event = 'created' } = await req.json()
    if (!ot_id) throw new Error('ot_id required')

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: settings } = await supabase
      .from('hr_notification_settings')
      .select('bot_token, manager_group_chat_id')
      .limit(1)
      .single()

    if (!settings?.bot_token || !settings.manager_group_chat_id) {
      return new Response(JSON.stringify({ skipped: 'no bot token or manager group configured' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: ot, error } = await supabase
      .from('hr_ot_requests')
      .select('*, employee:hr_employees!employee_id(first_name, last_name, nickname, photo_url, telegram_chat_id, department:hr_departments!department_id(name))')
      .eq('id', ot_id)
      .single()
    if (error || !ot) throw new Error('OT request not found: ' + error?.message)

    const emp = ot.employee
    const name = `${emp?.first_name ?? ''} ${emp?.last_name ?? ''}`.trim() || '-'
    const nickname = emp?.nickname ?? '-'
    const dept = emp?.department?.name ?? '-'
    const dateText = new Date(ot.request_date + 'T00:00:00').toLocaleDateString('th-TH', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })

    const header =
      event === 'approved'
        ? '✅ <b>อนุมัติ OT แล้ว</b>'
        : event === 'rejected'
          ? '❌ <b>ไม่อนุมัติ OT</b>'
          : '🕐 <b>คำขอ OT ใหม่ — รออนุมัติ</b>'

    const textLines = [
      header,
      `👤 <b>ชื่อ:</b> ${escapeHtml(name)}`,
      `🏷️ <b>ชื่อเล่น:</b> ${escapeHtml(nickname)}`,
      `🏢 <b>แผนก:</b> ${escapeHtml(dept)}`,
      `📅 <b>วันที่:</b> ${escapeHtml(dateText)}`,
      `🕐 <b>ช่วงเวลา:</b> ${escapeHtml(String(ot.ot_start).slice(0, 5))}–${escapeHtml(String(ot.ot_end).slice(0, 5))} น.`,
      `⏱️ <b>จำนวน:</b> ${escapeHtml(ot.hours ?? '-')} ชม.`,
    ]
    if (ot.reason) textLines.push(`📝 <b>เหตุผล:</b> ${escapeHtml(ot.reason)}`)
    if (event === 'rejected' && ot.reject_reason) {
      textLines.push(`❗ <b>เหตุผลที่ไม่อนุมัติ:</b> ${escapeHtml(ot.reject_reason)}`)
    }
    const text = textLines.join('\n')

    // รูปโปรไฟล์พนักงาน (bucket hr-photos เป็น public)
    const photoUrl = emp?.photo_url
      ? emp.photo_url.startsWith('http')
        ? emp.photo_url
        : `${supabaseUrl}/storage/v1/object/public/hr-photos/${emp.photo_url}`
      : null

    const botBase = `https://api.telegram.org/bot${settings.bot_token}`
    const res = photoUrl
      ? await fetch(`${botBase}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: settings.manager_group_chat_id, photo: photoUrl, caption: text, parse_mode: 'HTML' }),
        })
      : await fetch(`${botBase}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: settings.manager_group_chat_id, text, parse_mode: 'HTML' }),
        })

    const ok = res.ok
    const detail = ok ? 'sent' : await res.text()

    await supabase.from('hr_notification_logs').insert({
      type: `ot_${event}`,
      target_chat_id: settings.manager_group_chat_id,
      message: ok ? text : detail,
      status: ok ? 'sent' : 'failed',
      related_id: ot_id,
    })

    // แจ้งผลอนุมัติ/ปฏิเสธ เข้าแชทส่วนตัวพนักงาน (ถ้ากรอก telegram_chat_id ไว้)
    if ((event === 'approved' || event === 'rejected') && emp?.telegram_chat_id) {
      const pLines = [
        event === 'approved'
          ? '✅ <b>คำขอ OT ของคุณได้รับการอนุมัติ</b>'
          : '❌ <b>คำขอ OT ของคุณถูกปฏิเสธ</b>',
        `📅 <b>วันที่:</b> ${escapeHtml(dateText)}`,
        `🕐 <b>ช่วงเวลา:</b> ${escapeHtml(String(ot.ot_start).slice(0, 5))}–${escapeHtml(String(ot.ot_end).slice(0, 5))} น.`,
        `⏱️ <b>จำนวน:</b> ${escapeHtml(ot.hours ?? '-')} ชม.`,
      ]
      if (event === 'rejected' && ot.reject_reason) {
        pLines.push(`❗ <b>เหตุผล:</b> ${escapeHtml(ot.reject_reason)}`)
      }
      const personalText = pLines.join('\n')
      try {
        const pRes = await fetch(`${botBase}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: emp.telegram_chat_id, text: personalText, parse_mode: 'HTML' }),
        })
        await supabase.from('hr_notification_logs').insert({
          type: `ot_${event}_personal`,
          target_chat_id: String(emp.telegram_chat_id),
          message: pRes.ok ? personalText : await pRes.text(),
          status: pRes.ok ? 'sent' : 'failed',
          related_id: ot_id,
        })
      } catch (_) { /* ไม่ให้กระทบผลรวม */ }
    }

    return new Response(JSON.stringify({ success: ok, detail }), {
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
