// แจ้งใบลาใหม่ (รออนุมัติ) เข้ากลุ่ม HR (Telegram)
// เรียกจาก client หลังพนักงานยื่นใบลาสำเร็จ: body = { leave_id }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function thaiDate(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function escapeHtml(value: unknown): string {
  return String(value ?? '-').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { leave_id, event = 'created' } = await req.json()
    if (!leave_id) throw new Error('leave_id required')

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

    const { data: leave, error } = await supabase
      .from('hr_leave_requests')
      .select('*, leave_type:hr_leave_types(name), employee:hr_employees!employee_id(first_name, last_name, nickname, photo_url, telegram_chat_id, department:hr_departments!department_id(name))')
      .eq('id', leave_id)
      .single()
    if (error || !leave) throw new Error('leave request not found: ' + error?.message)

    const emp = leave.employee
    const name = `${emp?.first_name ?? ''} ${emp?.last_name ?? ''}`.trim() || '-'
    const nickname = emp?.nickname ?? '-'
    const dept = emp?.department?.name ?? '-'
    const leaveType = leave.leave_type?.name ?? '-'
    const leaveDateText = leave.start_date === leave.end_date
      ? thaiDate(leave.start_date)
      : `${thaiDate(leave.start_date)} – ${thaiDate(leave.end_date)}`
    const leaveTimeText = leave.leave_mode === 'hourly'
      ? `${String(leave.start_time ?? '').slice(0, 5)}–${String(leave.end_time ?? '').slice(0, 5)} น.`
      : null
    const leaveAmountText = leave.leave_mode === 'hourly'
      ? `${leave.total_hours ?? 0} ชม.`
      : `${leave.total_days} วัน`

    const header =
      event === 'approved'
        ? '✅ <b>อนุมัติใบลาแล้ว</b>'
        : event === 'rejected'
          ? '❌ <b>ไม่อนุมัติใบลา</b>'
          : '📋 <b>ใบลาใหม่ — รออนุมัติ</b>'

    const textLines = [
      header,
      `👤 <b>ชื่อ:</b> ${escapeHtml(name)}`,
      `🏷️ <b>ชื่อเล่น:</b> ${escapeHtml(nickname)}`,
      `🏢 <b>แผนก:</b> ${escapeHtml(dept)}`,
      `📋 <b>ประเภทลา:</b> ${escapeHtml(leaveType)}`,
      `📅 <b>วันที่:</b> ${escapeHtml(leaveDateText)}`,
    ]
    if (leaveTimeText) textLines.push(`🕐 <b>ช่วงเวลา:</b> ${escapeHtml(leaveTimeText)}`)
    textLines.push(`⏱️ <b>จำนวน:</b> ${escapeHtml(leaveAmountText)}`)
    if (leave.reason) textLines.push(`📝 <b>เหตุผล:</b> ${escapeHtml(leave.reason)}`)
    if (event === 'rejected' && leave.reject_reason) {
      textLines.push(`❗ <b>เหตุผลที่ไม่อนุมัติ:</b> ${escapeHtml(leave.reject_reason)}`)
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
          body: JSON.stringify({ chat_id: settings.hr_group_chat_id, photo: photoUrl, caption: text, parse_mode: 'HTML' }),
        })
      : await fetch(`${botBase}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: settings.hr_group_chat_id, text, parse_mode: 'HTML' }),
        })

    const ok = res.ok
    const detail = ok ? 'sent' : await res.text()

    await supabase.from('hr_notification_logs').insert({
      type: `leave_${event}`,
      target_chat_id: settings.hr_group_chat_id,
      message: ok ? text : detail,
      status: ok ? 'sent' : 'failed',
      related_id: leave_id,
    })

    // แจ้งผลอนุมัติ/ปฏิเสธ เข้าแชทส่วนตัวพนักงาน (ถ้ากรอก telegram_chat_id ไว้)
    if ((event === 'approved' || event === 'rejected') && emp?.telegram_chat_id) {
      const pLines = [
        event === 'approved'
          ? '✅ <b>ใบลาของคุณได้รับการอนุมัติ</b>'
          : '❌ <b>ใบลาของคุณถูกปฏิเสธ</b>',
        `📋 <b>ประเภทลา:</b> ${escapeHtml(leaveType)}`,
        `📅 <b>วันที่:</b> ${escapeHtml(leaveDateText)}`,
      ]
      if (leaveTimeText) pLines.push(`🕐 <b>ช่วงเวลา:</b> ${escapeHtml(leaveTimeText)}`)
      pLines.push(`⏱️ <b>จำนวน:</b> ${escapeHtml(leaveAmountText)}`)
      if (event === 'rejected' && leave.reject_reason) {
        pLines.push(`❗ <b>เหตุผล:</b> ${escapeHtml(leave.reject_reason)}`)
      }
      const personalText = pLines.join('\n')
      try {
        const pRes = await fetch(`${botBase}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: emp.telegram_chat_id, text: personalText, parse_mode: 'HTML' }),
        })
        await supabase.from('hr_notification_logs').insert({
          type: `leave_${event}_personal`,
          target_chat_id: String(emp.telegram_chat_id),
          message: pRes.ok ? personalText : await pRes.text(),
          status: pRes.ok ? 'sent' : 'failed',
          related_id: leave_id,
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
