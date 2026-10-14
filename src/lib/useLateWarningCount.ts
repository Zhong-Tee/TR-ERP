import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { LATE_CHANGED_EVENT } from './lateAccumulationApi'

/** The badge and the table use the same server-side eligibility rules. */
export function useLateWarningCount(enabled: boolean) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    let rerun = false
    const load = async () => {
      if (running) { rerun = true; return }
      running = true
      try {
        const { data, error } = await supabase.rpc('hr_late_ready_count')
        if (error) throw error
        if (!disposed) setCount(Number(data ?? 0))
      } catch (error) { if (!disposed) console.error('โหลดจำนวนรายการสะสมการมาสายไม่สำเร็จ', error) }
      finally {
        running = false
        if (rerun && !disposed) { rerun = false; void load() }
      }
    }
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { void load() }, 350) }
    void load()
    const interval = setInterval(() => { void load() }, 60_000)
    window.addEventListener(LATE_CHANGED_EVENT, refresh)
    window.addEventListener('focus', refresh)
    const channel = supabase.channel(`late-badge-${crypto.randomUUID()}`)
    for (const table of ['hr_warnings', 'hr_time_entries', 'hr_time_certifications', 'hr_leave_requests',
      'hr_late_settings', 'hr_late_exceptions', 'hr_employee_work_calendar', 'hr_work_schedules', 'hr_wfh_requests']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, refresh)
    }
    channel.subscribe()
    return () => {
      disposed = true; clearTimeout(timer); clearInterval(interval)
      window.removeEventListener(LATE_CHANGED_EVENT, refresh)
      window.removeEventListener('focus', refresh)
      void supabase.removeChannel(channel)
    }
  }, [enabled])
  return enabled ? count : 0
}
