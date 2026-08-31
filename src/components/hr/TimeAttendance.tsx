import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { FiRefreshCw, FiMapPin, FiCamera, FiSearch, FiDownload, FiUpload } from 'react-icons/fi'
import * as XLSX from 'xlsx'
import * as ExcelJS from 'exceljs'
import { supabase } from '../../lib/supabase'
import Modal from '../ui/Modal'
import TimeEntryImport from './TimeEntryImport'
import {
  fetchTimeEntries,
  fetchEmployees,
  fetchDepartments,
  fetchWorkSchedules,
  fetchLeaveRequests,
  fetchWFHRequests,
  fetchWorkCalendar,
  fetchCompanyHolidays,
  resolveEmployeeDayType,
  getTimeClockPhotoUrl,
  getTimeClockPhotoUrls,
  fetchTimeCertifications,
  upsertTimeCertification,
  fetchEmployeeByUserId,
  requestTimeClockPhotoCleanup,
} from '../../lib/hrApi'
import { useAuthContext } from '../../contexts/AuthContext'
import type { HRTimeEntry, HREmployee, HRDepartment, HRWorkSchedule, HRTimeEntryType, HRTimeCertification, HRLeaveRequest, HRWFHRequest, HREmployeeWorkCalendar } from '../../types'

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

/** ป้ายบอกแหล่งที่มาของบันทึก (ค่าเดิมที่ไม่มี source = มือถือ) */
const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  mobile: { label: '📱 มือถือ', cls: 'bg-sky-50 text-sky-600' },
  device: { label: '🔒 สแกนนิ้ว', cls: 'bg-amber-50 text-amber-700' },
  manual: { label: '✍️ กรอกเอง', cls: 'bg-gray-100 text-gray-500' },
}
const sourceBadge = (s?: string) => SOURCE_BADGE[s ?? 'mobile'] ?? SOURCE_BADGE.mobile

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

function dateRange(from: string, to: string): string[] {
  if (!from || !to || from > to) return []
  const dates: string[] = []
  const current = new Date(`${from}T12:00:00`)
  const end = new Date(`${to}T12:00:00`)
  while (current <= end) {
    const pad = (value: number) => String(value).padStart(2, '0')
    dates.push(`${current.getFullYear()}-${pad(current.getMonth() + 1)}-${pad(current.getDate())}`)
    current.setDate(current.getDate() + 1)
  }
  return dates
}

