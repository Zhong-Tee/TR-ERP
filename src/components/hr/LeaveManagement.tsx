import { useState, useEffect, useCallback } from 'react'
import { FiSearch, FiCalendar, FiFileText, FiExternalLink, FiClock, FiUpload, FiWifi } from 'react-icons/fi'
import LeaveImport from './LeaveImport'
import {
  fetchLeaveRequests,
  updateLeaveRequest,
  fetchLeaveTypes,
  fetchOTRequests,
  updateOTRequest,
  getMedicalCertUrl,
  fetchEmployeeByUserId,
  fetchEmployees,
  fetchWorkCalendar,
  fetchCompanyHolidays,
  fetchWFHRequests,
  updateWFHRequest,
  fetchAllOpeningLeaveBalances,
} from '../../lib/hrApi'
import type { HRCompanyHoliday, HREmployee, HREmployeeWorkCalendar, HRLeaveRequest, HROTRequest, HRWFHRequest } from '../../types'
import Modal from '../ui/Modal'
import { useAuthContext } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected'
const WORK_MINUTES_PER_DAY = 8 * 60
const WEEKDAY_LABELS = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'] as const

function asDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00`)
}

function toDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function thaiWeekdayName(d: Date): string {
  return d.toLocaleDateString('th-TH', { weekday: 'long' })
}

/** ช่วงวันที่ทั้งหมดที่ตารางปฏิทินแสดง (รวมวันของเดือนข้างเคียงที่ล้นมาต้น/ท้ายตาราง) */
function calendarGridRange(month: Date) {
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1)
  const monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 0)
  const startOffset = (monthStart.getDay() + 6) % 7 // Mon=0 ... Sun=6
  const totalCells = Math.ceil((startOffset + monthEnd.getDate()) / 7) * 7
  const start = new Date(monthStart)
  start.setDate(1 - startOffset)
  const end = new Date(monthStart)
  end.setDate(1 - startOffset + totalCells - 1)
  return { monthStart, startOffset, totalCells, start, end }
}

/** ชื่อพนักงานจากทะเบียนพนักงาน (ใช้กับรายการวันหยุดที่มีแค่ employee_id) */
function employeeName(emp?: HREmployee): string {
  if (!emp) return 'ไม่ทราบชื่อ'
  const name = [emp.first_name, emp.last_name].filter(Boolean).join(' ')
  return emp.nickname ? `${name} (${emp.nickname})` : name || '-'
}

function statusBadgeClass(status: HRLeaveRequest['status']): string {
  switch (status) {
    case 'pending':
      return 'bg-amber-100 text-amber-800 border-amber-200'
    case 'approved':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200'
    case 'rejected':
      return 'bg-red-100 text-red-800 border-red-200'
    case 'cancelled':
      return 'bg-gray-100 text-gray-600 border-gray-200'
    default:
      return 'bg-gray-100 text-gray-600 border-gray-200'
  }
}

function statusLabel(status: HRLeaveRequest['status']): string {
  const labels: Record<HRLeaveRequest['status'], string> = {
    pending: 'รอดำเนินการ',
    approved: 'อนุมัติ',
    rejected: 'ไม่อนุมัติ',
    cancelled: 'ยกเลิก',
  }
  return labels[status] ?? status
}

/** ประเภทลาหลักที่โชว์ในตาราง (ที่เหลือดูใน popup) */
const MAIN_LEAVE_KEYWORDS = ['กิจ', 'ป่วย', 'พักร้อน'] as const
const isMainLeaveType = (name: string) => MAIN_LEAVE_KEYWORDS.some((k) => name.includes(k))

type LeaveBalanceRow = { id: string; name: string; entitled: number; used: number; remaining: number }

function employeeDisplayName(req: HRLeaveRequest): string {
  const emp = req.employee as { first_name?: string; last_name?: string; nickname?: string } | undefined
  if (!emp) return '-'
  const name = [emp.first_name, emp.last_name].filter(Boolean).join(' ')
  return emp.nickname ? `${name} (${emp.nickname})` : name
}

function employeePositionName(req: HRLeaveRequest): string {
  const emp = req.employee as { position?: { name?: string } } | undefined
  return emp?.position?.name ?? '-'
}

function approverDisplayName(req: HRLeaveRequest): string {
  const approver = req.approver
  if (!approver) return '-'
  const name = [approver.first_name, approver.last_name].filter(Boolean).join(' ')
  return approver.nickname ? `${name} (${approver.nickname})` : name || '-'
}

/** ระยะเวลาลา → dd:hh:mm โดย 1 วันทำงาน = 8 ชั่วโมง */
function leaveDurationDDHHMM(req: HRLeaveRequest): string {
  const totalMinutes = req.leave_mode === 'hourly' && req.total_hours != null
    ? Math.round(Number(req.total_hours) * 60)
    : Math.round(Number(req.total_days ?? 0) * WORK_MINUTES_PER_DAY)
  const days = Math.floor(totalMinutes / WORK_MINUTES_PER_DAY)
  const remainingMinutes = totalMinutes % WORK_MINUTES_PER_DAY
  const hours = Math.floor(remainingMinutes / 60)
  const minutes = remainingMinutes % 60
  return `${String(days).padStart(2, '0')}:${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** ช่วงเวลาลาแบบรายชั่วโมง — คืน null เมื่อเป็นการลาเต็มวันหรือไม่ได้ระบุเวลา */
function leaveTimeRange(req: HRLeaveRequest): string | null {
  if (req.leave_mode !== 'hourly' || !req.start_time || !req.end_time) return null
  return `${req.start_time.slice(0, 5)} – ${req.end_time.slice(0, 5)} น.`
}

function calendarLeaveDuration(req: HRLeaveRequest): string {
  if (req.leave_mode === 'hourly') {
    const hours = Number(req.total_hours ?? 0)
    if (!hours) return 'ลาเป็นช่วงเวลา'
    const totalMinutes = Math.round(hours * 60)
    const hourPart = Math.floor(totalMinutes / 60)
    const minutePart = totalMinutes % 60
    return [hourPart ? `${hourPart} ชม.` : '', minutePart ? `${minutePart} นาที` : ''].filter(Boolean).join(' ')
  }

  const days = Number(req.total_days ?? 0)
  return days ? `${days.toLocaleString('th-TH')} วัน` : 'เต็มวัน'
}

function compactThaiDate(value: string): string {
  return asDateOnly(value).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })
}

