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
  reason: string | null
  status: string
  notified_before: boolean
  notified_morning: boolean
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

async function sendTelegramMessage(botToken: string, chatId: string, text: string) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Telegram API error: ${err}`)
  }
  return res.json()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data: settings } = await supabase
      .from('hr_notification_settings')
      .select('*')
      .limit(1)
      .single()

    if (!settings || !settings.bot_token) {
      return new Response(JSON.stringify({ error: 'No notification settings configured' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const config = settings as NotificationSettings
    const today = new Date()
    const todayStr = today.toISOString().split('T')[0]

    const notifyBeforeDays = config.leave_notify_before_days || 1
    const futureDate = new Date(today)
    futureDate.setDate(futureDate.getDate() + notifyBeforeDays)
    const futureDateStr = futureDate.toISOString().split('T')[0]

    const chatIds = [config.hr_group_chat_id, config.manager_group_chat_id].filter(Boolean) as string[]
    if (chatIds.length === 0) {
      return new Response(JSON.stringify({ message: 'No chat IDs configured' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const logs: { type: string; status: string; message: string }[] = []

    // 1. Leave reminder (day before): leaves starting tomorrow that haven't been notified
    const { data: upcomingLeaves } = await supabase
      .from('hr_leave_requests')
      .select('*, leave_type:hr_leave_types(name), employee:hr_employees(first_name, last_name, nickname, department:hr_departments(name))')
      .eq('status', 'approved')
      .eq('start_date', futureDateStr)
      .eq('notified_before', false)

    if (upcomingLeaves && upcomingLeaves.length > 0) {
      const lines = (upcomingLeaves as LeaveRequest[]).map((l) => {
        const emp = l.employee
        const name = emp?.nickname || `${emp?.first_name} ${emp?.last_name}`
        const dept = emp?.department?.name || '-'
        const leaveType = l.leave_type?.name || '-'
        return `- ${name} (${dept}) ${leaveType} ${l.total_days} วัน`
      })

      const message = `📋 <b>แจ้งเตือนการลาพรุ่งนี้</b> (${futureDateStr})\n\n${lines.join('\n')}`

      for (const chatId of chatIds) {
        try {
          await sendTelegramMessage(config.bot_token, chatId, message)
          logs.push({ type: 'leave_reminder', status: 'sent', message: `Sent to ${chatId}` })
        } catch (e) {
          logs.push({ type: 'leave_reminder', status: 'failed', message: String(e) })
        }
      }

      for (const l of upcomingLeaves as LeaveRequest[]) {
        await supabase.from('hr_leave_requests').update({ notified_before: true }).eq('id', l.id)
      }
    }

    // 2. Morning notification: who is on leave today
    const { data: todayLeaves } = await supabase
      .from('hr_leave_requests')
      .select('*, leave_type:hr_leave_types(name), employee:hr_employees(first_name, last_name, nickname, department:hr_departments(name))')
      .eq('status', 'approved')
      .lte('start_date', todayStr)
      .gte('end_date', todayStr)
      .eq('notified_morning', false)

    if (todayLeaves && todayLeaves.length > 0) {
      const lines = (todayLeaves as LeaveRequest[]).map((l) => {
        const emp = l.employee
        const name = emp?.nickname || `${emp?.first_name} ${emp?.last_name}`
        const dept = emp?.department?.name || '-'
        const leaveType = l.leave_type?.name || '-'
        return `- ${name} (${dept}) ${leaveType}`
      })

      const message = `🌅 <b>สรุปพนักงานลาวันนี้</b> (${todayStr})\nจำนวน ${todayLeaves.length} คน\n\n${lines.join('\n')}`

      for (const chatId of chatIds) {
        try {
          await sendTelegramMessage(config.bot_token, chatId, message)
          logs.push({ type: 'leave_morning', status: 'sent', message: `Sent to ${chatId}` })
        } catch (e) {
          logs.push({ type: 'leave_morning', status: 'failed', message: String(e) })
        }
      }

      for (const l of todayLeaves as LeaveRequest[]) {
        await supabase.from('hr_leave_requests').update({ notified_morning: true }).eq('id', l.id)
      }
    }

    // Log all notifications
    for (const log of logs) {
      await supabase.from('hr_notification_logs').insert({
        type: log.type,
        target_chat_id: chatIds.join(','),
        message: log.message,
        status: log.status,
      })
    }

    return new Response(JSON.stringify({
      success: true,
      upcoming_notified: upcomingLeaves?.length || 0,
      morning_notified: todayLeaves?.length || 0,
      logs,
    }), {
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
