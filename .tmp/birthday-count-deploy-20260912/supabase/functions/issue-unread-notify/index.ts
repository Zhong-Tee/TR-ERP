// แจ้ง Telegram เมื่อข้อความใน Ticket ยังไม่มีผู้อื่นอ่านภายใน 5 นาที
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
const esc = (v: unknown) => String(v ?? '-').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: settings } = await db.from('hr_notification_settings')
      .select('bot_token, ticket_group_chat_id').limit(1).single()
    const ticketGroupChatId = settings?.ticket_group_chat_id || Deno.env.get('TICKET_GROUP_CHAT_ID')
    if (!settings?.bot_token || !ticketGroupChatId) {
      return new Response(JSON.stringify({ skipped: 'ticket Telegram is not configured' }), { headers: corsHeaders })
    }

    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString()
    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
    const { data: messages, error } = await db.from('or_issue_messages')
      .select('id, issue_id, sender_id, sender_name, message, created_at, is_hidden, issue:or_issues(title, work_order_name, order:or_orders(bill_no, admin_user))')
      .lte('created_at', cutoff).gte('created_at', since).eq('is_hidden', false)
      .order('created_at', { ascending: true }).limit(100)
    if (error) throw error

    let issueSent = 0
    for (const message of messages ?? []) {
      const [{ data: prior }, { data: reads }] = await Promise.all([
        db.from('hr_notification_logs').select('id').eq('type', 'issue_chat_unread')
          .eq('related_id', message.id).limit(1),
        db.from('or_issue_reads').select('user_id, last_read_at').eq('issue_id', message.issue_id),
      ])
      if (prior?.length) continue
      const wasRead = (reads ?? []).some((r) =>
        r.user_id !== message.sender_id && new Date(r.last_read_at).getTime() >= new Date(message.created_at).getTime())
      if (wasRead) continue

      const issue = Array.isArray(message.issue) ? message.issue[0] : message.issue
      const order = Array.isArray(issue?.order) ? issue.order[0] : issue?.order
      const text = [
        '💬 <b>ข้อความ Ticket ยังไม่ได้อ่านเกิน 5 นาที</b>',
        `📄 <b>เลขบิล:</b> ${esc(order?.bill_no)}`,
        `🧾 <b>ผู้สร้างบิล:</b> ${esc(order?.admin_user)}`,
        `🏭 <b>ใบงาน:</b> ${esc(issue?.work_order_name)}`,
        `🎫 <b>Ticket:</b> ${esc(issue?.title)}`,
        `👤 <b>ผู้ส่ง:</b> ${esc(message.sender_name)}`,
        `💭 <b>ข้อความ:</b> ${esc(message.message)}`,
      ].join('\n')
      const telegram = await fetch(`https://api.telegram.org/bot${settings.bot_token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: ticketGroupChatId, text, parse_mode: 'HTML' }),
      })
      const detail = await telegram.text()
      await db.from('hr_notification_logs').insert({
        type: 'issue_chat_unread', target_chat_id: String(ticketGroupChatId),
        message: telegram.ok ? text : detail, status: telegram.ok ? 'sent' : 'failed', related_id: message.id,
      })
      if (telegram.ok) issueSent++
    }

    // Confirm Order Chat: ใช้กลุ่ม Ticket เดียวกัน และเตือนเมื่อไม่มีผู้ใช้อื่นอ่านเกิน 5 นาที
    const { data: orderMessages, error: orderError } = await db.from('or_order_chat_logs')
      .select('id, order_id, bill_no, sender_id, sender_name, message, created_at, is_hidden, order:or_orders(admin_user, work_order_name, channel_code, status)')
      .lte('created_at', cutoff).gte('created_at', since).eq('is_hidden', false)
      .order('created_at', { ascending: true }).limit(100)
    if (orderError) throw orderError

    let orderSent = 0
    for (const message of orderMessages ?? []) {
      const [{ data: prior }, { data: reads }] = await Promise.all([
        db.from('hr_notification_logs').select('id').eq('type', 'order_chat_unread')
          .eq('related_id', message.id).limit(1),
        db.from('or_order_chat_reads').select('user_id, last_read_at').eq('order_id', message.order_id),
      ])
      if (prior?.length) continue
      const wasRead = (reads ?? []).some((r) =>
        r.user_id !== message.sender_id && new Date(r.last_read_at).getTime() >= new Date(message.created_at).getTime())
      if (wasRead) continue

      const order = Array.isArray(message.order) ? message.order[0] : message.order
      const text = [
        '💬 <b>ข้อความ Confirm Chat ยังไม่ได้อ่านเกิน 5 นาที</b>',
        `📄 <b>เลขบิล:</b> ${esc(message.bill_no)}`,
        `🛒 <b>ช่องทาง:</b> ${esc(order?.channel_code)}`,
        `🧾 <b>ผู้สร้างบิล:</b> ${esc(order?.admin_user)}`,
        `🏭 <b>ใบงาน:</b> ${esc(order?.work_order_name)}`,
        `📌 <b>สถานะ:</b> ${esc(order?.status)}`,
        `👤 <b>ผู้ส่ง:</b> ${esc(message.sender_name)}`,
        `💭 <b>ข้อความ:</b> ${esc(message.message)}`,
      ].join('\n')
      const telegram = await fetch(`https://api.telegram.org/bot${settings.bot_token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: ticketGroupChatId, text, parse_mode: 'HTML' }),
      })
      const detail = await telegram.text()
      await db.from('hr_notification_logs').insert({
        type: 'order_chat_unread', target_chat_id: String(ticketGroupChatId),
        message: telegram.ok ? text : detail, status: telegram.ok ? 'sent' : 'failed', related_id: message.id,
      })
      if (telegram.ok) orderSent++
    }

    return new Response(JSON.stringify({ success: true, issue_sent: issueSent, order_sent: orderSent }), { headers: corsHeaders })
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: corsHeaders })
  }
})