/** ชั่วโมงทศนิยม → hh:mm */
function hoursToHHMM(hours?: number | null): string {
  if (hours == null || !Number.isFinite(Number(hours))) return '-'
  const totalMinutes = Math.round(Number(hours) * 60)
  const wholeHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${String(wholeHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** เปิดเอกสารแนบใบลาผ่าน signed URL (bucket private) — เปิดแท็บก่อนกัน popup blocker */
async function openMedicalCert(path?: string) {
  if (!path) return
  const w = window.open('', '_blank')
  try {
    const signed = await getMedicalCertUrl(path)
    if (w) w.location.href = signed
    else window.open(signed, '_blank')
  } catch {
    if (w) w.close()
    alert('เปิดไฟล์ไม่สำเร็จ')
  }
}

function otEmployeeName(req: HROTRequest): string {
  const emp = req.employee as { first_name?: string; last_name?: string; nickname?: string } | undefined
  if (!emp) return '-'
  const name = [emp.first_name, emp.last_name].filter(Boolean).join(' ')
  return emp.nickname ? `${name} (${emp.nickname})` : name
}

export default function LeaveManagement() {
  const { user } = useAuthContext()
  /** สิทธิ์เข้าหน้า + อนุมัติลา: เฉพาะ superadmin / admin / hr / account */
  const canManageLeave = ['superadmin', 'admin', 'hr', 'account'].includes(user?.role ?? '')
  const canApproveOT = user?.role === 'superadmin' || user?.role === 'admin'
  const [requests, setRequests] = useState<HRLeaveRequest[]>([])
  const [otRequests, setOtRequests] = useState<HROTRequest[]>([])
  const [wfhRequests, setWfhRequests] = useState<HRWFHRequest[]>([])
  const [wfhStatusFilter, setWfhStatusFilter] = useState<StatusFilter>('all')
  const [otStatusFilter, setOtStatusFilter] = useState<StatusFilter>('all')
  const [otRejectingId, setOtRejectingId] = useState<string | null>(null)
  const [balanceView, setBalanceView] = useState<{ name: string; rows: LeaveBalanceRow[] } | null>(null)
  const [leaveTypes, setLeaveTypes] = useState<Awaited<ReturnType<typeof fetchLeaveTypes>>>([])
  const [openingBalances, setOpeningBalances] = useState<Awaited<ReturnType<typeof fetchAllOpeningLeaveBalances>>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'list' | 'approval' | 'ot' | 'wfh' | 'calendar'>('list')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [searchName, setSearchName] = useState('')
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => new Date())
  /** วันหยุดที่กำหนดพิเศษรายคน (เมนูตารางวันทำงาน/วันหยุด) ของเดือนที่แสดงอยู่ */
  const [dayOffEntries, setDayOffEntries] = useState<HREmployeeWorkCalendar[]>([])
  const [companyHolidays, setCompanyHolidays] = useState<HRCompanyHoliday[]>([])
  const [employeeById, setEmployeeById] = useState<Record<string, HREmployee>>({})
  const [detailRequest, setDetailRequest] = useState<HRLeaveRequest | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)

  /** hr_employees.id ของผู้ใช้ปัจจุบัน — บันทึกเป็นผู้อนุมัติ/ผู้ปฏิเสธ */
  const [currentEmployeeId, setCurrentEmployeeId] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!user?.id) return
    fetchEmployeeByUserId(user.id)
      .then((emp) => setCurrentEmployeeId(emp?.id))
      .catch(() => {})
  }, [user?.id])

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [reqs, types, ots, wfh, openings] = await Promise.all([
        fetchLeaveRequests(),
        fetchLeaveTypes(),
        fetchOTRequests(),
        fetchWFHRequests(),
        fetchAllOpeningLeaveBalances(),
      ])
      setRequests(reqs)
      setLeaveTypes(types)
      setOtRequests(ots)
      setWfhRequests(wfh)
      setOpeningBalances(openings)
      // แจ้ง sidebar/topbar ให้อัปเดต badge ทันที (ไม่ต้องรอ realtime)
      window.dispatchEvent(new Event('hr-counts-changed'))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  // วันหยุดของพนักงานในเดือนที่ปฏิทินแสดงอยู่ — โหลดเฉพาะตอนเปิดแท็บปฏิทิน
  useEffect(() => {
    if (activeTab !== 'calendar') return
    let cancelled = false
    const { start, end } = calendarGridRange(calendarMonth)
    Promise.all([
      fetchWorkCalendar(toDateKey(start), toDateKey(end)),
      fetchCompanyHolidays(toDateKey(start), toDateKey(end)),
      fetchEmployees(),
    ])
      .then(([calendar, holidays, employees]) => {
        if (cancelled) return
        setDayOffEntries(calendar.filter((e) => e.day_type === 'weekly_off'))
        setCompanyHolidays(holidays)
        setEmployeeById(Object.fromEntries(employees.map((e) => [e.id, e])))
      })
      .catch(() => {
        /* สิทธิ์ไม่ถึงหรือโหลดไม่สำเร็จ — ปฏิทินลายังใช้งานได้ตามปกติ */
      })
    return () => {
      cancelled = true
    }
  }, [activeTab, calendarMonth])

  // โหลดข้อมูลใหม่แบบเงียบ (ไม่โชว์ spinner) สำหรับ realtime
  const reloadSilent = useCallback(async () => {
    try {
      const [reqs, types, ots, wfh] = await Promise.all([
        fetchLeaveRequests(),
        fetchLeaveTypes(),
        fetchOTRequests(),
        fetchWFHRequests(),
      ])
      setRequests(reqs)
      setLeaveTypes(types)
      setOtRequests(ots)
      setWfhRequests(wfh)
      window.dispatchEvent(new Event('hr-counts-changed'))
    } catch {
      /* เงียบไว้ — เดี๋ยว realtime ครั้งถัดไปหรือรีเฟรชจะอัปเดตเอง */
    }
  }, [])

  // Realtime: มีการยื่น/อนุมัติ/ปฏิเสธ ใบลา หรือ คำขอ OT → อัปเดต badge + ตารางทันที
  useEffect(() => {
    const channel = supabase
      .channel('leave-mgmt-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_leave_requests' }, () => reloadSilent())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_ot_requests' }, () => reloadSilent())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_wfh_requests' }, () => reloadSilent())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [reloadSilent])

  const filteredRequests = requests.filter((req) => {
    if (activeTab === 'approval' && req.status !== 'pending') return false
    if (activeTab === 'list' && statusFilter !== 'all' && req.status !== statusFilter) return false
    if (searchName.trim()) {
      const name = employeeDisplayName(req).toLowerCase()
      if (!name.includes(searchName.trim().toLowerCase())) return false
    }
    return true
  })

  const pendingRequests = requests.filter((r) => r.status === 'pending')
  const pendingOtRequests = otRequests.filter((r) => r.status === 'pending')
  const pendingWfhRequests = wfhRequests.filter((r) => r.status === 'pending')
  const filteredOtRequests = otRequests.filter((r) => {
    if (otStatusFilter !== 'all' && r.status !== otStatusFilter) return false
    if (searchName.trim()) {
      const name = otEmployeeName(r).toLowerCase()
      if (!name.includes(searchName.trim().toLowerCase())) return false
    }
    return true
  })
  const filteredWfhRequests = wfhRequests.filter((r) => {
    if (wfhStatusFilter !== 'all' && r.status !== wfhStatusFilter) return false
    if (searchName.trim() && !employeeDisplayName(r as unknown as HRLeaveRequest).toLowerCase().includes(searchName.trim().toLowerCase())) return false
    return true
  })
  const calendarRequests = requests.filter((r) => r.status === 'approved' || r.status === 'pending')

  const today = new Date()
  const todayKey = toDateKey(today)
  const selectedDateKey = toDateKey(selectedCalendarDate)
  const isSelectedToday = selectedDateKey === todayKey
  const monthYearLabel = calendarMonth.toLocaleDateString('th-TH', {
    month: 'long',
    year: 'numeric',
  })

  const { monthStart, startOffset, totalCells } = calendarGridRange(calendarMonth)

  const leavesByDate = calendarRequests.reduce<Record<string, HRLeaveRequest[]>>((acc, req) => {
    const start = asDateOnly(req.start_date)
    const end = asDateOnly(req.end_date)
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = toDateKey(d)
      if (!acc[key]) acc[key] = []
      acc[key].push(req)
    }
    return acc
  }, {})

  const dayOffsByDate = dayOffEntries.reduce<Record<string, HREmployeeWorkCalendar[]>>((acc, entry) => {
    if (!acc[entry.work_date]) acc[entry.work_date] = []
    acc[entry.work_date].push(entry)
    return acc
  }, {})

  const holidayByDate = companyHolidays.reduce<Record<string, HRCompanyHoliday>>((acc, h) => {
    acc[h.holiday_date] = h
    return acc
  }, {})

  const calendarCells = Array.from({ length: totalCells }, (_, idx) => {
    const d = new Date(monthStart)
    d.setDate(1 - startOffset + idx)
    const key = toDateKey(d)
    return {
      date: d,
      key,
      inMonth: d.getMonth() === calendarMonth.getMonth(),
      isToday: key === todayKey,
      leaves: leavesByDate[key] ?? [],
      dayOffs: dayOffsByDate[key] ?? [],
      holiday: holidayByDate[key],
    }
  })

  const selectedDateLeaves = leavesByDate[selectedDateKey] ?? []
  const selectedDateDayOffs = dayOffsByDate[selectedDateKey] ?? []
  const selectedDateHoliday = holidayByDate[selectedDateKey]

  const approvedUsedByEmpYearType = requests.reduce<Record<string, number>>((acc, req) => {
    if (req.status !== 'approved') return acc
    const year = new Date(req.start_date).getFullYear()
    const key = `${req.employee_id}|${year}|${req.leave_type_id}`
    acc[key] = (acc[key] ?? 0) + Number(req.total_days ?? 0)
    return acc
  }, {})

  const getLeaveBalanceRows = (employeeId: string, dateForYear: string) => {
    const year = new Date(dateForYear).getFullYear()
    return leaveTypes.map((t) => {
      const opening = openingBalances.find((row) => row.employee_id === employeeId && row.leave_type_id === t.id && row.year === year)
      const entitled = opening ? Number(opening.opening_remaining_days) : Number(t.max_days_per_year ?? 0)
      const used = opening
        ? requests.filter((req) => req.employee_id === employeeId && req.leave_type_id === t.id && req.status === 'approved' && new Date(req.start_date).getFullYear() === year && req.start_date >= opening.effective_date).reduce((sum, req) => sum + Number(req.total_days ?? 0), 0)
        : (approvedUsedByEmpYearType[`${employeeId}|${year}|${t.id}`] ?? 0)
      return { id: t.id, name: t.name, entitled, used, remaining: Math.max(0, entitled - used) }
    })
  }

  const handleApprove = async (id: string) => {
    setActionLoading(true)
    setError(null)
    try {
      await updateLeaveRequest(id, {
        status: 'approved',
        approved_by: currentEmployeeId ?? undefined,
        approved_at: new Date().toISOString(),
      })
      supabase.functions.invoke('hr-leave-request-notify', { body: { leave_id: id, event: 'approved' } }).catch(() => {})
      setSuccessMessage('อนุมัติการลาสำเร็จ')
      setRejectingId(null)
      setRejectReason('')
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'อนุมัติไม่สำเร็จ')
    } finally {
      setActionLoading(false)
    }
  }

  const handleReject = async () => {
    if (!rejectingId) return
    const reason = rejectReason.trim()
    if (!reason) {
      setError('กรุณาระบุเหตุผลในการไม่อนุมัติ')
      return
    }
    setActionLoading(true)
    setError(null)
    try {
      await updateLeaveRequest(rejectingId, {
        status: 'rejected',
        reject_reason: reason,
        approved_by: currentEmployeeId ?? undefined,
      })
      supabase.functions.invoke('hr-leave-request-notify', { body: { leave_id: rejectingId, event: 'rejected' } }).catch(() => {})
      setSuccessMessage('ไม่อนุมัติการลาแล้ว')
      setRejectingId(null)
      setRejectReason('')
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ดำเนินการไม่สำเร็จ')
    } finally {
      setActionLoading(false)
    }
  }

  const openRejectModal = (id: string) => {
    setRejectingId(id)
    setRejectReason('')
    setError(null)
  }

  const closeRejectModal = () => {
    setRejectingId(null)
    setRejectReason('')
  }

  const handleApproveOT = async (id: string) => {
    setActionLoading(true)
    setError(null)
    try {
      await updateOTRequest(id, {
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: currentEmployeeId ?? undefined,
      })
      supabase.functions.invoke('hr-ot-notify', { body: { ot_id: id, event: 'approved' } }).catch(() => {})
      setSuccessMessage('อนุมัติคำขอ OT สำเร็จ')
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'อนุมัติไม่สำเร็จ')
    } finally {
      setActionLoading(false)
    }
  }

  const handleRejectOT = async () => {
    if (!otRejectingId) return
    const reason = rejectReason.trim()
    if (!reason) {
      setError('กรุณาระบุเหตุผลในการไม่อนุมัติ')
      return
    }
    setActionLoading(true)
    setError(null)
    try {
      await updateOTRequest(otRejectingId, {
        status: 'rejected',
        reject_reason: reason,
        approved_by: currentEmployeeId ?? undefined,
      })
      supabase.functions.invoke('hr-ot-notify', { body: { ot_id: otRejectingId, event: 'rejected' } }).catch(() => {})
      setSuccessMessage('ไม่อนุมัติคำขอ OT แล้ว')
      setOtRejectingId(null)
      setRejectReason('')
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ดำเนินการไม่สำเร็จ')
    } finally {
      setActionLoading(false)
    }
  }

  const handleWFHStatus = async (id: string, status: 'approved' | 'rejected') => {
    const reason = status === 'rejected' ? window.prompt('ระบุเหตุผลที่ไม่อนุมัติ WFH')?.trim() : ''
    if (status === 'rejected' && !reason) return
    setActionLoading(true)
    setError(null)
    try {
      await updateWFHRequest(id, {
        status,
        approved_by: currentEmployeeId ?? undefined,
        approved_at: new Date().toISOString(),
        reject_reason: reason || undefined,
      })
      setSuccessMessage(status === 'approved' ? 'อนุมัติคำขอ WFH สำเร็จ' : 'ไม่อนุมัติคำขอ WFH แล้ว')
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ดำเนินการคำขอ WFH ไม่สำเร็จ')
    } finally {
      setActionLoading(false)
    }
  }

  useEffect(() => {
    if (!successMessage) return
    const t = setTimeout(() => setSuccessMessage(null), 3000)
    return () => clearTimeout(t)
  }, [successMessage])

  if (!canManageLeave) {
    return (
      <div className="mt-8 rounded-xl bg-white shadow-soft border border-surface-200 p-10 text-center">
        <div className="text-4xl mb-3">🔒</div>
        <p className="text-lg font-semibold text-surface-700">ไม่มีสิทธิ์เข้าถึงหน้านี้</p>
        <p className="text-sm text-surface-500 mt-1">เฉพาะผู้ดูแลระบบ / แอดมิน / ฝ่ายบุคคล / บัญชี เท่านั้น</p>
      </div>
    )
  }

  return (
    <div className="mt-4 space-y-6">
      <div className="rounded-xl bg-white shadow-soft border border-surface-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-surface-200 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('list')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'list'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-surface-100 text-surface-700 hover:bg-surface-200'
              }`}
            >
              คำขอลางาน
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('approval')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'approval'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-surface-100 text-surface-700 hover:bg-surface-200'
              }`}
            >
              อนุมัติการลา
              {pendingRequests.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-amber-500 text-white text-xs">
                  {pendingRequests.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('ot')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                activeTab === 'ot'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-surface-100 text-surface-700 hover:bg-surface-200'
              }`}
            >
              <FiClock className="w-4 h-4" />
              คำขอ OT
              {pendingOtRequests.length > 0 && (
                <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-amber-500 text-white text-xs">
                  {pendingOtRequests.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('wfh')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                activeTab === 'wfh'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-surface-100 text-surface-700 hover:bg-surface-200'
              }`}
            >
              <FiWifi className="w-4 h-4" />
              คำขอ WFH
              {pendingWfhRequests.length > 0 && (
                <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-amber-500 text-white text-xs">
                  {pendingWfhRequests.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('calendar')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                activeTab === 'calendar'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-surface-100 text-surface-700 hover:bg-surface-200'
              }`}
            >
              <FiCalendar className="w-4 h-4" />
              ปฏิทินลา
            </button>
          </div>
          {activeTab === 'wfh' && (
            <div className="flex items-center gap-3 flex-wrap">
              <select value={wfhStatusFilter} onChange={(e) => setWfhStatusFilter(e.target.value as StatusFilter)} className="rounded-lg border border-surface-300 bg-white px-3 py-2 text-sm text-surface-800">
                <option value="all">ทุกสถานะ</option><option value="pending">รออนุมัติ</option><option value="approved">อนุมัติ</option><option value="rejected">ไม่อนุมัติ</option>
              </select>
              <div className="relative"><FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" /><input type="text" placeholder="ค้นหาชื่อพนักงาน..." value={searchName} onChange={(e) => setSearchName(e.target.value)} className="pl-9 pr-4 py-2 rounded-lg border border-surface-300 bg-white text-sm w-56" /></div>
            </div>
          )}
          {activeTab === 'ot' && (
            <div className="flex items-center gap-3 flex-wrap">
              <select
                value={otStatusFilter}
                onChange={(e) => setOtStatusFilter(e.target.value as StatusFilter)}
                className="rounded-lg border border-surface-300 bg-white px-3 py-2 text-sm text-surface-800"
              >
                <option value="all">ทุกสถานะ</option>
                <option value="pending">รออนุมัติ</option>
                <option value="approved">อนุมัติ</option>
                <option value="rejected">ไม่อนุมัติ</option>
              </select>
              <div className="relative">
                <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
                <input
                  type="text"
                  placeholder="ค้นหาชื่อพนักงาน..."
                  value={searchName}
                  onChange={(e) => setSearchName(e.target.value)}
                  className="pl-9 pr-4 py-2 rounded-lg border border-surface-300 bg-white text-sm w-56"
                />
              </div>
            </div>
          )}
          {activeTab === 'list' && (
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => setShowImport(true)}
                className="flex items-center gap-1.5 rounded-lg border border-amber-500 text-amber-700 px-3 py-2 text-sm font-medium hover:bg-amber-50"
              >
                <FiUpload className="w-4 h-4" /> นำเข้าใบลาย้อนหลัง
              </button>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="rounded-lg border border-surface-300 bg-white px-3 py-2 text-sm text-surface-800"
              >
                <option value="all">ทุกสถานะ</option>
                <option value="pending">รอดำเนินการ</option>
                <option value="approved">อนุมัติ</option>
                <option value="rejected">ไม่อนุมัติ</option>
              </select>
              <div className="relative">
                <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
                <input
                  type="text"
                  placeholder="ค้นหาชื่อพนักงาน..."
                  value={searchName}
                  onChange={(e) => setSearchName(e.target.value)}
                  className="pl-9 pr-4 py-2 rounded-lg border border-surface-300 bg-white text-sm w-56"
                />
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="mx-6 mt-4 px-4 py-3 rounded-lg bg-red-50 text-red-800 text-sm border border-red-200">
            {error}
          </div>
        )}
        {successMessage && (
          <div className="mx-6 mt-4 px-4 py-3 rounded-lg bg-emerald-50 text-emerald-800 text-sm border border-emerald-200">
            {successMessage}
          </div>
        )}

        {activeTab === 'calendar' && (
          <div className="mx-6 mt-4 mb-4 rounded-xl border border-surface-200 bg-surface-50/70 p-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h3 className="text-sm font-semibold text-surface-800">ปฏิทินลา</h3>
                <p className="text-xs text-surface-600">
                  วันนี้คือ{` `}
                  <span className="font-medium text-surface-800">
                    {thaiWeekdayName(today)} {today.toLocaleDateString('th-TH')}
                  </span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                {/* คำอธิบายสี */}
                <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-surface-600">
                  <span className="w-3 h-3 rounded bg-emerald-100 border border-emerald-300" /> อนุมัติ
                  <span className="w-3 h-3 rounded bg-yellow-200 border border-yellow-400 ml-2" /> รออนุมัติ
                  <span className="w-3 h-3 rounded bg-sky-100 border border-sky-300 ml-2" /> วันหยุดพนักงาน
                  <span className="w-3 h-3 rounded bg-violet-100 border border-violet-300 ml-2" /> วันหยุดบริษัท
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const now = new Date()
                    setSelectedCalendarDate(now)
                    setCalendarMonth(new Date(now.getFullYear(), now.getMonth(), 1))
                  }}
                  className="px-2.5 py-1 rounded-lg border border-emerald-300 bg-emerald-50 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                >
                  วันนี้
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))
                  }
                  className="px-2.5 py-1 rounded-lg border border-surface-300 bg-white text-xs text-surface-700 hover:bg-surface-100"
                >
                  เดือนก่อน
                </button>
                <div className="min-w-[130px] text-center text-xs font-semibold text-surface-800">
                  {monthYearLabel}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))
                  }
                  className="px-2.5 py-1 rounded-lg border border-surface-300 bg-white text-xs text-surface-700 hover:bg-surface-100"
                >
                  เดือนถัดไป
                </button>
              </div>
            </div>

            <div className="mt-3 flex flex-col lg:flex-row gap-3">
              {/* ปฏิทิน (ซ้าย) */}
              <div className="flex-1 min-w-0">
                <div className="grid grid-cols-7 gap-1.5">
                  {WEEKDAY_LABELS.map((day) => (
                    <div key={day} className="rounded bg-surface-100 px-1 py-1.5 text-center text-xs font-semibold text-surface-600">
                      {day}
                    </div>
                  ))}
                  {calendarCells.map((cell) => {
                    const hasPending = cell.leaves.some((r) => r.status === 'pending')
                    const shownLeaves = cell.leaves.slice(0, 3)
                    const shownDayOffs = cell.dayOffs.slice(0, 2)
                    const hiddenCount =
                      cell.leaves.length - shownLeaves.length + (cell.dayOffs.length - shownDayOffs.length)
                    return (
                    <button
                      type="button"
                      key={cell.key}
                      onClick={() => {
                        setSelectedCalendarDate(new Date(cell.date))
                        if (!cell.inMonth) {
                          setCalendarMonth(new Date(cell.date.getFullYear(), cell.date.getMonth(), 1))
                        }
                      }}
                      aria-label={`ดูรายการลาและวันหยุด ${cell.date.toLocaleDateString('th-TH')}`}
                      aria-pressed={cell.key === selectedDateKey}
                      className={`min-h-[96px] rounded-lg border p-1.5 text-left transition-colors hover:border-emerald-400 hover:bg-emerald-50/60 ${
                        cell.inMonth
                          ? hasPending
                            ? 'bg-yellow-50 border-yellow-300'
                            : cell.holiday
                              ? 'bg-violet-50/60 border-violet-200'
                              : 'bg-white border-surface-200'
                          : 'bg-surface-50 border-surface-100 text-surface-400'
                      } ${cell.key === selectedDateKey ? 'ring-2 ring-emerald-500 border-emerald-400' : ''} ${
                        cell.isToday && cell.key !== selectedDateKey ? 'ring-1 ring-emerald-300' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-sm font-semibold ${cell.isToday ? 'text-emerald-700' : 'text-surface-700'}`}>
                          {cell.date.getDate()}
                        </span>
                        {cell.inMonth && (cell.leaves.length > 0 || cell.dayOffs.length > 0) && (
                          <span className="flex items-center gap-1">
                            {cell.leaves.length > 0 && (
                              <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-emerald-100 text-emerald-700 font-medium">
                                {cell.leaves.length}
                              </span>
                            )}
                            {cell.dayOffs.length > 0 && (
                              <span
                                className="text-[10px] rounded-full px-1.5 py-0.5 bg-sky-100 text-sky-700 font-medium"
                                title={`วันหยุดพนักงาน ${cell.dayOffs.length} คน`}
                              >
                                {cell.dayOffs.length}
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                      <div className="space-y-0.5">
                        {cell.holiday && (
                          <div
                            className="rounded px-1.5 py-0.5 text-[11px] leading-tight truncate bg-violet-100 text-violet-800 font-medium"
                            title={`วันหยุดบริษัท · ${cell.holiday.name}`}
                          >
                            {cell.holiday.name}
                          </div>
                        )}
                        {shownLeaves.map((req) => (
                          <div
                            key={`${cell.key}-${req.id}`}
                            className={`rounded px-1.5 py-0.5 text-[11px] leading-tight truncate ${
                              req.status === 'approved'
                                ? 'bg-emerald-50 text-emerald-800'
                                : 'bg-yellow-200 text-yellow-900 font-medium'
                            }`}
                            title={`ลา · ${employeeDisplayName(req)} · ${statusLabel(req.status)}`}
                          >
                            {employeeDisplayName(req)}
                          </div>
                        ))}
                        {shownDayOffs.map((entry) => (
                          <div
                            key={`${cell.key}-off-${entry.id}`}
                            className="rounded px-1.5 py-0.5 text-[11px] leading-tight truncate bg-sky-50 text-sky-800"
                            title={`วันหยุด · ${employeeName(employeeById[entry.employee_id])}${entry.note ? ` · ${entry.note}` : ''}`}
                          >
                            {employeeName(employeeById[entry.employee_id])}
                          </div>
                        ))}
                        {hiddenCount > 0 && (
                          <div className="text-[10px] text-surface-500">+ อีก {hiddenCount}</div>
                        )}
                      </div>
                    </button>
                    )
                  })}
                </div>
              </div>

              {/* รายการลา + วันหยุดของวันที่เลือก (ขวา) */}
              <div className="lg:w-80 flex-shrink-0 space-y-3">
                <div className="rounded-lg border border-surface-200 bg-white p-3">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h4 className="text-sm font-semibold text-surface-800">
                        {isSelectedToday ? 'รายการลาวันนี้' : 'รายการลาวันที่เลือก'}
                      </h4>
                      <p className="text-[11px] text-surface-500">
                        {thaiWeekdayName(selectedCalendarDate)} {selectedCalendarDate.toLocaleDateString('th-TH')}
                      </p>
                    </div>
                    <span className="text-xs rounded-full px-2.5 py-0.5 bg-emerald-100 text-emerald-700 font-semibold">
                      {selectedDateLeaves.length} คนลา
                    </span>
                  </div>
                  {selectedDateLeaves.length === 0 ? (
                    <p className="text-sm text-surface-500 py-6 text-center">
                      {isSelectedToday ? 'ไม่มีผู้ลาวันนี้' : 'ไม่มีผู้ลาในวันที่เลือก'}
                    </p>
                  ) : (
                    <ul className="space-y-2.5">
                      {selectedDateLeaves.map((r) => {
                        const time = leaveTimeRange(r)
                        const isHourly = r.leave_mode === 'hourly'
                        const spansMultipleDays = r.start_date !== r.end_date
                        return (
                        <li
                          key={`${selectedDateKey}-${r.id}`}
                          className={`rounded-lg border ${
                            r.status === 'approved'
                              ? 'bg-emerald-50 border-emerald-100'
                              : 'bg-yellow-50 border-yellow-200'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setDetailRequest(r)}
                            className="w-full px-3 py-2.5 text-left"
                            aria-label={`ดูรายละเอียดใบลาของ ${employeeDisplayName(r)}`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-surface-800 truncate">{employeeDisplayName(r)}</div>
                                <div className="text-xs text-surface-500 truncate">{employeePositionName(r)}</div>
                              </div>
                              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                isHourly ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'
                              }`}>
                                {isHourly ? 'ลาช่วงเวลา' : 'ลาทั้งวัน'}
                              </span>
                            </div>

                            <div className="mt-2 border-t border-black/5 pt-2 space-y-1.5">
                              <div className="flex items-center justify-between gap-2 text-xs">
                                <span className="font-medium text-surface-700 truncate">{r.leave_type?.name || 'ไม่ระบุประเภทลา'}</span>
                                <span className="shrink-0 text-surface-500">{statusLabel(r.status)}</span>
                              </div>
                              <div className="flex items-center gap-1.5 text-xs text-surface-700">
                                {isHourly ? <FiClock className="shrink-0 text-blue-600" /> : <FiCalendar className="shrink-0 text-emerald-600" />}
                                <span className="font-medium">{time ?? 'เต็มวัน'}</span>
                                <span className="text-surface-400">·</span>
                                <span>{calendarLeaveDuration(r)}</span>
                              </div>
                              {spansMultipleDays && (
                                <div className="flex items-center gap-1.5 text-[11px] text-surface-500">
                                  <FiCalendar className="shrink-0" />
                                  <span>{compactThaiDate(r.start_date)} – {compactThaiDate(r.end_date)}</span>
                                </div>
                              )}
                              {r.reason && (
                                <p className="line-clamp-2 text-[11px] leading-relaxed text-surface-500" title={r.reason}>
                                  เหตุผล: {r.reason}
                                </p>
                              )}
                              <div className="pt-0.5 text-right text-[10px] font-medium text-emerald-700">ดูรายละเอียดเพิ่มเติม</div>
                            </div>
                          </button>
                        </li>
                        )
                      })}
                    </ul>
                  )}
                </div>

                {/* วันหยุดของพนักงาน — แยกการ์ดออกจากรายการลา */}
                <div className="rounded-lg border border-sky-200 bg-white p-3">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h4 className="text-sm font-semibold text-sky-800">
                        {isSelectedToday ? 'วันหยุดพนักงานวันนี้' : 'วันหยุดพนักงานวันที่เลือก'}
                      </h4>
                      <p className="text-[11px] text-surface-500">
                        {thaiWeekdayName(selectedCalendarDate)} {selectedCalendarDate.toLocaleDateString('th-TH')}
                      </p>
                    </div>
                    <span className="text-xs rounded-full px-2.5 py-0.5 bg-sky-100 text-sky-700 font-semibold">
                      {selectedDateDayOffs.length} คนหยุด
                    </span>
                  </div>

                  {selectedDateHoliday && (
                    <div className="mb-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
                      <div className="text-[11px] font-medium text-violet-600">วันหยุดบริษัท</div>
                      <div className="text-sm font-medium text-violet-900 truncate">{selectedDateHoliday.name}</div>
                    </div>
                  )}

                  {selectedDateDayOffs.length === 0 ? (
                    <p className="text-sm text-surface-500 py-6 text-center">
                      {selectedDateHoliday ? 'ไม่มีวันหยุดกำหนดพิเศษรายบุคคล' : 'ไม่มีวันหยุดในวันที่เลือก'}
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {selectedDateDayOffs.map((entry) => (
                        <li
                          key={`${selectedDateKey}-off-${entry.id}`}
                          className="rounded-lg px-3 py-2 border bg-sky-50 border-sky-100"
                        >
                          <div className="text-sm font-medium text-surface-800 truncate">
                            {employeeName(employeeById[entry.employee_id])}
                          </div>
                          <div className="text-xs text-surface-500 truncate">
                            {entry.note || employeeById[entry.employee_id]?.position?.name || 'วันหยุดตามที่กำหนด'}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'calendar' ? null : loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-10 w-10 border-2 border-surface-300 border-t-emerald-600" />
          </div>
        ) : activeTab === 'ot' ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-surface-50 border-b border-surface-200">
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">พนักงาน</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">วันที่ทำ OT</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ช่วงเวลา</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ชั่วโมง (hh:mm)</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">เหตุผล</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">สถานะ</th>
                  {canApproveOT && (
                    <th className="px-6 py-3 text-sm font-semibold text-surface-700">ดำเนินการ</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {filteredOtRequests.length === 0 ? (
                  <tr>
                    <td colSpan={canApproveOT ? 7 : 6} className="px-6 py-12 text-center text-surface-500 text-sm">
                      ไม่มีคำขอ OT
                    </td>
                  </tr>
                ) : (
                  filteredOtRequests.map((req) => (
                    <tr key={req.id} className="border-b border-surface-100 hover:bg-emerald-50/50 transition-colors">
                      <td className="px-6 py-3 text-sm text-surface-800">{otEmployeeName(req)}</td>
                      <td className="px-6 py-3 text-sm text-surface-700">
                        {asDateOnly(req.request_date).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </td>
                      <td className="px-6 py-3 text-sm text-surface-700">
                        {req.ot_start.slice(0, 5)} – {req.ot_end.slice(0, 5)} น.
                      </td>
                      <td className="px-6 py-3 text-sm text-surface-700 font-mono">{hoursToHHMM(req.hours)}</td>
                      <td className="px-6 py-3 text-sm text-surface-700 max-w-[240px] truncate" title={req.reason ?? ''}>
                        {req.reason ?? '-'}
                        {req.reject_reason && (
                          <div className="text-xs text-red-500 truncate" title={req.reject_reason}>
                            เหตุผลไม่อนุมัติ: {req.reject_reason}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium border ${statusBadgeClass(req.status)}`}>
                          {req.status === 'pending' ? 'รออนุมัติ' : statusLabel(req.status)}
                        </span>
                      </td>
                      {canApproveOT && (
                        <td className="px-6 py-3">
                          {req.status === 'pending' ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleApproveOT(req.id)}
                                disabled={actionLoading}
                                className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
                              >
                                อนุมัติ
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setOtRejectingId(req.id)
                                  setRejectReason('')
                                  setError(null)
                                }}
                                disabled={actionLoading}
                                className="px-3 py-1.5 rounded-lg bg-red-100 text-red-700 text-sm font-medium hover:bg-red-200 disabled:opacity-50"
                              >
                                ไม่อนุมัติ
                              </button>
                            </div>
                          ) : (
                            <span className="text-surface-400 text-sm">-</span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : activeTab === 'wfh' ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead><tr className="bg-surface-50 border-b border-surface-200">
                <th className="px-6 py-3 text-sm font-semibold text-surface-700">พนักงาน</th>
                <th className="px-6 py-3 text-sm font-semibold text-surface-700">วันที่เริ่ม–สิ้นสุด</th>
                <th className="px-6 py-3 text-sm font-semibold text-surface-700">ช่วงเวลา</th>
                <th className="px-6 py-3 text-sm font-semibold text-surface-700">เหตุผล</th>
                <th className="px-6 py-3 text-sm font-semibold text-surface-700">สถานะ</th>
                <th className="px-6 py-3 text-sm font-semibold text-surface-700">ผู้อนุมัติ</th>
                {canApproveOT && <th className="px-6 py-3 text-sm font-semibold text-surface-700">ดำเนินการ</th>}
              </tr></thead>
              <tbody>
                {filteredWfhRequests.length === 0 ? <tr><td colSpan={canApproveOT ? 7 : 6} className="px-6 py-12 text-center text-surface-500 text-sm">ไม่มีคำขอ WFH</td></tr> : filteredWfhRequests.map((req) => (
                  <tr key={req.id} className="border-b border-surface-100 hover:bg-emerald-50/50 transition-colors">
                    <td className="px-6 py-3 text-sm text-surface-800">{employeeName(req.employee)}</td>
                    <td className="px-6 py-3 text-sm text-surface-700">{req.start_date} – {req.end_date}</td>
                    <td className="px-6 py-3 text-sm text-surface-700">{req.start_time && req.end_time ? `${req.start_time.slice(0, 5)} – ${req.end_time.slice(0, 5)} น.` : 'ตามตารางงาน'}</td>
                    <td className="px-6 py-3 text-sm text-surface-700 max-w-[260px]" title={req.reason}><div className="truncate">{req.reason || '-'}</div>{req.reject_reason && <div className="text-xs text-red-500 truncate">เหตุผลไม่อนุมัติ: {req.reject_reason}</div>}</td>
                    <td className="px-6 py-3"><span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium border ${statusBadgeClass(req.status)}`}>{req.status === 'pending' ? 'รออนุมัติ' : statusLabel(req.status)}</span></td>
                    <td className="px-6 py-3 text-sm text-surface-700">{req.approver ? [req.approver.first_name, req.approver.last_name].filter(Boolean).join(' ') || '-' : '-'}</td>
                    {canApproveOT && <td className="px-6 py-3">{req.status === 'pending' ? <div className="flex gap-2"><button type="button" disabled={actionLoading} onClick={() => handleWFHStatus(req.id, 'approved')} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium disabled:opacity-50">อนุมัติ</button><button type="button" disabled={actionLoading} onClick={() => handleWFHStatus(req.id, 'rejected')} className="px-3 py-1.5 rounded-lg bg-red-100 text-red-700 text-sm font-medium disabled:opacity-50">ไม่อนุมัติ</button></div> : <span className="text-surface-400">-</span>}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : activeTab === 'list' ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-surface-50 border-b border-surface-200">
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">พนักงาน</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ประเภทลา</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">วันที่เริ่ม-สิ้นสุด</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">จำนวนวัน (dd:hh:mm)</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">เหตุผล</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">วันลาคงเหลือ</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">สถานะ</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ผู้อนุมัติ</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ใบรับรองแพทย์</th>
                </tr>
              </thead>
              <tbody>
                {filteredRequests.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-6 py-12 text-center text-surface-500 text-sm">
                      ไม่มีรายการ
                    </td>
                  </tr>
                ) : (
                  filteredRequests.map((req) => (
                    <tr
                      key={req.id}
                      onClick={() => setDetailRequest(req)}
                      className="border-b border-surface-100 hover:bg-emerald-50/50 cursor-pointer transition-colors"
                    >
                      <td className="px-6 py-3 text-sm text-surface-800">{employeeDisplayName(req)}</td>
                      <td className="px-6 py-3 text-sm text-surface-700">
                        {(req.leave_type as { name?: string })?.name ?? '-'}
                      </td>
                      <td className="px-6 py-3 text-sm text-surface-700">
                        {req.start_date} – {req.end_date}
                      </td>
                      <td className="px-6 py-3 text-sm text-surface-700 font-mono whitespace-nowrap">{leaveDurationDDHHMM(req)}</td>
                      <td className="px-6 py-3 text-sm text-surface-700 max-w-[200px] truncate" title={req.reason ?? ''}>
                        {req.reason ?? '-'}
                      </td>
                      <td className="px-6 py-3 text-xs text-surface-700">
                        {(() => {
                          const rows = getLeaveBalanceRows(req.employee_id, req.start_date)
                          const main = rows.filter((r) => isMainLeaveType(r.name))
                          return (
                            <div className="flex items-center gap-2 flex-wrap">
                              <span>
                                {main.length
                                  ? main.map((r) => `${r.name}: ${r.remaining}`).join(' | ')
                                  : '-'}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setBalanceView({ name: employeeDisplayName(req), rows })
                                }}
                                className="text-emerald-600 hover:underline whitespace-nowrap"
                              >
                                ดูทั้งหมด
                              </button>
                            </div>
                          )
                        })()}
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={`inline-flex max-w-full items-center justify-center whitespace-nowrap px-2.5 py-1 rounded-full text-xs leading-5 font-medium border ${statusBadgeClass(req.status)}`}
                        >
                          {statusLabel(req.status)}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-sm text-surface-700 whitespace-nowrap">
                        {approverDisplayName(req)}
                      </td>
                      <td className="px-6 py-3">
                        {req.medical_cert_url ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              openMedicalCert(req.medical_cert_url)
                            }}
                            className="inline-flex items-center gap-1 text-emerald-600 hover:underline text-sm"
                          >
                            <FiExternalLink className="w-4 h-4" /> ดูไฟล์
                          </button>
                        ) : (
                          <span className="text-surface-400 text-sm">-</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-surface-50 border-b border-surface-200">
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">พนักงาน</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ประเภทลา</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">วันที่เริ่ม-สิ้นสุด</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">จำนวนวัน (dd:hh:mm)</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">เหตุผล</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ใบรับรองแพทย์</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ดำเนินการ</th>
                </tr>
              </thead>
              <tbody>
                {filteredRequests.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-surface-500 text-sm">
                      ไม่มีคำขอที่รอดำเนินการ
                    </td>
                  </tr>
                ) : (
                  filteredRequests.map((req) => (
                    <tr key={req.id} className="border-b border-surface-100 hover:bg-emerald-50/50 transition-colors">
                      <td className="px-6 py-3 text-sm font-medium text-surface-800 whitespace-nowrap">
                        {employeeDisplayName(req)}
                      </td>
                      <td className="px-6 py-3 text-sm text-surface-700 whitespace-nowrap">
                        {(req.leave_type as { name?: string })?.name ?? '-'}
                      </td>
                      <td className="px-6 py-3 text-sm text-surface-700 whitespace-nowrap">
                        {req.start_date} – {req.end_date}
                      </td>
                      <td className="px-6 py-3 text-sm text-surface-700 font-mono whitespace-nowrap">{leaveDurationDDHHMM(req)}</td>
                      <td className="px-6 py-3 text-sm text-surface-700 max-w-[260px] truncate" title={req.reason ?? ''}>
                        {req.reason ?? '-'}
                      </td>
                      <td className="px-6 py-3">
                        {req.medical_cert_url ? (
                          <button
                            type="button"
                            onClick={() => openMedicalCert(req.medical_cert_url)}
                            className="inline-flex items-center gap-1 text-emerald-600 hover:underline text-sm whitespace-nowrap"
                          >
                            <FiExternalLink className="w-4 h-4" /> ดูไฟล์
                          </button>
                        ) : (
                          <span className="text-surface-400 text-sm">-</span>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-2 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => handleApprove(req.id)}
                            disabled={actionLoading}
                            className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
                          >
                            อนุมัติ
                          </button>
                          <button
                            type="button"
                            onClick={() => openRejectModal(req.id)}
                            disabled={actionLoading}
                            className="px-3 py-1.5 rounded-lg bg-red-100 text-red-700 text-sm font-medium hover:bg-red-200 disabled:opacity-50"
                          >
                            ไม่อนุมัติ
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* นำเข้าใบลาย้อนหลัง */}
      <LeaveImport open={showImport} onClose={() => setShowImport(false)} onImported={loadData} />

      {/* Detail modal */}
      <Modal
        open={!!detailRequest}
        onClose={() => setDetailRequest(null)}
        contentClassName="max-w-lg"
        closeOnBackdropClick
      >
        {detailRequest && (
          <div className="p-6">
            <h3 className="text-lg font-semibold text-surface-800 mb-4">รายละเอียดคำขอลา</h3>
            <div className="space-y-3 text-sm">
              <p><span className="text-surface-500">พนักงาน:</span> {employeeDisplayName(detailRequest)}</p>
              <p><span className="text-surface-500">ประเภทลา:</span> {(detailRequest.leave_type as { name?: string })?.name ?? '-'}</p>
              <p><span className="text-surface-500">วันที่:</span> {detailRequest.start_date} – {detailRequest.end_date}</p>
              {leaveTimeRange(detailRequest) && (
                <p><span className="text-surface-500">ช่วงเวลา:</span> <span className="font-mono">{leaveTimeRange(detailRequest)}</span></p>
              )}
              <p><span className="text-surface-500">จำนวนวัน (dd:hh:mm):</span> <span className="font-mono">{leaveDurationDDHHMM(detailRequest)}</span></p>
              <p><span className="text-surface-500">เหตุผล:</span> {detailRequest.reason ?? '-'}</p>
              <p>
                <span className="text-surface-500">สถานะ:</span>{' '}
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border ${statusBadgeClass(detailRequest.status)}`}>
                  {statusLabel(detailRequest.status)}
                </span>
              </p>
              {detailRequest.reject_reason && (
                <p><span className="text-surface-500">เหตุผลไม่อนุมัติ:</span> {detailRequest.reject_reason}</p>
              )}
              {detailRequest.medical_cert_url && (
                <p>
                  <button
                    type="button"
                    onClick={() => openMedicalCert(detailRequest.medical_cert_url)}
                    className="text-emerald-600 hover:underline inline-flex items-center gap-1"
                  >
                    <FiFileText className="w-4 h-4" /> เปิดเอกสารแนบ
                  </button>
                </p>
              )}
            </div>
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => setDetailRequest(null)}
                className="px-4 py-2 rounded-lg bg-surface-100 text-surface-700 hover:bg-surface-200 text-sm font-medium"
              >
                ปิด
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Reject reason modal */}
      <Modal
        open={!!rejectingId}
        onClose={closeRejectModal}
        contentClassName="max-w-md"
        closeOnBackdropClick
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold text-surface-800 mb-2">เหตุผลในการไม่อนุมัติ</h3>
          <p className="text-sm text-surface-600 mb-4">กรุณาระบุเหตุผล (จำเป็น)</p>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="เหตุผล..."
            rows={4}
            className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm text-surface-800 placeholder:text-surface-400"
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={closeRejectModal}
              className="px-4 py-2 rounded-lg bg-surface-100 text-surface-700 hover:bg-surface-200 text-sm font-medium"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={handleReject}
              disabled={actionLoading || !rejectReason.trim()}
              className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50"
            >
              ยืนยันไม่อนุมัติ
            </button>
          </div>
        </div>
      </Modal>

      {/* OT reject reason modal */}
      <Modal
        open={!!otRejectingId}
        onClose={() => {
          setOtRejectingId(null)
          setRejectReason('')
        }}
        contentClassName="max-w-md"
        closeOnBackdropClick
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold text-surface-800 mb-2">เหตุผลในการไม่อนุมัติ OT</h3>
          <p className="text-sm text-surface-600 mb-4">กรุณาระบุเหตุผล (จำเป็น)</p>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="เหตุผล..."
            rows={4}
            className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm text-surface-800 placeholder:text-surface-400"
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => {
                setOtRejectingId(null)
                setRejectReason('')
              }}
              className="px-4 py-2 rounded-lg bg-surface-100 text-surface-700 hover:bg-surface-200 text-sm font-medium"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={handleRejectOT}
              disabled={actionLoading || !rejectReason.trim()}
              className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50"
            >
              ยืนยันไม่อนุมัติ
            </button>
          </div>
        </div>
      </Modal>

      {/* วันลาคงเหลือทั้งหมด */}
      <Modal
        open={!!balanceView}
        onClose={() => setBalanceView(null)}
        contentClassName="max-w-md"
        closeOnBackdropClick
      >
        {balanceView && (
          <div className="p-6">
            <h3 className="text-lg font-semibold text-surface-800 mb-1">วันลาคงเหลือทั้งหมด</h3>
            <p className="text-sm text-surface-500 mb-4">{balanceView.name}</p>
            <div className="overflow-hidden rounded-lg border border-surface-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-50 text-surface-600">
                    <th className="px-4 py-2 text-left font-semibold">ประเภทลา</th>
                    <th className="px-4 py-2 text-center font-semibold">สิทธิ์</th>
                    <th className="px-4 py-2 text-center font-semibold">ใช้ไป</th>
                    <th className="px-4 py-2 text-center font-semibold">คงเหลือ</th>
                  </tr>
                </thead>
                <tbody>
                  {balanceView.rows.map((r) => (
                    <tr key={r.id} className="border-t border-surface-100">
                      <td className="px-4 py-2 text-surface-800">{r.name}</td>
                      <td className="px-4 py-2 text-center text-surface-600">{r.entitled || '-'}</td>
                      <td className="px-4 py-2 text-center text-surface-600">{r.used}</td>
                      <td className="px-4 py-2 text-center font-semibold text-emerald-700">{r.remaining}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setBalanceView(null)}
                className="px-4 py-2 rounded-lg bg-surface-100 text-surface-700 hover:bg-surface-200 text-sm font-medium"
              >
                ปิด
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
