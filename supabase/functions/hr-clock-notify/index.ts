// แจ้งเตือนเข้างาน/ออกงานเข้ากลุ่ม Manager (Telegram) พร้อมรูปถ่ายจากการบันทึกเวลา
// เรียกจาก client หลังบันทึก hr_time_entries สำเร็จ: body = { entry_id }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const ENTRY_LABELS: Record<string, { emoji: string; label: string }> = {
  clock_in: { emoji: '🟢', label: 'เข้างาน' },
  clock_out: { emoji: '🔴', label: 'ออกงาน' },
  ot_in: { emoji: '🟣', label: 'เข้า OT' },
  ot_out: { emoji: '🟣', label: 'ออก OT' },
}

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + (m || 0)
}

/** นาที → hh:mm น. เช่น 44 → 00:44 น., 815 → 13:35 น. */
function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} น.`
}

/** HH:MM (นาที) ของ timestamp ตามเวลาไทย */
function bangkokMinutes(iso: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso))
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return h * 60 + m
}

function bangkokTimeText(iso: string): string {
  return new Date(iso).toLocaleTimeString('th-TH', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { entry_id } = await req.json()
    if (!entry_id) throw new Error('entry_id required')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

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

    const { data: entry, error: entryError } = await supabase
      .from('hr_time_entries')
      .select('*, employee:hr_employees!employee_id(first_name, last_name, nickname, work_schedule_id, department:hr_departments!department_id(name))')
      .eq('id', entry_id)
      .single()
    if (entryError || !entry) throw new Error('entry not found: ' + entryError?.message)

    const emp = entry.employee
    const name = `${emp?.first_name ?? ''} ${emp?.last_name ?? ''}`.trim() + (emp?.nickname ? ` (${emp.nickname})` : '')
    const dept = emp?.department?.name ?? '-'
    const typeInfo = ENTRY_LABELS[entry.entry_type] ?? { emoji: '🕐', label: entry.entry_type }

    // คำนวณสายเกินผ่อนผัน (เฉพาะเข้างานปกติ) ตามมาตรฐานเวลาของพนักงาน
    let lateText = ''
    if (entry.entry_type === 'clock_in') {
      let sched: { work_start: string; late_grace_min: number } | null = null
      if (emp?.work_schedule_id) {
        const { data } = await supabase
          .from('hr_work_schedules')
          .select('work_start, late_grace_min, is_active')
          .eq('id', emp.work_schedule_id)
          .single()
        if (data?.is_active) sched = data
      }
      if (!sched) {
        const { data } = await supabase
          .from('hr_work_schedules')
          .select('work_start, late_grace_min')
          .eq('is_default', true)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle()
        sched = data
      }
      if (sched) {
        const grace = sched.late_grace_min ?? 0
        const lateBeyond = bangkokMinutes(entry.entry_time) - (toMinutes(sched.work_start) + grace)
        if (lateBeyond > 0) {
          lateText = `\n⚠️ <b>มาสาย ${minutesToHHMM(lateBeyond)}</b>` + (grace > 0 ? ` (เกินผ่อนผัน ${grace} นาที)` : '')
        }
      }
    }

    const distance = entry.distance_m != null ? ` (ห่าง ${Math.round(entry.distance_m)} ม.)` : ''
    const caption =
      `${typeInfo.emoji} <b>${typeInfo.label}</b> — ${name}\n` +
      `🏢 ${dept}\n` +
      `🕐 ${bangkokTimeText(entry.entry_time)} น. • ${entry.location_name ?? '-'}${distance}` +
      lateText

    // รูปถ่ายอยู่ใน bucket private → สร้าง signed URL ให้ Telegram ดึง
    let photoUrl: string | null = null
    if (entry.photo_url) {
      const { data } = await supabase.storage.from('hr-time-clock').createSignedUrl(entry.photo_url, 600)
      photoUrl = data?.signedUrl ?? null
    }

    const botBase = `https://api.telegram.org/bot${settings.bot_token}`
    let res: Response
    if (photoUrl) {
      res = await fetch(`${botBase}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: settings.manager_group_chat_id,
          photo: photoUrl,
          caption,
          parse_mode: 'HTML',
        }),
      })
    } else {
      res = await fetch(`${botBase}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: settings.manager_group_chat_id,
          text: caption,
          parse_mode: 'HTML',
        }),
      })
    }

    const ok = res.ok
    const resText = ok ? 'sent' : await res.text()

    await supabase.from('hr_notification_logs').insert({
      type: `clock_${entry.entry_type}`,
      target_chat_id: settings.manager_group_chat_id,
      message: ok ? caption : resText,
      status: ok ? 'sent' : 'failed',
      related_id: entry_id,
    })

    return new Response(JSON.stringify({ success: ok, detail: resText }), {
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
