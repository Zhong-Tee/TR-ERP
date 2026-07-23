// แจ้งเตือนเมื่อเปิด Ticket ใหม่เข้ากลุ่ม Ticket (Telegram)
// เรียกจาก client หลัง insert or_issues สำเร็จ: body = { issue_id }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function escapeHtml(value: unknown): string {
  return String(value ?? '-').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function thaiDateTime(value: string): string {
  return new Date(value).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function durationText(minutes: number | null | undefined): string {
  const total = Math.max(0, Number(minutes) || 0)
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const mins = total % 60
  return [days ? `${days} วัน` : '', hours ? `${hours} ชม.` : '', `${mins} นาที`].filter(Boolean).join(' ')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { issue_id, event = 'created', actor_id, test = false, chat_id } = await req.json()
    if (!issue_id && !test) throw new Error('issue_id required')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const { data: settings } = await supabase.from('hr_notification_settings')
      .select('bot_token, ticket_group_chat_id').limit(1).single()
    const targetChatId = test ? chat_id : (settings?.ticket_group_chat_id || Deno.env.get('TICKET_GROUP_CHAT_ID'))

    if (!settings?.bot_token || !targetChatId) {
      return new Response(JSON.stringify({ skipped: 'no bot token or ticket group configured' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const testIssue = {
      id: 'test',
      title: 'ทดสอบการแจ้งเตือน Ticket',
      work_order_name: 'WO-TEST-001',
      created_at: new Date().toISOString(),
      closed_at: new Date().toISOString(),
      duration_minutes: 25,
      type: { name: 'ทดสอบระบบ' },
      order: { bill_no: 'ORD-TEST-001', admin_user: 'TR-ERP' },
      creator: { username: 'TR-ERP System', role: 'system' },
    }
    let issue: any
    if (test) {
      issue = testIssue
    } else {
      const { data, error } = await supabase
        .from('or_issues')
        .select('id, title, work_order_name, created_at, closed_at, duration_minutes, type:or_issue_types(name), order:or_orders(bill_no, admin_user), creator:us_users!created_by(username, role)')
        .eq('id', issue_id)
        .single()
      if (error || !data) throw new Error('issue not found: ' + error?.message)
      issue = data
    }

    const type = Array.isArray(issue.type) ? issue.type[0] : issue.type
    const order = Array.isArray(issue.order) ? issue.order[0] : issue.order
    const creator = Array.isArray(issue.creator) ? issue.creator[0] : issue.creator
    let actor: { username?: string; role?: string } | null = null
    if (event === 'closed' && actor_id) {
      const { data } = await supabase.from('us_users').select('username, role').eq('id', actor_id).single()
      actor = data
    }
    const lines = [
      event === 'closed' ? '✅ <b>ปิด Ticket แล้ว</b>' : '🎫 <b>เปิด Ticket ใหม่</b>',
      `📄 <b>เลขบิล:</b> ${escapeHtml(order?.bill_no)}`,
      `🧾 <b>ผู้สร้างบิล:</b> ${escapeHtml(order?.admin_user)}`,
      `🏭 <b>ใบงาน:</b> ${escapeHtml(issue.work_order_name)}`,
      `📋 <b>ประเภท:</b> ${escapeHtml(type?.name)}`,
      `📝 <b>หัวข้อ:</b> ${escapeHtml(issue.title)}`,
    ]
    if (event === 'closed') {
      lines.push(
        `👤 <b>ผู้ปิด:</b> ${escapeHtml(actor?.username)}`,
        `🏷️ <b>Role:</b> ${escapeHtml(actor?.role)}`,
        `⏱️ <b>ระยะเวลาดำเนินการ:</b> ${escapeHtml(durationText(issue.duration_minutes))}`,
        `🕐 <b>เวลาปิด:</b> ${escapeHtml(thaiDateTime(issue.closed_at || new Date().toISOString()))} น.`,
      )
    } else {
      lines.push(
        `👤 <b>ผู้เปิด:</b> ${escapeHtml(creator?.username)}`,
        `🏷️ <b>Role:</b> ${escapeHtml(creator?.role)}`,
        `🕐 <b>เวลา:</b> ${escapeHtml(thaiDateTime(issue.created_at))} น.`,
      )
    }
    const text = lines.join('\n')
    const response = await fetch(`https://api.telegram.org/bot${settings.bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: targetChatId, text, parse_mode: 'HTML' }),
    })
    const detail = await response.text()

    await supabase.from('hr_notification_logs').insert({
      type: test ? 'issue_test' : event === 'closed' ? 'issue_closed' : 'issue_created',
      target_chat_id: String(targetChatId),
      message: response.ok ? text : detail,
      status: response.ok ? 'sent' : 'failed',
      related_id: test ? undefined : issue_id,
    })

    return new Response(JSON.stringify({ success: response.ok, detail }), {
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
