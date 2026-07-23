import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface LeaveRequest {
  id: string
  employee_id: string
  start_date: string
  end_date: string
  total_days: number
  leave_type: { name: string } | null
  employee: {
    first_name: string
    last_name: string
    nickname: string | null
    department: { name: string } | null
  } | null
}

interface NotificationSettings {
  bot_token: string
  hr_group_chat_id: string | null
  manager_group_chat_id: string | null
  leave_notify_before_days: number
  leave_notify_morning_time: string
}

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

/** วันที่ตามเวลาไทย (UTC+7) offsetDays วันจากวันนี้ → YYYY-MM-DD */
function bangkokDateStr(offsetDays = 0): string {
  const bkk = new Date(Date.now() + 7 * 3600 * 1000)
  bkk.setUTCDate(bkk.getUTCDate() + offsetDays)
  return bkk.toISOString().split('T')[0]
}

/** YYYY-MM-DD → "10 ก.ค. 2569" */
function thaiDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${THAI_MONTHS[m - 1]} ${y + 543}`
}

function escapeHtml(value: unknown): string {
  return String(value ?? '-').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function empBlock(l: LeaveRequest): string {
  const emp = l.employee
  const name = `${emp?.first_name ?? ''} ${emp?.last_name ?? ''}`.trim() || '-'
  const nickname = emp?.nickname || '-'
  const dept = emp?.department?.name || '-'
  const leaveType = l.leave_type?.name || '-'
  return [
    `👤 <b>ชื่อ:</b> ${escapeHtml(name)}`,
    `🏷️ <b>ชื่อเล่น:</b> ${escapeHtml(nickname)}`,
    `🏢 <b>แผนก:</b> ${escapeHtml(dept)}`,
    `📋 <b>ประเภทลา:</b> ${escapeHtml(leaveType)}`,
    `⏱️ <b>จำนวน:</b> ${escapeHtml(l.total_days)} วัน`,
  ].join('\n')
}

async function sendTelegramMessage(botToken: string, chatId: string, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  })
  if (!res.ok) throw new Error(`Telegram API error: ${await res.text()}`)
  return res.json()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // mode: 'morning' = สรุปคนลาวันนี้ | 'before' = แจ้งล่วงหน้า | 'all' = ทั้งคู่ (default)
    let mode = 'all'
    try {
      const body = await req.json()
      if (body?.mode) mode = String(body.mode)
    } catch { /* ไม่มี body ก็ใช้ all */ }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const { data: settings } = await supabase.from('hr_notification_settings').select('*').limit(1).single()
    if (!settings?.bot_token) {
      return new Response(JSON.stringify({ error: 'No notification settings configured' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const config = settings as NotificationSettings

    const chatIds = [config.hr_group_chat_id, config.manager_group_chat_id].filter(Boolean) as string[]
    if (chatIds.length === 0) {
      return new Response(JSON.stringify({ message: 'No chat IDs configured' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const SELECT = '*, leave_type:hr_leave_types(name), employee:hr_employees!employee_id(first_name, last_name, nickname, department:hr_departments!department_id(name))'
    const logs: { type: string; status: string; message: string }[] = []
    const broadcast = async (type: string, text: string) => {
      const chunks: string[] = []
      let current = ''
      for (const block of text.split('\n\n')) {
        const next = current ? `${current}\n\n${block}` : block
        if (next.length > 3800 && current) {
          chunks.push(current)
          current = block
        } else {
          current = next
        }
      }
      if (current) chunks.push(current)
      for (const chatId of chatIds) {
        for (const chunk of chunks) {
          try {
            await sendTelegramMessage(config.bot_token, chatId, chunk)
            logs.push({ type, status: 'sent', message: `Sent to ${chatId}` })
          } catch (e) {
            logs.push({ type, status: 'failed', message: String(e) })
          }
        }
      }
    }

    const todayStr = bangkokDateStr(0)
    let upcomingCount = 0
    let morningCount = 0

    // ─── แจ้งล่วงหน้า: คนที่จะลาในอีก N วัน (ยังไม่เคยแจ้ง) ───
    if (mode === 'before' || mode === 'all') {
      const notifyBeforeDays = config.leave_notify_before_days || 1
      const futureStr = bangkokDateStr(notifyBeforeDays)
      const { data: upcoming } = await supabase
        .from('hr_leave_requests').select(SELECT)
        .eq('status', 'approved').eq('start_date', futureStr).eq('notified_before', false)

      const list = (upcoming ?? []) as LeaveRequest[]
      upcomingCount = list.length
      // ไม่มีคนลา → ไม่แจ้ง
      if (list.length > 0) {
        const dayWord = notifyBeforeDays === 1 ? 'พรุ่งนี้' : `อีก ${notifyBeforeDays} วัน`
        const text = [
          `📋 <b>แจ้งเตือนล่วงหน้า — มีคนลา${dayWord}</b>`,
          `📅 <b>วันที่:</b> ${thaiDate(futureStr)}`,
          `👥 <b>จำนวน:</b> ${list.length} คน`,
          '',
          list.map(empBlock).join('\n\n'),
        ].join('\n')
        await broadcast('leave_reminder', text)
        for (const l of list) {
          await supabase.from('hr_leave_requests').update({ notified_before: true }).eq('id', l.id)
        }
      }
    }

    // ─── สรุปคนลาวันนี้ (ทุกเช้า) — แสดงทุกคนที่ลาวันนี้ รองรับลาหลายวัน ───
    if (mode === 'morning' || mode === 'all') {
      const { data: todayLeaves } = await supabase
        .from('hr_leave_requests').select(SELECT)
        .eq('status', 'approved').lte('start_date', todayStr).gte('end_date', todayStr)

      const list = (todayLeaves ?? []) as LeaveRequest[]
      morningCount = list.length
      // ไม่มีคนลาวันนี้ → ไม่แจ้ง
      if (list.length > 0) {
        const text = [
          `🌅 <b>สรุปพนักงานลาวันนี้</b>`,
          `📅 <b>วันที่:</b> ${thaiDate(todayStr)}`,
          `👥 <b>จำนวน:</b> ${list.length} คน`,
          '',
          list.map(empBlock).join('\n\n'),
        ].join('\n')
        await broadcast('leave_morning', text)
      }
    }

    for (const log of logs) {
      await supabase.from('hr_notification_logs').insert({
        type: log.type, target_chat_id: chatIds.join(','), message: log.message, status: log.status,
      })
    }

    return new Response(JSON.stringify({ success: true, mode, upcomingCount, morningCount, logs }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
