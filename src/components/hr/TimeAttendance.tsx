import { useState, useEffect, useCallback, useMemo } from 'react'
import { FiRefreshCw, FiMapPin, FiCamera, FiX, FiSearch, FiDownload } from 'react-icons/fi'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import Modal from '../ui/Modal'
import {
  fetchTimeEntries,
  fetchEmployees,
  fetchWorkSchedules,
  fetchLeaveRequests,
  getTimeClockPhotoUrl,
  getTimeClockPhotoUrls,
} from '../../lib/hrApi'
import type { HRTimeEntry, HREmployee, HRWorkSchedule, HRTimeEntryType } from '../../types'

const ENTRY_LABELS: Record<HRTimeEntryType, string> = {
  clock_in: 'เข้างาน',
  clock_out: 'ออกงาน',
  ot_in: 'เข้า OT',
  ot_out: 'ออก OT',
}

const ENTRY_BADGE: Record<HRTimeEntryType, string> = {
  clock_in: 'bg-emerald-100 text-emerald-800',
  clock_out: 'bg-rose-100 text-rose-800',
  ot_in: 'bg-indigo-100 text-indigo-800',
  ot_out: 'bg-violet-100 text-violet-800',
}

const Loading = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" />
  </div>
)

function todayStr(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function monthStr(): string {
  return todayStr().slice(0, 7)
}

function empName(e?: HREmployee | null): string {
  if (!e) return '-'
  const nick = e.nickname ? ` (${e.nickname})` : ''
  return `${e.first_name} ${e.last_name}${nick}`
}

/** นาทีของเวลา ISO ตามเวลาท้องถิ่น */
function localMinutes(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

function parseTimeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + (m || 0)
}

/** นาที → hh:mm น. เช่น 44 → 00:44 น., 644 → 10:44 น. */
function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} น.`
}

/** ชั่วโมง (ทศนิยม) → hh:mm น. เช่น 0.06 → 00:04 น., 3.5 → 03:30 น. */
function hoursToHHMM(hours: number): string {
  return minutesToHHMM(Math.round(hours * 60))
}

type SummaryRow = {
  employee: HREmployee
  scheduleName: string
  presentDays: number
  lateCount: number
  lateMinutes: number
  otHours: number
  leaveDays: number
  absentDays: number
}

/** แถว Dashboard: รวมบันทึกเข้า/ออก/OT ของพนักงาน 1 คนใน 1 วัน */
type DashRow = {
  employee: HREmployee
  clockIn?: HRTimeEntry
  clockOut?: HRTimeEntry
  otIn?: HRTimeEntry
  otOut?: HRTimeEntry
}

/** ISO → HH:mm (เวลาท้องถิ่น) */
function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
}

/** จำนวนนาที OT ของแถว (มีทั้งเข้า-ออก OT เท่านั้นจึงคำนวณได้) */
function otMinutesOf(r: DashRow): number {
  if (!r.otIn || !r.otOut) return 0
  const ms = new Date(r.otOut.entry_time).getTime() - new Date(r.otIn.entry_time).getTime()
  return ms > 0 ? Math.round(ms / 60000) : 0
}

type DashStatusKey = 'normal' | 'late' | 'missing_out' | 'working' | 'missing_in'
/** สถานะการบันทึกของพนักงาน 1 คนในวันนั้น — sev สูง = ต้องรีบจัดการ (เรียงขึ้นบน) */
function dashStatusOf(r: DashRow, lateMin: number, isPast: boolean): {
  key: DashStatusKey
  label: string
  cls: string
  tint: string
  sev: number
} {
  if (r.clockIn && r.clockOut) {
    return lateMin > 0
      ? { key: 'late', label: 'สาย', cls: 'bg-amber-100 text-amber-800', tint: 'border-amber-200', sev: 2 }
      : { key: 'normal', label: 'ปกติ', cls: 'bg-emerald-100 text-emerald-700', tint: 'border-emerald-200', sev: 0 }
  }
  if (r.clockIn && !r.clockOut) {
    return isPast
      ? { key: 'missing_out', label: 'ลืมออกงาน', cls: 'bg-rose-100 text-rose-700', tint: 'border-rose-300', sev: 3 }
      : { key: 'working', label: 'ยังทำงานอยู่', cls: 'bg-sky-100 text-sky-700', tint: 'border-sky-200', sev: 1 }
  }
  return { key: 'missing_in', label: 'ลืมเข้างาน', cls: 'bg-rose-100 text-rose-700', tint: 'border-rose-300', sev: 3 }
}

/** ค่า fallback กรณียังไม่มีมาตรฐานเวลาในระบบ */
const FALLBACK_SCHEDULE = {
  name: 'มาตรฐาน (08:00)',
  work_start: '08:00',
  work_end: '17:00',
  late_grace_min: 0,
  work_days: '1,2,3,4,5,6',
}

type TabKey = 'entries' | 'summary'

export default function TimeAttendance() {
  const [activeTab, setActiveTab] = useState<TabKey>('entries')
  const [schedules, setSchedules] = useState<HRWorkSchedule[]>([])

  // ─── แท็บบันทึกเวลาสด ───
  const [entries, setEntries] = useState<HRTimeEntry[]>([])
  const [entriesLoading, setEntriesLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState(todayStr().slice(0, 7) + '-01')
  const [dateTo, setDateTo] = useState(todayStr())
  const [typeFilter, setTypeFilter] = useState('')
  /** มุมมองแท็บบันทึกเวลาสด: ตารางดิบ หรือ Dashboard รายคน/รายวัน */
  const [entriesView, setEntriesView] = useState<'table' | 'dashboard'>('table')
  const [photoView, setPhotoView] = useState<{ url: string; caption: string } | null>(null)
  const [photoLoading, setPhotoLoading] = useState(false)
  /** signed URL รูปย่อในตาราง (path → url) */
  const [photoThumbs, setPhotoThumbs] = useState<Record<string, string>>({})

  // ─── แท็บสรุป ───
  const [summaryMonth, setSummaryMonth] = useState(monthStr())
  const [summaryRows, setSummaryRows] = useState<SummaryRow[]>([])
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summarySearch, setSummarySearch] = useState('')

  useEffect(() => {
    fetchWorkSchedules().then(setSchedules).catch(() => {})
  }, [])

  const defaultSchedule = useMemo(
    () => schedules.find((s) => s.is_default && s.is_active) ?? schedules.find((s) => s.is_active) ?? null,
    [schedules],
  )

  /** นาทีที่สายเกินผ่อนผัน ของบันทึกเข้างาน (clock_in) ตามมาตรฐานเวลาของพนักงานคนนั้น — 0 = ไม่สาย/ไม่ใช่เข้างาน */
  const entryLateMinutes = (entry: HRTimeEntry): number => {
    if (entry.entry_type !== 'clock_in') return 0
    const empSchedId = (entry.employee as (HREmployee & { work_schedule_id?: string }))?.work_schedule_id
    const assigned = empSchedId ? schedules.find((s) => s.id === empSchedId && s.is_active) : undefined
    const sched = assigned ?? defaultSchedule ?? FALLBACK_SCHEDULE
    const startMin = parseTimeToMinutes(sched.work_start.slice(0, 5)) + (sched.late_grace_min ?? 0)
    return Math.max(0, localMinutes(entry.entry_time) - startMin)
  }

  const loadEntries = useCallback(async () => {
    setEntriesLoading(true)
    try {
      const data = await fetchTimeEntries({
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        entry_type: typeFilter || undefined,
        limit: 2000,
      })
      setEntries(data)
    } catch (e) {
      console.error('Error loading time entries:', e)
    } finally {
      setEntriesLoading(false)
    }
  }, [dateFrom, dateTo, typeFilter])

  useEffect(() => {
    loadEntries()
  }, [loadEntries])

  // realtime: มีการบันทึกเวลาใหม่ → โหลดซ้ำ
  useEffect(() => {
    const channel = supabase
      .channel('hr_time_entries_live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'hr_time_entries' }, () => {
        loadEntries()
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [loadEntries])

  // โหลด signed URL รูปย่อของรายการที่ยังไม่มีในแคช (ครั้งละชุดเดียว)
  useEffect(() => {
    const missing = entries
      .map((e) => e.photo_url)
      .filter((p): p is string => !!p && !(p in photoThumbs))
    if (missing.length === 0) return
    let cancelled = false
    getTimeClockPhotoUrls([...new Set(missing)])
      .then((map) => {
        if (!cancelled) setPhotoThumbs((cur) => ({ ...cur, ...map }))
      })
      .catch((e) => console.error('Error loading photo thumbnails:', e))
    return () => {
      cancelled = true
    }
  }, [entries]) // eslint-disable-line react-hooks/exhaustive-deps

  const filteredEntries = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return entries
    return entries.filter((e) => {
      const emp = e.employee
      if (!emp) return false
      return (
        `${emp.first_name} ${emp.last_name}`.toLowerCase().includes(term) ||
        (emp.nickname ?? '').toLowerCase().includes(term) ||
        (emp.employee_code ?? '').toLowerCase().includes(term)
      )
    })
  }, [entries, search])

  /** จัดกลุ่มบันทึกเวลาเป็นรายวัน → รายคน สำหรับมุมมอง Dashboard */
  const dashboardGroups = useMemo(() => {
    const byDate = new Map<string, Map<string, DashRow>>()
    for (const e of filteredEntries) {
      if (!e.employee) continue
      const dateMap = byDate.get(e.work_date) ?? new Map<string, DashRow>()
      byDate.set(e.work_date, dateMap)
      const cur: DashRow = dateMap.get(e.employee_id) ?? { employee: e.employee }
      const t = new Date(e.entry_time).getTime()
      if (e.entry_type === 'clock_in') {
        if (!cur.clockIn || t < new Date(cur.clockIn.entry_time).getTime()) cur.clockIn = e
      } else if (e.entry_type === 'clock_out') {
        if (!cur.clockOut || t > new Date(cur.clockOut.entry_time).getTime()) cur.clockOut = e
      } else if (e.entry_type === 'ot_in') {
        if (!cur.otIn || t < new Date(cur.otIn.entry_time).getTime()) cur.otIn = e
      } else if (e.entry_type === 'ot_out') {
        if (!cur.otOut || t > new Date(cur.otOut.entry_time).getTime()) cur.otOut = e
      }
      dateMap.set(e.employee_id, cur)
    }
    return [...byDate.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, empMap]) => ({
        date,
        rows: [...empMap.values()].sort((a, b) =>
          empName(a.employee).localeCompare(empName(b.employee), 'th'),
        ),
      }))
  }, [filteredEntries])

  async function openPhoto(entry: HRTimeEntry) {
    if (!entry.photo_url) return
    const caption = `${empName(entry.employee)} — ${ENTRY_LABELS[entry.entry_type]} ${new Date(entry.entry_time).toLocaleString('th-TH')}`
    const cached = photoThumbs[entry.photo_url]
    if (cached) {
      setPhotoView({ url: cached, caption })
      return
    }
    setPhotoLoading(true)
    try {
      const url = await getTimeClockPhotoUrl(entry.photo_url)
      setPhotoView({ url, caption })
    } catch (e) {
      console.error('Error loading photo:', e)
    } finally {
      setPhotoLoading(false)
    }
  }

  // ─── สรุปรายเดือน ───

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true)
    try {
      const [y, m] = summaryMonth.split('-').map(Number)
      const monthStart = `${summaryMonth}-01`
      const lastDay = new Date(y, m, 0).getDate()
      const monthEnd = `${summaryMonth}-${String(lastDay).padStart(2, '0')}`

      const [monthEntries, employees, leaves, scheds] = await Promise.all([
        fetchTimeEntries({ date_from: monthStart, date_to: monthEnd, limit: 20000 }),
        fetchEmployees(),
        fetchLeaveRequests({ status: 'approved' }),
        fetchWorkSchedules(),
      ])

      const schedById = new Map(scheds.map((s) => [s.id, s]))
      const fallbackSched =
        scheds.find((s) => s.is_default && s.is_active) ?? scheds.find((s) => s.is_active) ?? FALLBACK_SCHEDULE

      // จำนวนวันทำการที่ผ่านมาแล้วในเดือน (นับถึงวันนี้ ถ้าเป็นเดือนปัจจุบัน) — cache ต่อชุดวันทำงาน
      const today = todayStr()
      const countUntil = monthEnd <= today ? lastDay : monthStart.slice(0, 7) === today.slice(0, 7) ? parseInt(today.slice(8, 10), 10) : 0
      const workdayCache = new Map<string, { elapsed: number; dates: Set<string> }>()
      const getWorkdayInfo = (workDaysStr: string) => {
        const key = workDaysStr || '1,2,3,4,5,6'
        const cached = workdayCache.get(key)
        if (cached) return cached
        const workDaySet = new Set(key.split(',').map((d) => parseInt(d, 10)))
        let elapsed = 0
        const dates = new Set<string>()
        for (let day = 1; day <= countUntil; day++) {
          const date = new Date(y, m - 1, day)
          const iso = ((date.getDay() + 6) % 7) + 1 // JS: 0=อาทิตย์ → ISO: 1=จันทร์
          if (workDaySet.has(iso)) {
            elapsed++
            dates.add(`${summaryMonth}-${String(day).padStart(2, '0')}`)
          }
        }
        const info = { elapsed, dates }
        workdayCache.set(key, info)
        return info
      }

      const activeEmployees = employees.filter((e) =>
        ['active', 'probation'].includes(e.employment_status),
      )

      const byEmp = new Map<string, HRTimeEntry[]>()
      monthEntries.forEach((e) => {
        const list = byEmp.get(e.employee_id) ?? []
        list.push(e)
        byEmp.set(e.employee_id, list)
      })

      const rows: SummaryRow[] = activeEmployees.map((emp) => {
        // มาตรฐานเวลาของพนักงานคนนี้ — ไม่ได้กำหนด/ถูกปิดใช้งาน → ใช้ชุดค่าเริ่มต้น
        const assigned = emp.work_schedule_id ? schedById.get(emp.work_schedule_id) : undefined
        const sched = assigned && (!('is_active' in assigned) || assigned.is_active) ? assigned : fallbackSched
        const workStartMin = parseTimeToMinutes(sched.work_start.slice(0, 5))
        const grace = sched.late_grace_min
        const { elapsed: workdaysElapsed, dates: workdayDates } = getWorkdayInfo(sched.work_days)

        const empEntries = (byEmp.get(emp.id) ?? []).sort((a, b) => a.entry_time.localeCompare(b.entry_time))

        // เข้างานครั้งแรกของแต่ละวัน
        const firstInByDate = new Map<string, HRTimeEntry>()
        empEntries.forEach((e) => {
          if (e.entry_type === 'clock_in' && !firstInByDate.has(e.work_date)) {
            firstInByDate.set(e.work_date, e)
          }
        })

        let lateCount = 0
        let lateMinutes = 0
        firstInByDate.forEach((e) => {
          const lateMin = localMinutes(e.entry_time) - (workStartMin + grace)
          if (lateMin > 0) {
            lateCount++
            lateMinutes += lateMin
          }
        })

        // ชม. OT จริง: จับคู่ ot_in → ot_out ต่อวัน
        let otHours = 0
        const otInByDate = new Map<string, HRTimeEntry>()
        empEntries.forEach((e) => {
          if (e.entry_type === 'ot_in' && !otInByDate.has(e.work_date)) otInByDate.set(e.work_date, e)
        })
        empEntries.forEach((e) => {
          if (e.entry_type === 'ot_out') {
            const otIn = otInByDate.get(e.work_date)
            if (otIn) {
              const hrs = (new Date(e.entry_time).getTime() - new Date(otIn.entry_time).getTime()) / 3600000
              if (hrs > 0) otHours += hrs
              otInByDate.delete(e.work_date)
            }
          }
        })

        // วันลา (อนุมัติ) เฉพาะวันทำการในเดือนนี้
        let leaveDays = 0
        const leaveDates = new Set<string>()
        leaves
          .filter((lr) => lr.employee_id === emp.id)
          .forEach((lr) => {
            const start = new Date(lr.start_date + 'T00:00:00')
            const end = new Date(lr.end_date + 'T00:00:00')
            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
              const pad = (n: number) => String(n).padStart(2, '0')
              const ds = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
              if (workdayDates.has(ds) && !leaveDates.has(ds)) {
                leaveDates.add(ds)
                leaveDays++
              }
            }
          })

        const presentDays = firstInByDate.size
        const absentDays = Math.max(0, workdaysElapsed - presentDays - leaveDays)

        return {
          employee: emp,
          scheduleName: sched.name,
          presentDays,
          lateCount,
          lateMinutes,
          otHours: Math.round(otHours * 100) / 100,
          leaveDays,
          absentDays,
        }
      })

      rows.sort((a, b) => (a.employee.employee_code ?? '').localeCompare(b.employee.employee_code ?? ''))
      setSummaryRows(rows)
    } catch (e) {
      console.error('Error loading summary:', e)
    } finally {
      setSummaryLoading(false)
    }
  }, [summaryMonth])

  useEffect(() => {
    if (activeTab === 'summary') loadSummary()
  }, [activeTab, loadSummary])

  const filteredSummary = useMemo(() => {
    const term = summarySearch.trim().toLowerCase()
    if (!term) return summaryRows
    return summaryRows.filter((r) =>
      `${r.employee.first_name} ${r.employee.last_name}`.toLowerCase().includes(term) ||
      (r.employee.nickname ?? '').toLowerCase().includes(term) ||
      (r.employee.employee_code ?? '').toLowerCase().includes(term),
    )
  }, [summaryRows, summarySearch])

  const exportEntries = () => {
    const rows = filteredEntries.map((e) => {
      const lm = entryLateMinutes(e)
      return {
        'รหัส': e.employee?.employee_code ?? '',
        'พนักงาน': empName(e.employee),
        'แผนก': (e.employee as HREmployee & { department?: { name?: string } })?.department?.name ?? '-',
        'ประเภท': ENTRY_LABELS[e.entry_type],
        'วันที่': new Date(e.work_date + 'T00:00:00').toLocaleDateString('th-TH'),
        'เวลา': new Date(e.entry_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        'สาย': e.entry_type === 'clock_in' ? (lm > 0 ? minutesToHHMM(lm) : 'ตรงเวลา') : '-',
        'จุดบันทึก': e.location_name ?? '-',
        'ระยะ (ม.)': e.distance_m != null ? Math.round(e.distance_m) : '',
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'บันทึกเวลา')
    XLSX.writeFile(wb, `บันทึกเวลา_${dateFrom}_ถึง_${dateTo}.xlsx`)
  }

  const exportSummary = () => {
    const rows = filteredSummary.map((r) => ({
      'รหัส': r.employee.employee_code ?? '',
      'พนักงาน': empName(r.employee),
      'มาตรฐานเวลา': r.scheduleName,
      'มาทำงาน (วัน)': r.presentDays,
      'สาย (ครั้ง)': r.lateCount,
      'สายรวม': r.lateMinutes > 0 ? minutesToHHMM(r.lateMinutes) : '-',
      'ลา (วัน)': r.leaveDays,
      'ขาด (วัน)': r.absentDays,
      'OT จริง': r.otHours > 0 ? hoursToHHMM(r.otHours) : '-',
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'สรุปรายเดือน')
    XLSX.writeFile(wb, `สรุปเวลาทำงาน_${summaryMonth}.xlsx`)
  }

  const inputClass =
    'px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-bold text-gray-800">เวลาทำงาน</h1>
        {defaultSchedule && (
          <span className="text-sm text-gray-500">
            ค่าเริ่มต้น: {defaultSchedule.name} {defaultSchedule.work_start.slice(0, 5)}–{defaultSchedule.work_end.slice(0, 5)} น.
            {schedules.filter((s) => s.is_active).length > 1 &&
              ` (+ อีก ${schedules.filter((s) => s.is_active).length - 1} ชุด)`}
          </span>
        )}
      </div>

      {/* แท็บย่อย */}
      <div className="flex gap-1 border-b border-gray-200">
        {([
          ['entries', 'บันทึกเวลา (สด)'],
          ['summary', 'สรุปรายเดือน'],
        ] as [TabKey, string][]).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            className={`px-4 py-2.5 font-semibold text-sm rounded-t-xl border-b-2 transition-colors ${
              activeTab === key
                ? 'border-emerald-600 text-emerald-700'
                : 'border-transparent text-gray-500 hover:text-emerald-600'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ─── แท็บบันทึกเวลาสด ─── */}
      {activeTab === 'entries' && (
        <div className="bg-white rounded-xl shadow p-4 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="relative">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="ค้นหาชื่อ / รหัสพนักงาน"
                className={`${inputClass} pl-9 w-56`}
              />
            </div>
            <div className="text-sm">
              <span className="block text-gray-500 mb-1">&nbsp;</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDateFrom(todayStr())
                    setDateTo(todayStr())
                  }}
                  className="px-3 py-2 border border-emerald-300 text-emerald-700 bg-emerald-50 text-sm font-medium rounded-lg hover:bg-emerald-100"
                >
                  วันนี้
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDateFrom(monthStr() + '-01')
                    setDateTo(todayStr())
                  }}
                  className="px-3 py-2 border border-emerald-300 text-emerald-700 bg-emerald-50 text-sm font-medium rounded-lg hover:bg-emerald-100"
                >
                  เดือนนี้
                </button>
              </div>
            </div>
            <label className="text-sm">
              <span className="block text-gray-500 mb-1">จากวันที่</span>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputClass} />
            </label>
            <label className="text-sm">
              <span className="block text-gray-500 mb-1">ถึงวันที่</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputClass} />
            </label>
            <label className="text-sm">
              <span className="block text-gray-500 mb-1">ประเภท</span>
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={inputClass}>
                <option value="">ทั้งหมด</option>
                <option value="clock_in">เข้างาน</option>
                <option value="clock_out">ออกงาน</option>
                <option value="ot_in">เข้า OT</option>
                <option value="ot_out">ออก OT</option>
              </select>
            </label>
            <button
              type="button"
              onClick={loadEntries}
              className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700"
            >
              <FiRefreshCw className={entriesLoading ? 'animate-spin' : ''} /> รีเฟรช
            </button>
            <button
              type="button"
              onClick={exportEntries}
              disabled={filteredEntries.length === 0}
              className="flex items-center gap-1.5 px-3 py-2 border border-emerald-600 text-emerald-700 text-sm font-medium rounded-lg hover:bg-emerald-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <FiDownload /> Export Excel
            </button>
            <div className="ml-auto flex items-center gap-3">
              <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setEntriesView('table')}
                  className={`px-3 py-2 text-sm font-medium transition-colors ${
                    entriesView === 'table' ? 'bg-emerald-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  ตาราง
                </button>
                <button
                  type="button"
                  onClick={() => setEntriesView('dashboard')}
                  className={`px-3 py-2 text-sm font-medium transition-colors border-l border-gray-200 ${
                    entriesView === 'dashboard' ? 'bg-emerald-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <i className="fas fa-table-cells-large mr-1.5" />Dashboard
                </button>
              </div>
              <span className="text-sm text-gray-400">{filteredEntries.length} รายการ (อัปเดตสดอัตโนมัติ)</span>
            </div>
          </div>

          {entriesLoading ? (
            <Loading />
          ) : filteredEntries.length === 0 ? (
            <div className="text-center py-12 text-gray-400">ไม่มีบันทึกเวลาในช่วงที่เลือก</div>
          ) : entriesView === 'dashboard' ? (
            <AttendanceDashboard groups={dashboardGroups} lateOf={entryLateMinutes} today={todayStr()} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-emerald-600 text-white">
                    <th className="p-3 text-left font-semibold rounded-tl-xl">พนักงาน</th>
                    <th className="p-3 text-left font-semibold">แผนก</th>
                    <th className="p-3 text-center font-semibold">ประเภท</th>
                    <th className="p-3 text-center font-semibold">วันที่</th>
                    <th className="p-3 text-center font-semibold">เวลา</th>
                    <th className="p-3 text-center font-semibold">สาย</th>
                    <th className="p-3 text-left font-semibold">จุดบันทึก</th>
                    <th className="p-3 text-center font-semibold">ระยะ (ม.)</th>
                    <th className="p-3 text-center font-semibold rounded-tr-xl">รูป</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.map((e, idx) => (
                    <tr key={e.id} className={`border-t border-surface-200 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                      <td className="p-3">
                        <div className="font-medium text-gray-800">{empName(e.employee)}</div>
                        <div className="text-xs text-gray-400">{e.employee?.employee_code}</div>
                      </td>
                      <td className="p-3 text-gray-600">{(e.employee as HREmployee & { department?: { name?: string } })?.department?.name ?? '-'}</td>
                      <td className="p-3 text-center">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${ENTRY_BADGE[e.entry_type]}`}>
                          {ENTRY_LABELS[e.entry_type]}
                        </span>
                      </td>
                      <td className="p-3 text-center text-gray-600">
                        {new Date(e.work_date + 'T00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })}
                      </td>
                      <td className="p-3 text-center font-semibold text-gray-800 tabular-nums">
                        {new Date(e.entry_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </td>
                      <td className="p-3 text-center tabular-nums">
                        {e.entry_type === 'clock_in'
                          ? entryLateMinutes(e) > 0
                            ? <span className="text-red-600 font-semibold">{minutesToHHMM(entryLateMinutes(e))}</span>
                            : <span className="text-emerald-600 text-xs">ตรงเวลา</span>
                          : <span className="text-gray-300">-</span>}
                      </td>
                      <td className="p-3 text-gray-600">
                        <span className="flex items-center gap-1">
                          <FiMapPin className="text-emerald-500 flex-shrink-0" /> {e.location_name ?? '-'}
                        </span>
                      </td>
                      <td className="p-3 text-center text-gray-600">{e.distance_m != null ? Math.round(e.distance_m) : '-'}</td>
                      <td className="p-3 text-center">
                        {e.photo_url ? (
                          photoThumbs[e.photo_url] ? (
                            <button
                              type="button"
                              onClick={() => openPhoto(e)}
                              className="inline-block rounded-lg overflow-hidden ring-1 ring-gray-200 hover:ring-emerald-400 transition"
                              title="คลิกเพื่อดูรูปขนาดใหญ่"
                            >
                              <img
                                src={photoThumbs[e.photo_url]}
                                alt="รูปบันทึกเวลา"
                                loading="lazy"
                                className="w-12 h-12 object-cover"
                              />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openPhoto(e)}
                              disabled={photoLoading}
                              className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50"
                              title="ดูรูปถ่าย"
                            >
                              <FiCamera />
                            </button>
                          )
                        ) : (
                          <span className="text-gray-300">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ─── แท็บสรุปรายเดือน ─── */}
      {activeTab === 'summary' && (
        <div className="bg-white rounded-xl shadow p-4 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="block text-gray-500 mb-1">เดือน</span>
              <input type="month" value={summaryMonth} onChange={(e) => setSummaryMonth(e.target.value)} className={inputClass} />
            </label>
            <div className="relative">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={summarySearch}
                onChange={(e) => setSummarySearch(e.target.value)}
                placeholder="ค้นหาชื่อ / รหัสพนักงาน"
                className={`${inputClass} pl-9 w-56`}
              />
            </div>
            <button
              type="button"
              onClick={loadSummary}
              className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700"
            >
              <FiRefreshCw className={summaryLoading ? 'animate-spin' : ''} /> คำนวณใหม่
            </button>
            <button
              type="button"
              onClick={exportSummary}
              disabled={filteredSummary.length === 0}
              className="flex items-center gap-1.5 px-3 py-2 border border-emerald-600 text-emerald-700 text-sm font-medium rounded-lg hover:bg-emerald-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <FiDownload /> Export Excel
            </button>
            <span className="text-xs text-gray-400 ml-auto">
              ขาดงาน = วันทำการที่ผ่านมา − วันที่มา − วันลา(อนุมัติ) • สาย/วันทำการ คิดตามมาตรฐานเวลาของแต่ละคน
            </span>
          </div>

          {summaryLoading ? (
            <Loading />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-emerald-600 text-white">
                    <th className="p-3 text-left font-semibold rounded-tl-xl">พนักงาน</th>
                    <th className="p-3 text-left font-semibold">มาตรฐานเวลา</th>
                    <th className="p-3 text-center font-semibold">มาทำงาน (วัน)</th>
                    <th className="p-3 text-center font-semibold">สาย (ครั้ง)</th>
                    <th className="p-3 text-center font-semibold">สายรวม</th>
                    <th className="p-3 text-center font-semibold">ลา (วัน)</th>
                    <th className="p-3 text-center font-semibold">ขาด (วัน)</th>
                    <th className="p-3 text-center font-semibold rounded-tr-xl">OT จริง</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSummary.map((r, idx) => (
                    <tr key={r.employee.id} className={`border-t border-surface-200 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                      <td className="p-3">
                        <div className="font-medium text-gray-800">{empName(r.employee)}</div>
                        <div className="text-xs text-gray-400">{r.employee.employee_code}</div>
                      </td>
                      <td className="p-3 text-sm text-gray-600">{r.scheduleName}</td>
                      <td className="p-3 text-center">{r.presentDays}</td>
                      <td className={`p-3 text-center ${r.lateCount > 0 ? 'text-amber-600 font-semibold' : ''}`}>{r.lateCount}</td>
                      <td className={`p-3 text-center tabular-nums ${r.lateMinutes > 0 ? 'text-amber-600' : ''}`}>{r.lateMinutes > 0 ? minutesToHHMM(r.lateMinutes) : '-'}</td>
                      <td className="p-3 text-center">{r.leaveDays}</td>
                      <td className={`p-3 text-center ${r.absentDays > 0 ? 'text-red-600 font-semibold' : ''}`}>{r.absentDays}</td>
                      <td className={`p-3 text-center tabular-nums ${r.otHours > 0 ? 'text-indigo-600 font-semibold' : ''}`}>{r.otHours > 0 ? hoursToHHMM(r.otHours) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredSummary.length === 0 && (
                <div className="text-center py-12 text-gray-400">ไม่พบพนักงาน</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Modal ดูรูป — ใช้ Modal กลางที่เว้นระยะใต้ header/แถบเมนูให้อัตโนมัติ */}
      <Modal
        open={!!photoView}
        onClose={() => setPhotoView(null)}
        closeOnBackdropClick
        contentClassName="max-w-lg !overflow-hidden"
      >
        {photoView && (
          <>
            <div className="flex items-center justify-between px-4 py-3 bg-emerald-600 text-white flex-shrink-0">
              <span className="text-sm font-medium truncate pr-2">{photoView.caption}</span>
              <button type="button" onClick={() => setPhotoView(null)} aria-label="ปิด">
                <FiX className="w-5 h-5" />
              </button>
            </div>
            <img
              src={photoView.url}
              alt="รูปถ่ายบันทึกเวลา"
              className="w-full flex-1 min-h-0 object-contain bg-black"
            />
          </>
        )}
      </Modal>
    </div>
  )
}

type DashFilter = 'all' | 'problem' | 'late' | 'missing'

/** มุมมอง Dashboard: การ์ดรายคน/รายวัน — เห็นเวลาเข้า-ออก, สาย, การลืมบันทึก และ OT รวมได้ทันที */
function AttendanceDashboard({
  groups,
  lateOf,
  today,
}: {
  groups: { date: string; rows: DashRow[] }[]
  lateOf: (e: HRTimeEntry) => number
  today: string
}) {
  const [filter, setFilter] = useState<DashFilter>('all')

  // เตรียมข้อมูลต่อวัน: คำนวณสถานะ/สาย/OT ล่วงหน้า, เรียงปัญหาขึ้นบน, และสรุปยอด
  const prepared = groups.map(({ date, rows }) => {
    const isPast = date < today
    const items = rows
      .map((r) => {
        const lateMin = r.clockIn ? lateOf(r.clockIn) : 0
        const otMin = otMinutesOf(r)
        return { r, lateMin, otMin, status: dashStatusOf(r, lateMin, isPast) }
      })
      .sort((a, b) => b.status.sev - a.status.sev || empName(a.r.employee).localeCompare(empName(b.r.employee), 'th'))

    const counts = { normal: 0, late: 0, missing_out: 0, working: 0, missing_in: 0 } as Record<DashStatusKey, number>
    let otTotalMin = 0
    for (const it of items) {
      counts[it.status.key]++
      otTotalMin += it.otMin
    }
    const problemCount = counts.missing_in + counts.missing_out
    return { date, isPast, items, counts, otTotalMin, problemCount }
  })

  const matchesFilter = (key: DashStatusKey): boolean => {
    if (filter === 'all') return true
    if (filter === 'late') return key === 'late'
    if (filter === 'missing') return key === 'missing_in' || key === 'missing_out'
    return key === 'late' || key === 'missing_in' || key === 'missing_out' // problem
  }

  const filterTabs: { key: DashFilter; label: string }[] = [
    { key: 'all', label: 'ทั้งหมด' },
    { key: 'problem', label: 'เฉพาะมีปัญหา' },
    { key: 'late', label: 'สาย' },
    { key: 'missing', label: 'ลืมบันทึก' },
  ]

  const chip = (n: number, label: string, cls: string) =>
    n > 0 ? (
      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
        {label} {n}
      </span>
    ) : null

  return (
    <div className="space-y-5">
      {/* ตัวกรอง */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-500">แสดง:</span>
        {filterTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setFilter(t.key)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
              filter === t.key
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {prepared.map(({ date, items, counts, otTotalMin }) => {
        const visible = items.filter((it) => matchesFilter(it.status.key))
        if (visible.length === 0) return null
        return (
          <div key={date}>
            <div className="flex flex-wrap items-center gap-2 mb-2.5">
              <h3 className="font-bold text-gray-700">
                {new Date(date + 'T00:00:00').toLocaleDateString('th-TH', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </h3>
              <span className="text-xs text-gray-400">({items.length} คน)</span>
              <div className="flex flex-wrap items-center gap-1.5 ml-1">
                {chip(counts.normal, 'ปกติ', 'bg-emerald-100 text-emerald-700')}
                {chip(counts.late, 'สาย', 'bg-amber-100 text-amber-800')}
                {chip(counts.working, 'ทำงานอยู่', 'bg-sky-100 text-sky-700')}
                {chip(counts.missing_out, 'ลืมออก', 'bg-rose-100 text-rose-700')}
                {chip(counts.missing_in, 'ลืมเข้า', 'bg-rose-100 text-rose-700')}
                {otTotalMin > 0 && (
                  <span className="rounded-full px-2 py-0.5 text-xs font-semibold bg-indigo-100 text-indigo-700">
                    OT รวม {minutesToHHMM(otTotalMin)}
                  </span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
              {visible.map(({ r, lateMin, otMin, status }) => {
                const isPast = date < today
                const dept = (r.employee as HREmployee & { department?: { name?: string } }).department?.name
                return (
                  <div key={r.employee.id} className={`rounded-xl border ${status.tint} bg-white p-3 shadow-sm`}>
                    <div className="flex items-start justify-between gap-2 mb-2.5">
                      <div className="min-w-0">
                        <div className="font-semibold text-gray-800 truncate">{empName(r.employee)}</div>
                        <div className="text-xs text-gray-400 truncate">
                          {r.employee.employee_code}
                          {dept ? ` · ${dept}` : ''}
                        </div>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${status.cls}`}>
                        {status.label}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-lg bg-emerald-50/70 px-2.5 py-2">
                        <div className="text-[11px] text-gray-500 mb-0.5">เข้างาน</div>
                        {r.clockIn ? (
                          <>
                            <div className="font-bold text-gray-800 tabular-nums">{fmtClock(r.clockIn.entry_time)}</div>
                            {lateMin > 0 ? (
                              <div className="text-[11px] font-medium text-red-600">สาย {minutesToHHMM(lateMin)}</div>
                            ) : (
                              <div className="text-[11px] text-emerald-600">ตรงเวลา</div>
                            )}
                          </>
                        ) : (
                          <div className="font-bold text-rose-500">ไม่มีบันทึก</div>
                        )}
                      </div>
                      <div className="rounded-lg bg-rose-50/50 px-2.5 py-2">
                        <div className="text-[11px] text-gray-500 mb-0.5">ออกงาน</div>
                        {r.clockOut ? (
                          <div className="font-bold text-gray-800 tabular-nums">{fmtClock(r.clockOut.entry_time)}</div>
                        ) : isPast ? (
                          <div className="font-bold text-rose-500">ไม่มีบันทึก</div>
                        ) : (
                          <div className="text-sm text-gray-400">ยังไม่ออก</div>
                        )}
                      </div>
                    </div>
                    {(r.otIn || r.otOut) && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="rounded-full bg-indigo-100 text-indigo-700 px-2 py-0.5 font-semibold">OT</span>
                        <span className="tabular-nums text-gray-600">
                          {r.otIn ? fmtClock(r.otIn.entry_time) : '—'} – {r.otOut ? fmtClock(r.otOut.entry_time) : '—'}
                        </span>
                        {otMin > 0 && (
                          <span className="font-semibold text-indigo-700">รวม {minutesToHHMM(otMin)}</span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