function leaveDescription(leaves: HRLeaveRequest[]): string {
  return leaves.map((leave) => {
    const name = leave.leave_type?.name || 'ลา'
    if (leave.leave_mode === 'hourly') {
      const start = leave.start_time?.slice(0, 5) || '-'
      const end = leave.end_time?.slice(0, 5) || '-'
      return `${name} ${start}–${end}`
    }
    return `${name} เต็มวัน`
  }).join('; ')
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

/** ระยะเวลาเป็นนาที → hh:mm ชม. เช่น 44 → 00:44 ชม., 644 → 10:44 ชม. */
function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ชม.`
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

type DashStatusKey = 'normal' | 'certified' | 'late' | 'missing_out' | 'working' | 'missing_in'
/**
 * สถานะการบันทึกของพนักงาน 1 คนในวันนั้น — sev สูง = ต้องรีบจัดการ (เรียงขึ้นบน)
 * ช่องที่หัวหน้ารับรองแล้วนับเหมือนมีบันทึก จึงไม่ค้างเป็น "ลืมบันทึก"
 */
function dashStatusOf(
  r: DashRow,
  lateMin: number,
  isPast: boolean,
  certified?: { in?: boolean; out?: boolean },
): {
  key: DashStatusKey
  label: string
  cls: string
  tint: string
  sev: number
} {
  const hasIn = !!r.clockIn || !!certified?.in
  const hasOut = !!r.clockOut || !!certified?.out
  if ((certified?.in || certified?.out) && hasIn && (hasOut || !isPast)) {
    return { key: 'certified', label: 'หัวหน้ารับรอง', cls: 'bg-sky-100 text-sky-700', tint: 'border-sky-200', sev: 1 }
  }
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

  // ─── ใบรับรองเวลาของหัวหน้า (ใช้แทนบันทึกที่หายไป) ───
  const { user } = useAuthContext()
  const [myEmployeeId, setMyEmployeeId] = useState('')
  const [certifications, setCertifications] = useState<HRTimeCertification[]>([])
  const [certForm, setCertForm] = useState<{
    employee: HREmployee
    workDate: string
    entryType: 'clock_in' | 'clock_out'
    time: string
    reason: string
  } | null>(null)
  const [certSaving, setCertSaving] = useState(false)
  const [certError, setCertError] = useState('')

  // ─── แท็บบันทึกเวลาสด ───
  const [entries, setEntries] = useState<HRTimeEntry[]>([])
  const [approvedLeaves, setApprovedLeaves] = useState<HRLeaveRequest[]>([])
  const [approvedWFH, setApprovedWFH] = useState<HRWFHRequest[]>([])
  const [entriesLoading, setEntriesLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [departments, setDepartments] = useState<HRDepartment[]>([])
  const [departmentFilter, setDepartmentFilter] = useState('')
  const [dateFrom, setDateFrom] = useState(todayStr().slice(0, 7) + '-01')
  const [dateTo, setDateTo] = useState(todayStr())
  const [typeFilter, setTypeFilter] = useState('')
  /** มุมมองแท็บบันทึกเวลาสด: ตารางดิบ หรือ Dashboard รายคน/รายวัน */
  const [entriesView, setEntriesView] = useState<'table' | 'dashboard'>('table')
  const [photoView, setPhotoView] = useState<{ url: string; caption: string } | null>(null)
  const [photoLoading, setPhotoLoading] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [exportingEntries, setExportingEntries] = useState(false)
  const realtimeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const realtimeNeedsRelatedRef = useRef(false)
  /** signed URL รูปย่อในตาราง (path → url) */
  const [photoThumbs, setPhotoThumbs] = useState<Record<string, string>>({})

  // ─── แท็บสรุป ───
  const [summaryMonth, setSummaryMonth] = useState(monthStr())
  const [summaryRows, setSummaryRows] = useState<SummaryRow[]>([])
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summarySearch, setSummarySearch] = useState('')

  useEffect(() => {
    fetchWorkSchedules().then(setSchedules).catch(() => {})
    fetchDepartments().then(setDepartments).catch(() => {})
  }, [])

  useEffect(() => {
    if (user?.id) fetchEmployeeByUserId(user.id).then((e) => setMyEmployeeId(e?.id ?? '')).catch(() => {})
  }, [user?.id])

  /** ใบรับรองของพนักงานคนนี้ในวันนี้ (ถ้ามี) */
  const certOf = useCallback(
    (employeeId: string, workDate: string, entryType: 'clock_in' | 'clock_out') =>
      certifications.find(
        (c) => c.employee_id === employeeId && c.work_date === workDate && c.entry_type === entryType,
      ),
    [certifications],
  )

  const saveCertification = async () => {
    if (!certForm) return
    if (!certForm.time || !certForm.reason.trim()) {
      setCertError('ต้องกรอกทั้งเวลาและเหตุผล')
      return
    }
    setCertSaving(true)
    setCertError('')
    try {
      await upsertTimeCertification({
        employee_id: certForm.employee.id,
        work_date: certForm.workDate,
        entry_type: certForm.entryType,
        // เวลาในฟอร์มเป็นเวลาท้องถิ่นของวันที่นั้น
        certified_time: new Date(`${certForm.workDate}T${certForm.time}:00`).toISOString(),
        reason: certForm.reason.trim(),
        certified_by: myEmployeeId || undefined,
      })
      setCertForm(null)
      await loadEntries()
    } catch (e) {
      setCertError(e instanceof Error ? e.message : 'บันทึกการรับรองไม่สำเร็จ')
    } finally {
      setCertSaving(false)
    }
  }

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
    const actualMin = localMinutes(entry.entry_time)
    const wfh = approvedWFH.find((r) =>
      r.employee_id === entry.employee_id && r.start_date <= entry.work_date && r.end_date >= entry.work_date,
    )
    let expectedMin = wfh?.start_time
      ? parseTimeToMinutes(wfh.start_time.slice(0, 5))
      : parseTimeToMinutes(sched.work_start.slice(0, 5))

    const dayLeaves = approvedLeaves.filter((r) =>
      r.employee_id === entry.employee_id && r.start_date <= entry.work_date && r.end_date >= entry.work_date,
    )
    // ลาเต็มวัน หรือบันทึกเข้าในช่วงลาที่อนุมัติแล้ว: ไม่แสดงว่าสาย
    if (dayLeaves.some((r) => r.leave_mode !== 'hourly')) return 0
    const ranges = dayLeaves
      .filter((r) => r.leave_mode === 'hourly' && r.start_time && r.end_time)
      .map((r) => [parseTimeToMinutes(r.start_time!.slice(0, 5)), parseTimeToMinutes(r.end_time!.slice(0, 5))] as const)
      .sort((a, b) => a[0] - b[0])
    if (ranges.some(([start, end]) => actualMin >= start && actualMin <= end)) return 0
    // ถ้าลาต่อเนื่องจากเวลาเริ่มงาน ให้เลื่อนเวลาเริ่มที่คาดหวังไปหลังสิ้นสุดการลา
    for (const [start, end] of ranges) {
      if (start <= expectedMin && end > expectedMin) expectedMin = end
    }

    return Math.max(0, actualMin - (expectedMin + (sched.late_grace_min ?? 0)))
  }

  /** นาทีที่ออกก่อนเวลาเลิกงาน ของบันทึกออกงาน (clock_out) ตามมาตรฐานเวลาของพนักงาน */
  const entryEarlyLeaveMinutes = (entry: HRTimeEntry): number => {
    if (entry.entry_type !== 'clock_out') return 0
    const empSchedId = (entry.employee as (HREmployee & { work_schedule_id?: string }))?.work_schedule_id
    const assigned = empSchedId ? schedules.find((s) => s.id === empSchedId && s.is_active) : undefined
    const sched = assigned ?? defaultSchedule ?? FALLBACK_SCHEDULE
    const endMin = parseTimeToMinutes(sched.work_end.slice(0, 5))
    return Math.max(0, endMin - localMinutes(entry.entry_time))
  }

  const loadEntries = useCallback(async (options: { silent?: boolean; includeRelated?: boolean } = {}) => {
    const { silent = false, includeRelated = true } = options
    if (!silent) setEntriesLoading(true)
    try {
      const dataPromise = fetchTimeEntries({
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        entry_type: typeFilter || undefined,
        limit: 2000,
      })

      if (!includeRelated) {
        setEntries(await dataPromise)
        return
      }

      const [data, leaves, wfh, certs] = await Promise.all([
        dataPromise,
        fetchLeaveRequests({ status: 'approved' }),
        fetchWFHRequests({ status: 'approved' }),
        dateFrom && dateTo ? fetchTimeCertifications(dateFrom, dateTo) : Promise.resolve([]),
      ])
      setEntries(data)
      setApprovedLeaves(leaves)
      setApprovedWFH(wfh)
      setCertifications(certs)
    } catch (e) {
      console.error('Error loading time entries:', e)
    } finally {
      if (!silent) setEntriesLoading(false)
    }
  }, [dateFrom, dateTo, typeFilter])

  useEffect(() => {
    void loadEntries()
  }, [loadEntries])

  // งานล้างรูปทำครั้งเดียวเมื่อเปิดหน้า และไม่บังคับให้ตารางโหลดซ้ำ
  useEffect(() => {
    requestTimeClockPhotoCleanup()
      .catch((error) => console.warn('Time-clock photo cleanup failed:', error))
  }, [])

  // realtime: รวมเหตุการณ์ที่เข้ามาติดกัน แล้วอัปเดตข้อมูลที่จำเป็นแบบเงียบ
  useEffect(() => {
    const scheduleRealtimeRefresh = (includeRelated = false) => {
      realtimeNeedsRelatedRef.current ||= includeRelated
      if (realtimeRefreshTimerRef.current) clearTimeout(realtimeRefreshTimerRef.current)
      realtimeRefreshTimerRef.current = setTimeout(() => {
        realtimeRefreshTimerRef.current = null
        const refreshRelated = realtimeNeedsRelatedRef.current
        realtimeNeedsRelatedRef.current = false
        void loadEntries({ silent: true, includeRelated: refreshRelated })
      }, 800)
    }

    const channel = supabase
      .channel('hr_time_entries_live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_time_entries' }, (payload) => {
        // INSERT นอกช่วง/ประเภทที่กำลังดูไม่กระทบตารางนี้ จึงไม่ต้องโหลดใหม่
        if (payload.eventType === 'INSERT') {
          const inserted = payload.new as Partial<HRTimeEntry>
          if (inserted.work_date && (
            (dateFrom && inserted.work_date < dateFrom)
            || (dateTo && inserted.work_date > dateTo)
            || (typeFilter && inserted.entry_type !== typeFilter)
          )) return
        }
        scheduleRealtimeRefresh()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_leave_requests' }, () => scheduleRealtimeRefresh(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_wfh_requests' }, () => scheduleRealtimeRefresh(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_time_certifications' }, () => scheduleRealtimeRefresh(true))
      .subscribe()
    return () => {
      if (realtimeRefreshTimerRef.current) {
        clearTimeout(realtimeRefreshTimerRef.current)
        realtimeRefreshTimerRef.current = null
      }
      realtimeNeedsRelatedRef.current = false
      supabase.removeChannel(channel)
    }
  }, [dateFrom, dateTo, loadEntries, typeFilter])

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
    return entries.filter((e) => {
      const emp = e.employee
      if (!emp) return false
      if (departmentFilter && emp.department_id !== departmentFilter && emp.department?.id !== departmentFilter) return false
      if (!term) return true
      return (
        `${emp.first_name} ${emp.last_name}`.toLowerCase().includes(term) ||
        (emp.nickname ?? '').toLowerCase().includes(term) ||
        (emp.employee_code ?? '').toLowerCase().includes(term)
      )
    })
  }, [entries, search, departmentFilter])

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

      const [monthEntries, employees, leaves, scheds, calendarDays, companyHolidays] = await Promise.all([
        fetchTimeEntries({ date_from: monthStart, date_to: monthEnd, limit: 20000 }),
        fetchEmployees(),
        fetchLeaveRequests({ status: 'approved' }),
        fetchWorkSchedules(),
        fetchWorkCalendar(monthStart, monthEnd),
        fetchCompanyHolidays(monthStart, monthEnd),
      ])

      const schedById = new Map(scheds.map((s) => [s.id, s]))
      const fallbackSched =
        scheds.find((s) => s.is_default && s.is_active) ?? scheds.find((s) => s.is_active) ?? FALLBACK_SCHEDULE

      // จำนวนวันทำการที่ผ่านมาแล้วในเดือน (นับถึงวันนี้ ถ้าเป็นเดือนปัจจุบัน) — cache ต่อชุดวันทำงาน
      const today = todayStr()
      const countUntil = monthEnd <= today ? lastDay : monthStart.slice(0, 7) === today.slice(0, 7) ? parseInt(today.slice(8, 10), 10) : 0
      const countUntilDate = countUntil > 0 ? `${summaryMonth}-${String(countUntil).padStart(2, '0')}` : ''
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
      const calendarByEmployee = new Map<string, Map<string, (typeof calendarDays)[number]>>()
      calendarDays.forEach((day) => {
        const byDate = calendarByEmployee.get(day.employee_id) ?? new Map()
        byDate.set(day.work_date, day)
        calendarByEmployee.set(day.employee_id, byDate)
      })
      const companyHolidayDates = new Set(companyHolidays.map((h) => h.holiday_date))

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
        const baseWorkdays = getWorkdayInfo(sched.work_days)
        const workdayDates = new Set(baseWorkdays.dates)
        companyHolidayDates.forEach((date) => { if (countUntilDate && date <= countUntilDate) workdayDates.delete(date) })
        calendarByEmployee.get(emp.id)?.forEach((override, date) => {
          if (!countUntilDate || date > countUntilDate) return
          if (override.day_type === 'work') workdayDates.add(date)
          else workdayDates.delete(date)
        })
        const workdaysElapsed = workdayDates.size

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

  const exportEntries = async () => {
    if (!dateFrom || !dateTo || dateFrom > dateTo) return
    setExportingEntries(true)
    try {
      const [allEmployees, allSchedules, calendarDays, companyHolidays] = await Promise.all([
        fetchEmployees(),
        fetchWorkSchedules(true),
        fetchWorkCalendar(dateFrom, dateTo),
        fetchCompanyHolidays(dateFrom, dateTo),
      ])
      const today = todayStr()
      const dates = dateRange(dateFrom, dateTo)
      const deptName = (employee: HREmployee) => employee.department?.name ?? '-'
      const entryEmployeeIds = new Set(filteredEntries.map((entry) => entry.employee_id))
      const searchTerm = search.trim().toLowerCase()
      const reportEmployees = allEmployees
        .filter((employee) => ['active', 'probation'].includes(employee.employment_status) || entryEmployeeIds.has(employee.id))
        .filter((employee) => !departmentFilter || employee.department_id === departmentFilter)
        .filter((employee) => !searchTerm || `${employee.employee_code} ${employee.first_name} ${employee.last_name} ${employee.nickname ?? ''}`.toLowerCase().includes(searchTerm))
        .sort((a, b) => (a.employee_code || '').localeCompare(b.employee_code || '', 'en', { numeric: true, sensitivity: 'base' }))

      const scheduleById = new Map(allSchedules.map((schedule) => [schedule.id, schedule]))
      const fallbackSchedule = allSchedules.find((schedule) => schedule.is_default && schedule.is_active)
        ?? allSchedules.find((schedule) => schedule.is_active)
        ?? FALLBACK_SCHEDULE
      const calendarByKey = new Map(calendarDays.map((day) => [`${day.employee_id}|${day.work_date}`, day]))
      const holidayByDate = new Map(companyHolidays.map((holiday) => [holiday.holiday_date, holiday]))
      const entriesByKey = new Map<string, DashRow>()
      filteredEntries.forEach((entry) => {
        const employee = reportEmployees.find((row) => row.id === entry.employee_id) ?? entry.employee
        if (!employee) return
        const key = `${entry.employee_id}|${entry.work_date}`
        const row = entriesByKey.get(key) ?? { employee }
        const time = new Date(entry.entry_time).getTime()
        if (entry.entry_type === 'clock_in' && (!row.clockIn || time < new Date(row.clockIn.entry_time).getTime())) row.clockIn = entry
        if (entry.entry_type === 'clock_out' && (!row.clockOut || time > new Date(row.clockOut.entry_time).getTime())) row.clockOut = entry
        if (entry.entry_type === 'ot_in' && (!row.otIn || time < new Date(row.otIn.entry_time).getTime())) row.otIn = entry
        if (entry.entry_type === 'ot_out' && (!row.otOut || time > new Date(row.otOut.entry_time).getTime())) row.otOut = entry
        entriesByKey.set(key, row)
      })

      const dayLeaves = (employeeId: string, date: string) => approvedLeaves.filter((leave) =>
        leave.employee_id === employeeId && leave.start_date <= date && leave.end_date >= date,
      )
      const lateMinutesFor = (
        entry: HRTimeEntry,
        employee: HREmployee,
        schedule: HRWorkSchedule | typeof FALLBACK_SCHEDULE,
        override?: HREmployeeWorkCalendar,
      ) => {
        const overrideSchedule = override?.work_schedule_id ? scheduleById.get(override.work_schedule_id) : undefined
        const effectiveSchedule = overrideSchedule ?? schedule
        const wfh = approvedWFH.find((request) =>
          request.employee_id === employee.id && request.start_date <= entry.work_date && request.end_date >= entry.work_date,
        )
        let expected = parseTimeToMinutes((override?.work_start || wfh?.start_time || effectiveSchedule.work_start).slice(0, 5))
        const actual = localMinutes(entry.entry_time)
        const leaves = dayLeaves(employee.id, entry.work_date)
        if (leaves.some((leave) => leave.leave_mode !== 'hourly')) return 0
        const ranges = leaves
          .filter((leave) => leave.leave_mode === 'hourly' && leave.start_time && leave.end_time)
          .map((leave) => [parseTimeToMinutes(leave.start_time!.slice(0, 5)), parseTimeToMinutes(leave.end_time!.slice(0, 5))] as const)
          .sort((a, b) => a[0] - b[0])
        if (ranges.some(([start, end]) => actual >= start && actual <= end)) return 0
        ranges.forEach(([start, end]) => { if (start <= expected && end > expected) expected = end })
        return Math.max(0, actual - (expected + (effectiveSchedule.late_grace_min ?? 0)))
      }

      type ReportDay = {
        employee: HREmployee
        date: string
        row: DashRow
        lateMin: number
        otMin: number
        statusKey: DashStatusKey | 'leave' | 'holiday' | 'absent' | 'future'
        statusLabel: string
        dayTypeLabel: string
        leaveLabel: string
      }
      const reportDays: ReportDay[] = []
      reportEmployees.forEach((employee) => {
        const assigned = employee.work_schedule_id ? scheduleById.get(employee.work_schedule_id) : undefined
        const baseSchedule = assigned ?? fallbackSchedule
        dates.forEach((date) => {
          if (employee.hire_date && date < employee.hire_date.slice(0, 10)) return
          const key = `${employee.id}|${date}`
          const row = entriesByKey.get(key) ?? { employee }
          const override = calendarByKey.get(key)
          const holiday = holidayByDate.get(date)
          const dayType = resolveEmployeeDayType(date, baseSchedule as HRWorkSchedule, override, holiday)
          const leaves = dayLeaves(employee.id, date)
          const hasEntry = !!(row.clockIn || row.clockOut || row.otIn || row.otOut)
          const lateMin = dayType === 'work' && row.clockIn ? lateMinutesFor(row.clockIn, employee, baseSchedule, override) : 0
          const otMin = otMinutesOf(row)
          let dayTypeLabel = 'วันทำงาน'
          let statusKey: ReportDay['statusKey'] = 'normal'
          let statusLabel = 'ปกติ'

          if (dayType === 'company_holiday') {
            dayTypeLabel = holiday?.name ? `วันหยุดบริษัท (${holiday.name})` : 'วันหยุดบริษัท'
            statusKey = 'holiday'
            statusLabel = hasEntry ? 'มาทำงานวันหยุด' : 'ไม่ต้องลงเวลา'
          } else if (dayType === 'weekly_off') {
            dayTypeLabel = override?.day_type === 'weekly_off' ? 'วันหยุดเฉพาะพนักงาน' : 'วันหยุดประจำสัปดาห์'
            statusKey = 'holiday'
            statusLabel = hasEntry ? 'มาทำงานวันหยุด' : 'ไม่ต้องลงเวลา'
          } else if (!hasEntry && leaves.length) {
            statusKey = 'leave'
            statusLabel = 'ลา'
          } else if (!hasEntry) {
            statusKey = date < today ? 'absent' : date === today ? 'missing_in' : 'future'
            statusLabel = date < today ? 'ขาดงาน' : date === today ? 'ยังไม่ลงเวลา' : 'ยังไม่ถึงวันทำงาน'
          } else {
            const status = dashStatusOf(row, lateMin, date < today)
            statusKey = status.key
            statusLabel = status.label
          }

          reportDays.push({
            employee,
            date,
            row,
            lateMin,
            otMin,
            statusKey,
            statusLabel,
            dayTypeLabel,
            leaveLabel: dayType === 'work' ? leaveDescription(leaves) : '',
          })
        })
      })

      // เรียงรหัสพนักงานจากน้อยไปมาก แล้วเรียงวันที่ของพนักงานคนนั้นจากเก่าไปใหม่
      reportDays.sort((a, b) =>
        (a.employee.employee_code || '').localeCompare(b.employee.employee_code || '', 'en', { numeric: true, sensitivity: 'base' })
        || a.date.localeCompare(b.date),
      )
      const dailyRows = reportDays.map((day) => ({
        'วันที่': new Date(`${day.date}T00:00:00`).toLocaleDateString('th-TH'),
        'รหัส': day.employee.employee_code ?? '',
        'พนักงาน': empName(day.employee),
        'แผนก': deptName(day.employee),
        'เข้างาน': day.row.clockIn ? fmtClock(day.row.clockIn.entry_time) : '',
        'ออกงาน': day.row.clockOut ? fmtClock(day.row.clockOut.entry_time) : '',
        'สาย (วัน)': day.lateMin > 0 ? minutesToHHMM(day.lateMin) : day.row.clockIn ? 'ตรงเวลา' : '',
        'เข้า OT': day.row.otIn ? fmtClock(day.row.otIn.entry_time) : '',
        'ออก OT': day.row.otOut ? fmtClock(day.row.otOut.entry_time) : '',
        'OT รวม (วัน)': day.otMin > 0 ? minutesToHHMM(day.otMin) : '',
        'ประเภทวัน': day.dayTypeLabel,
        'สถานะ': day.statusLabel,
        'การลา': day.leaveLabel,
      }))

      type Agg = { employee: HREmployee; present: number; lateCount: number; lateMin: number; otMin: number; missIn: number; missOut: number }
      const byEmp = new Map<string, Agg>()
      reportDays.forEach((day) => {
        const aggregate = byEmp.get(day.employee.id) ?? { employee: day.employee, present: 0, lateCount: 0, lateMin: 0, otMin: 0, missIn: 0, missOut: 0 }
        if (day.row.clockIn) aggregate.present++
        if (day.lateMin > 0) { aggregate.lateCount++; aggregate.lateMin += day.lateMin }
        aggregate.otMin += day.otMin
        if (day.statusKey === 'missing_in') aggregate.missIn++
        if (day.statusKey === 'missing_out') aggregate.missOut++
        byEmp.set(day.employee.id, aggregate)
      })
      const perEmp = [...byEmp.values()].sort((a, b) =>
        (a.employee.employee_code || '').localeCompare(b.employee.employee_code || '', 'en', { numeric: true, sensitivity: 'base' }),
      )
      const grandLate = perEmp.reduce((sum, row) => sum + row.lateMin, 0)
      const grandOt = perEmp.reduce((sum, row) => sum + row.otMin, 0)
      const summaryRows: Record<string, string | number>[] = perEmp.map((row) => ({
        'รหัส': row.employee.employee_code ?? '', 'พนักงาน': empName(row.employee), 'แผนก': deptName(row.employee),
        'มาทำงาน (วัน)': row.present, 'สาย (ครั้ง)': row.lateCount,
        'สายรวม': row.lateMin > 0 ? minutesToHHMM(row.lateMin) : '-', 'OT รวม': row.otMin > 0 ? minutesToHHMM(row.otMin) : '-',
        'ลืมเข้า (ครั้ง)': row.missIn || '', 'ลืมออก (ครั้ง)': row.missOut || '',
      }))
      summaryRows.push({
        'รหัส': '', 'พนักงาน': '★ รวมทั้งหมด', 'แผนก': '', 'มาทำงาน (วัน)': '',
        'สาย (ครั้ง)': perEmp.reduce((sum, row) => sum + row.lateCount, 0),
        'สายรวม': grandLate > 0 ? minutesToHHMM(grandLate) : '-', 'OT รวม': grandOt > 0 ? minutesToHHMM(grandOt) : '-',
        'ลืมเข้า (ครั้ง)': perEmp.reduce((sum, row) => sum + row.missIn, 0) || '',
        'ลืมออก (ครั้ง)': perEmp.reduce((sum, row) => sum + row.missOut, 0) || '',
      })

      const rawRows = [...filteredEntries]
        .sort((a, b) => (a.employee?.employee_code || '').localeCompare(b.employee?.employee_code || '', 'en', { numeric: true, sensitivity: 'base' }) || a.work_date.localeCompare(b.work_date) || a.entry_time.localeCompare(b.entry_time))
        .map((entry) => {
          const lateMin = entryLateMinutes(entry)
          const earlyMin = entryEarlyLeaveMinutes(entry)
          return {
            'รหัส': entry.employee?.employee_code ?? '', 'พนักงาน': empName(entry.employee),
            'แผนก': entry.employee?.department?.name ?? '-', 'ประเภท': ENTRY_LABELS[entry.entry_type],
            'วันที่': new Date(`${entry.work_date}T00:00:00`).toLocaleDateString('th-TH'),
            'เวลา': new Date(entry.entry_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            'สาย / ออกก่อน': entry.entry_type === 'clock_in' ? (lateMin > 0 ? `สาย ${minutesToHHMM(lateMin)}` : 'ตรงเวลา')
              : entry.entry_type === 'clock_out' ? (earlyMin > 0 ? `ออกก่อน ${minutesToHHMM(earlyMin)}` : 'ครบเวลา') : '-',
            'จุดบันทึก': entry.location_name ?? '-', 'ระยะ (ม.)': entry.distance_m != null ? Math.round(entry.distance_m) : '',
          }
        })

      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'TR-ERP'
      workbook.created = new Date()
      const border: Partial<ExcelJS.Borders> = {
        top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      }
      const styleHeader = (worksheet: ExcelJS.Worksheet) => {
        const header = worksheet.getRow(1)
        header.height = 25
        header.eachCell((cell) => {
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF047857' } }
          cell.alignment = { vertical: 'middle', horizontal: 'center' }
          cell.border = border
        })
        worksheet.views = [{ state: 'frozen', ySplit: 1 }]
        if (worksheet.columnCount) worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: worksheet.columnCount } }
      }

      const dailySheet = workbook.addWorksheet('รายวัน (ละเอียด)')
      const dailyColumns = [
        ['วันที่', 13], ['รหัส', 12], ['พนักงาน', 28], ['แผนก', 20], ['เข้างาน', 10], ['ออกงาน', 10],
        ['สาย (วัน)', 13], ['เข้า OT', 10], ['ออก OT', 10], ['OT รวม (วัน)', 14], ['ประเภทวัน', 30], ['สถานะ', 20], ['การลา', 30],
      ] as const
      dailySheet.columns = dailyColumns.map(([key, width]) => ({ header: key, key, width }))
      dailyRows.forEach((data, index) => {
        const row = dailySheet.addRow(data)
        const reportDay = reportDays[index]
        const fillColor = reportDay.statusKey === 'late' ? 'FFFFE0B2'
          : reportDay.statusKey === 'leave' ? 'FFEDE9FE'
            : ['absent', 'missing_in', 'missing_out'].includes(reportDay.statusKey) ? 'FFFFCDD2'
              : reportDay.statusKey === 'holiday' ? 'FFE3F2FD'
                : reportDay.statusKey === 'future' ? 'FFF3F4F6'
                  : reportDay.statusKey === 'certified' ? 'FFD9EAF7'
                    : reportDay.statusKey === 'working' ? 'FFE0F2FE'
                      : 'FFFFFFFF'
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } }
          cell.border = border
          cell.alignment = { vertical: 'middle', horizontal: 'left' }
        })
        row.getCell(12).font = { bold: true, color: { argb: reportDay.statusKey === 'absent' ? 'FFB91C1C' : 'FF374151' } }
      })
      styleHeader(dailySheet)

      const summarySheet = workbook.addWorksheet('สรุปต่อคน')
      const summaryColumns = [['รหัส', 12], ['พนักงาน', 28], ['แผนก', 20], ['มาทำงาน (วัน)', 16], ['สาย (ครั้ง)', 14], ['สายรวม', 14], ['OT รวม', 14], ['ลืมเข้า (ครั้ง)', 16], ['ลืมออก (ครั้ง)', 16]] as const
      summarySheet.columns = summaryColumns.map(([key, width]) => ({ header: key, key, width }))
      summaryRows.forEach((data) => {
        const row = summarySheet.addRow(data)
        row.eachCell((cell) => { cell.border = border; cell.alignment = { vertical: 'middle', horizontal: 'left' } })
      })
      const totalRow = summarySheet.getRow(summarySheet.rowCount)
      totalRow.font = { bold: true }
      totalRow.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } } })
      styleHeader(summarySheet)

      const rawSheet = workbook.addWorksheet('บันทึกดิบ')
      const rawHeaders = Object.keys(rawRows[0] ?? { 'รหัส': '', 'พนักงาน': '', 'แผนก': '', 'ประเภท': '', 'วันที่': '', 'เวลา': '', 'สาย / ออกก่อน': '', 'จุดบันทึก': '', 'ระยะ (ม.)': '' })
      rawSheet.columns = rawHeaders.map((key) => ({ header: key, key, width: key === 'พนักงาน' ? 28 : key === 'แผนก' || key === 'จุดบันทึก' ? 20 : 14 }))
      rawRows.forEach((data) => {
        const row = rawSheet.addRow(data)
        row.eachCell((cell) => { cell.border = border; cell.alignment = { vertical: 'middle', horizontal: 'left' } })
      })
      styleHeader(rawSheet)

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `สรุปเวลาทำงาน_${dateFrom}_ถึง_${dateTo}.xlsx`
      link.style.display = 'none'
      document.body.appendChild(link)
      link.click()
      link.remove()
      // Chrome may start consuming a large ExcelJS Blob after the click stack
      // completes. Revoking immediately can make the download require a retry.
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (error) {
      window.alert(error instanceof Error ? `Export Excel ไม่สำเร็จ: ${error.message}` : 'Export Excel ไม่สำเร็จ')
    } finally {
      setExportingEntries(false)
    }
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
            <label className="text-sm">
              <span className="block text-gray-500 mb-1">แผนก</span>
              <select value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)} className={inputClass}>
                <option value="">ทุกแผนก</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>{department.name}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void loadEntries()}
              className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700"
            >
              <FiRefreshCw className={entriesLoading ? 'animate-spin' : ''} /> รีเฟรช
            </button>
            <button
              type="button"
              onClick={exportEntries}
              disabled={entriesLoading || exportingEntries || !dateFrom || !dateTo || dateFrom > dateTo}
              className="flex items-center gap-1.5 px-3 py-2 border border-emerald-600 text-emerald-700 text-sm font-medium rounded-lg hover:bg-emerald-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <FiDownload /> {exportingEntries ? 'กำลังสร้าง...' : 'Export Excel'}
            </button>
            <button
              type="button"
              onClick={() => setShowImport(true)}
              className="flex items-center gap-1.5 px-3 py-2 border border-amber-500 text-amber-700 text-sm font-medium rounded-lg hover:bg-amber-50"
            >
              <FiUpload /> นำเข้า
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
            <AttendanceDashboard
              groups={dashboardGroups}
              lateOf={entryLateMinutes}
              today={todayStr()}
              certOf={certOf}
              onCertify={(employee, workDate, entryType) => {
                setCertError('')
                const existing = certOf(employee.id, workDate, entryType)
                setCertForm({
                  employee,
                  workDate,
                  entryType,
                  time: existing ? new Date(existing.certified_time).toTimeString().slice(0, 5) : '',
                  reason: existing?.reason ?? '',
                })
              }}
            />
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
                    <th className="p-3 text-center font-semibold">สาย / ออกก่อน</th>
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
                            ? <span className="text-red-600 font-semibold">สาย {minutesToHHMM(entryLateMinutes(e))}</span>
                            : <span className="text-emerald-600 text-xs">ตรงเวลา</span>
                          : e.entry_type === 'clock_out'
                            ? entryEarlyLeaveMinutes(e) > 0
                              ? <span className="text-amber-600 font-semibold">ออกก่อน {minutesToHHMM(entryEarlyLeaveMinutes(e))}</span>
                              : <span className="text-emerald-600 text-xs">ครบเวลา</span>
                            : <span className="text-gray-300">-</span>}
                      </td>
                      <td className="p-3 text-gray-600">
                        <span className="flex items-center gap-1">
                          {e.lat != null && e.lng != null ? (
                            <a
                              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${e.lat},${e.lng}`)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex-shrink-0 rounded p-0.5 text-emerald-500 transition-colors hover:bg-emerald-50 hover:text-emerald-700"
                              title="เปิดพิกัดใน Google Maps"
                              aria-label={`เปิดพิกัดของ ${e.location_name ?? 'จุดบันทึก'} ใน Google Maps`}
                            >
                              <FiMapPin className="h-4 w-4" />
                            </a>
                          ) : (
                            <FiMapPin className="h-4 w-4 flex-shrink-0 text-gray-300" aria-label="ไม่มีข้อมูลพิกัด" />
                          )}
                          {e.location_name ?? '-'}
                        </span>
                        <span className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${sourceBadge(e.source).cls}`}>
                          {sourceBadge(e.source).label}
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
                        ) : e.photo_expired_at ? (
                          <span className="inline-flex rounded-full bg-gray-100 px-2 py-1 text-[11px] font-medium text-gray-500">
                            หมดอายุ
                          </span>
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

      {/* Modal นำเข้าข้อมูลจากเครื่องสแกนนิ้ว */}
      <TimeEntryImport open={showImport} onClose={() => setShowImport(false)} onImported={() => void loadEntries()} />

      {/* Modal หัวหน้ารับรองเวลา */}
      <Modal open={!!certForm} onClose={() => setCertForm(null)} closeOnBackdropClick contentClassName="max-w-md">
        {certForm && (
          <>
            <div className="flex items-center px-4 py-3 pr-16 bg-sky-600 text-white">
              <span className="text-sm font-medium">
                รับรอง{certForm.entryType === 'clock_in' ? 'เวลาเข้างาน' : 'เวลาออกงาน'}
              </span>
            </div>
            <div className="p-4 space-y-3">
              <div className="text-sm">
                <div className="font-medium text-gray-800">{empName(certForm.employee)}</div>
                <div className="text-xs text-gray-400">
                  {certForm.employee.employee_code} · {certForm.workDate}
                </div>
              </div>
              {certError && (
                <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 px-3 py-2 text-sm">{certError}</div>
              )}
              <label className="block text-sm">
                <span className="text-gray-600">เวลาที่รับรอง</span>
                <input
                  type="time"
                  value={certForm.time}
                  onChange={(e) => setCertForm({ ...certForm, time: e.target.value })}
                  className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
                />
              </label>
              <label className="block text-sm">
                <span className="text-gray-600">เหตุผล (บังคับ)</span>
                <textarea
                  rows={3}
                  value={certForm.reason}
                  onChange={(e) => setCertForm({ ...certForm, reason: e.target.value })}
                  placeholder="เช่น มือถือแบตหมด ยืนยันจากกล้องวงจรปิดว่าเข้างาน 08:00"
                  className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
                />
              </label>
              <p className="text-xs text-gray-400">
                การรับรองถูกบันทึกแยกจากบันทึกเวลาจริง และมีชื่อผู้รับรองกำกับไว้ตรวจสอบย้อนหลังได้
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={saveCertification} disabled={certSaving}
                  className="px-4 py-2 rounded-xl bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 text-sm">
                  {certSaving ? 'กำลังบันทึก...' : 'บันทึกการรับรอง'}
                </button>
              </div>
            </div>
          </>
        )}
      </Modal>

      {/* Modal ดูรูป — ใช้ Modal กลางที่เว้นระยะใต้ header/แถบเมนูให้อัตโนมัติ */}
      <Modal
        open={!!photoView}
        onClose={() => setPhotoView(null)}
        closeOnBackdropClick
        contentClassName="max-w-lg !overflow-hidden"
      >
        {photoView && (
          <>
            <div className="flex items-center px-4 py-3 pr-16 bg-emerald-600 text-white flex-shrink-0">
              <span className="text-sm font-medium truncate">{photoView.caption}</span>
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
/**
 * ช่องเวลาที่ไม่มีบันทึกจริง — แสดงเวลาที่หัวหน้ารับรอง หรือปุ่มให้รับรอง
 * เวลาที่รับรองไม่ได้เขียนทับ hr_time_entries (เก็บแยกใน hr_time_certifications)
 */
function CertifiedSlot({ cert, onCertify }: { cert?: HRTimeCertification; onCertify: () => void }) {
  if (cert) {
    const certifier = cert.certifier
    const certifierFullName = certifier
      ? `${certifier.first_name || ''} ${certifier.last_name || ''}`.replace(/\s+/g, ' ').trim()
      : ''
    const certifierDisplayName = certifierFullName
      ? `${certifierFullName}${certifier?.nickname ? ` (${certifier.nickname})` : ''}`
      : 'ไม่พบข้อมูล'
    return (
      <>
        <div className="font-bold text-gray-800 tabular-nums">{fmtClock(cert.certified_time)}</div>
        <button
          type="button"
          onClick={onCertify}
          title={`เหตุผล: ${cert.reason}`}
          className="mt-0.5 rounded-full bg-sky-100 text-sky-700 px-1.5 py-0.5 text-[10px] font-semibold hover:bg-sky-200"
        >
          ✓ หัวหน้ารับรอง
        </button>
        <div className="mt-1 truncate text-[10px] text-sky-700" title={`ผู้รับรอง: ${certifierDisplayName}`}>
          ผู้รับรอง: {certifierDisplayName}
        </div>
      </>
    )
  }
  return (
    <>
      <div className="font-bold text-rose-500">ไม่มีบันทึก</div>
      <button
        type="button"
        onClick={onCertify}
        className="mt-0.5 rounded-lg border border-sky-500 text-sky-700 px-1.5 py-0.5 text-[10px] font-medium hover:bg-sky-50"
      >
        รับรองเวลา
      </button>
    </>
  )
}

function AttendanceDashboard({
  groups,
  lateOf,
  today,
  certOf,
  onCertify,
}: {
  groups: { date: string; rows: DashRow[] }[]
  lateOf: (e: HRTimeEntry) => number
  today: string
  certOf: (employeeId: string, workDate: string, entryType: 'clock_in' | 'clock_out') => HRTimeCertification | undefined
  onCertify: (employee: HREmployee, workDate: string, entryType: 'clock_in' | 'clock_out') => void
}) {
  const [filter, setFilter] = useState<DashFilter>('all')

  // เตรียมข้อมูลต่อวัน: คำนวณสถานะ/สาย/OT ล่วงหน้า, เรียงปัญหาขึ้นบน, และสรุปยอด
  const prepared = groups.map(({ date, rows }) => {
    const isPast = date < today
    const items = rows
      .map((r) => {
        const lateMin = r.clockIn ? lateOf(r.clockIn) : 0
        const otMin = otMinutesOf(r)
        const certified = {
          in: !!certOf(r.employee.id, date, 'clock_in'),
          out: !!certOf(r.employee.id, date, 'clock_out'),
        }
        return { r, lateMin, otMin, status: dashStatusOf(r, lateMin, isPast, certified) }
      })
      .sort((a, b) => b.status.sev - a.status.sev || empName(a.r.employee).localeCompare(empName(b.r.employee), 'th'))

    const counts = { normal: 0, certified: 0, late: 0, missing_out: 0, working: 0, missing_in: 0 } as Record<DashStatusKey, number>
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
                          <CertifiedSlot
                            cert={certOf(r.employee.id, date, 'clock_in')}
                            onCertify={() => onCertify(r.employee, date, 'clock_in')}
                          />
                        )}
                      </div>
                      <div className="rounded-lg bg-rose-50/50 px-2.5 py-2">
                        <div className="text-[11px] text-gray-500 mb-0.5">ออกงาน</div>
                        {r.clockOut ? (
                          <div className="font-bold text-gray-800 tabular-nums">{fmtClock(r.clockOut.entry_time)}</div>
                        ) : isPast ? (
                          <CertifiedSlot
                            cert={certOf(r.employee.id, date, 'clock_out')}
                            onCertify={() => onCertify(r.employee, date, 'clock_out')}
                          />
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
