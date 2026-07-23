import { useState, useEffect, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FiBell, FiCalendar, FiClock, FiFileText, FiCheckCircle, FiXCircle, FiUser, FiX } from 'react-icons/fi'
import type { IconType } from 'react-icons'
import {
  fetchEmployeeByUserId,
  getEmployeeLeaveSummary,
  fetchNotifications,
  fetchAllApprovalResultNotifications,
  markNotificationRead,
  fetchLeaveRequests,
  fetchOTRequests,
  updateLeaveRequest,
  updateOTRequest,
  fetchWFHRequests,
  updateWFHRequest,
  getHRFileUrl,
} from '../../../lib/hrApi'
import { supabase } from '../../../lib/supabase'
import { useAuthContext } from '../../../contexts/AuthContext'
import Modal from '../../ui/Modal'
import type { HREmployee, HRNotification, HRLeaveRequest, HROTRequest, HRWFHRequest } from '../../../types'

/** รายการรออนุมัติที่จับคู่กับแจ้งเตือนได้ (ลา หรือ OT) */
type ApprovalTarget =
  | { kind: 'leave'; req: HRLeaveRequest }
  | { kind: 'ot'; req: HROTRequest }
  | { kind: 'wfh'; req: HRWFHRequest }

/** ชื่อแสดงผลของพนักงานเจ้าของคำขอ */
function reqEmpName(e?: HREmployee | { first_name?: string; last_name?: string; nickname?: string } | null): string {
  if (!e) return '-'
  const full = [e.first_name, e.last_name].filter(Boolean).join(' ')
  return e.nickname ? `${full} (${e.nickname})` : full || '-'
}

const BUCKET_PHOTOS = 'hr-photos'

/** photo_url อาจเป็น URL เต็ม หรือเป็น path ใน storage — คืน URL ที่แสดงได้ */
function photoDisplayUrl(photoUrl: string | undefined): string | null {
  if (!photoUrl) return null
  if (photoUrl.startsWith('http')) return photoUrl
  return getHRFileUrl(BUCKET_PHOTOS, photoUrl)
}

/** ประเภทลาหลักที่โชว์ในการ์ดหน้าหลัก (ที่เหลือดูใน popup) */
const MAIN_LEAVE_KEYWORDS = ['กิจ', 'ป่วย', 'พักร้อน'] as const
const isMainLeaveType = (name: string) => MAIN_LEAVE_KEYWORDS.some((k) => name.includes(k))

/** true = รออนุมัติ, false = ผลอนุมัติ/อื่นๆ */
const isPendingNotif = (type: string) => type.includes('pending')

/** ผลอนุมัติจากหัวข้อแจ้งเตือน: อนุมัติ / ปฏิเสธ / null */
function resultStatus(title: string): 'approved' | 'rejected' | null {
  if (title.includes('ปฏิเสธ') || title.includes('ไม่อนุมัติ')) return 'rejected'
  if (title.includes('อนุมัติ')) return 'approved'
  return null
}

/** ไอคอน + สีตามประเภทแจ้งเตือน */
function notifIcon(type: string): { Icon: IconType; color: string; bg: string } {
  if (type.includes('medical')) return { Icon: FiFileText, color: 'text-amber-600', bg: 'bg-amber-100' }
  if (type.includes('ot')) return { Icon: FiClock, color: 'text-indigo-600', bg: 'bg-indigo-100' }
  if (type.includes('leave')) return { Icon: FiCalendar, color: 'text-emerald-600', bg: 'bg-emerald-100' }
  if (type.includes('result')) return { Icon: FiCheckCircle, color: 'text-emerald-600', bg: 'bg-emerald-100' }
  return { Icon: FiBell, color: 'text-gray-500', bg: 'bg-gray-100' }
}

function formatTimeAgo(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffMins < 1) return 'เมื่อสักครู่'
  if (diffMins < 60) return `${diffMins} นาทีที่แล้ว`
  if (diffHours < 24) return `${diffHours} ชม. ที่แล้ว`
  if (diffDays < 7) return `${diffDays} วันที่แล้ว`
  return d.toLocaleDateString('th-TH')
}

function toLocalDateInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export default function EmployeeDashboard() {
  const { user } = useAuthContext()
  const [employee, setEmployee] = useState<HREmployee | null>(null)
  const [loading, setLoading] = useState(true)
  const [leaveSummary, setLeaveSummary] = useState<{
    balances: { leave_type_name: string; remaining: number; entitled_days: number; used_days: number }[]
  } | null>(null)
  const [notifications, setNotifications] = useState<HRNotification[]>([])
  const [showAllBalance, setShowAllBalance] = useState(false)
  const [photoError, setPhotoError] = useState(false)
  const [showPhoto, setShowPhoto] = useState(false)
  const [notifTab, setNotifTab] = useState<'pending' | 'result'>('result')
  const [resultStartDate, setResultStartDate] = useState(() => {
    const date = new Date()
    date.setDate(date.getDate() - 29)
    return toLocalDateInput(date)
  })
  const [resultEndDate, setResultEndDate] = useState(() => toLocalDateInput(new Date()))
  const [resultTypeFilter, setResultTypeFilter] = useState<'all' | 'leave' | 'ot' | 'wfh'>('all')
  const [resultStatusFilter, setResultStatusFilter] = useState<'all' | 'approved' | 'rejected'>('all')
  const [resultVisibleCount, setResultVisibleCount] = useState(30)
  const [searchParams] = useSearchParams()
  /** id คำขอลา/OT ที่ยังรออนุมัติจริง — ใช้ซ่อนแจ้งเตือน "รออนุมัติ" ที่ถูกอนุมัติ/ปฏิเสธไปแล้ว */
  const [pendingRequestIds, setPendingRequestIds] = useState<Set<string>>(new Set())
  /** related_id → คำขอที่ยังรออนุมัติ (สำหรับโชว์ชื่อผู้ขอ + อนุมัติจากมือถือ) */
  const [pendingById, setPendingById] = useState<Map<string, ApprovalTarget>>(new Map())
  /** related_id → คำขอที่ใช้แสดงชื่อผู้ขอ/ผู้อนุมัติในแท็บผลอนุมัติ */
  const [resultById, setResultById] = useState<Map<string, ApprovalTarget>>(new Map())
  /** สิทธิ์อนุมัติจากมือถือ: เฉพาะ superadmin / admin / hr */
  const canApprove = ['superadmin', 'admin', 'hr'].includes(user?.role ?? '')
  const [approvalTarget, setApprovalTarget] = useState<ApprovalTarget | null>(null)
  const [rejectMode, setRejectMode] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [actionBusy, setActionBusy] = useState(false)

  const load = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    try {
      const emp = await fetchEmployeeByUserId(user.id)
      setEmployee(emp)
      if (!emp) {
        setLoading(false)
        return
      }
      const [summary, ownNotifs, allResultNotifs, leavePending, otPending, wfhPending, resultLeave, resultOt, resultWFH] = await Promise.all([
        getEmployeeLeaveSummary(emp.id, new Date().getFullYear()),
        fetchNotifications(emp.id),
        canApprove ? fetchAllApprovalResultNotifications() : Promise.resolve([]),
        // คำขอที่รออนุมัติ (ทั้งหมด) — โชว์เฉพาะเมื่อมีสิทธิ์อนุมัติ
        canApprove ? fetchLeaveRequests({ status: 'pending' }).catch(() => []) : Promise.resolve([]),
        canApprove ? fetchOTRequests({ status: 'pending' }).catch(() => []) : Promise.resolve([]),
        canApprove ? fetchWFHRequests({ status: 'pending' }).catch(() => []) : Promise.resolve([]),
        // ผู้มีสิทธิ์เห็นผลของทุกคน ส่วนพนักงานทั่วไปเห็นเฉพาะของตัวเอง
        fetchLeaveRequests(canApprove ? undefined : { employee_id: emp.id }).catch(() => []),
        fetchOTRequests(canApprove ? undefined : { employee_id: emp.id }).catch(() => []),
        fetchWFHRequests(canApprove ? undefined : { employee_id: emp.id }).catch(() => []),
      ])
      setLeaveSummary(summary)
      const mergedNotifications = new Map<string, HRNotification>()
      ;[...ownNotifs, ...allResultNotifs].forEach((n) => mergedNotifications.set(n.id, n))
      setNotifications(
        [...mergedNotifications.values()]
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, 300),
      )
      setPendingRequestIds(new Set([...leavePending.map((r) => r.id), ...otPending.map((r) => r.id), ...wfhPending.map((r) => r.id)]))
      const pMap = new Map<string, ApprovalTarget>()
      leavePending.forEach((r) => pMap.set(r.id, { kind: 'leave', req: r }))
      otPending.forEach((r) => pMap.set(r.id, { kind: 'ot', req: r }))
      wfhPending.forEach((r) => pMap.set(r.id, { kind: 'wfh', req: r }))
      setPendingById(pMap)
      const resultMap = new Map<string, ApprovalTarget>()
      resultLeave.forEach((r) => resultMap.set(r.id, { kind: 'leave', req: r }))
      resultOt.forEach((r) => resultMap.set(r.id, { kind: 'ot', req: r }))
      resultWFH.forEach((r) => resultMap.set(r.id, { kind: 'wfh', req: r }))
      setResultById(resultMap)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [user?.id, canApprove])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    setResultVisibleCount(30)
  }, [resultStartDate, resultEndDate, resultTypeFilter, resultStatusFilter])

  // กดกระดิ่งจาก header → เปิดแท็บผลอนุมัติ
  useEffect(() => {
    if (searchParams.get('notif') === 'result') setNotifTab('result')
  }, [searchParams])

  const handleMarkRead = async (id: string) => {
    try {
      await markNotificationRead(id)
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)))
    } catch (e) {
      console.error(e)
    }
  }

  /** กดรายการแจ้งเตือน: ถ้าเป็น "รออนุมัติ" และมีสิทธิ์ → เปิดหน้าอนุมัติ, ไม่งั้นแค่ mark read */
  const handleNotifClick = (n: HRNotification) => {
    const target = n.related_id ? pendingById.get(n.related_id) : undefined
    if (canApprove && isPendingNotif(n.type) && target) {
      setRejectMode(false)
      setRejectReason('')
      setApprovalTarget(target)
    } else if (!n.is_read && n.employee_id === employee?.id) {
      handleMarkRead(n.id)
    }
  }

  const closeApproval = () => {
    setApprovalTarget(null)
    setRejectMode(false)
    setRejectReason('')
  }

  const submitDecision = async (decision: 'approved' | 'rejected') => {
    if (!approvalTarget || !employee) return
    if (decision === 'rejected' && !rejectReason.trim()) return
    const requestLabel = approvalTarget.kind === 'leave' ? 'คำขอลา' : approvalTarget.kind === 'ot' ? 'คำขอ OT' : 'คำขอ WFH'
    const requester = reqEmpName(approvalTarget.req.employee)
    const confirmed = window.confirm(
      decision === 'approved'
        ? `ยืนยันอนุมัติ${requestLabel}ของ ${requester} ใช่หรือไม่?`
        : `ยืนยันไม่อนุมัติ${requestLabel}ของ ${requester} ใช่หรือไม่?`,
    )
    if (!confirmed) return
    setActionBusy(true)
    try {
      const now = new Date().toISOString()
      if (approvalTarget.kind === 'leave') {
        await updateLeaveRequest(approvalTarget.req.id, {
          status: decision,
          approved_by: employee.id,
          ...(decision === 'approved' ? { approved_at: now } : { reject_reason: rejectReason.trim() }),
        })
        supabase.functions
          .invoke('hr-leave-request-notify', { body: { leave_id: approvalTarget.req.id, event: decision } })
          .catch(() => {})
      } else if (approvalTarget.kind === 'ot') {
        await updateOTRequest(approvalTarget.req.id, {
          status: decision,
          approved_by: employee.id,
          ...(decision === 'approved' ? { approved_at: now } : { reject_reason: rejectReason.trim() }),
        })
        supabase.functions
          .invoke('hr-ot-notify', { body: { ot_id: approvalTarget.req.id, event: decision } })
          .catch(() => {})
      } else {
        await updateWFHRequest(approvalTarget.req.id, {
          status: decision,
          approved_by: employee.id,
          ...(decision === 'approved'
            ? { approved_at: now, reject_reason: undefined }
            : { reject_reason: rejectReason.trim() }),
        })
      }
      closeApproval()
      await load()
    } catch (e) {
      console.error(e)
      alert('ดำเนินการไม่สำเร็จ — อาจไม่มีสิทธิ์ หรือคำขอถูกดำเนินการไปแล้ว')
    } finally {
      setActionBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-emerald-500 border-t-transparent" />
      </div>
    )
  }

  if (!employee) {
    return (
      <div className="rounded-2xl bg-white p-6 shadow-sm text-center text-gray-500">
        ไม่พบข้อมูลพนักงานที่เชื่อมกับบัญชีนี้
      </div>
    )
  }

  const displayName = employee.nickname || employee.first_name || 'คุณ'
  const photoUrl = photoDisplayUrl(employee.photo_url)

  return (
    <div className="space-y-6">
      <section className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-gray-900 mb-1">สวัสดี คุณ{displayName}</h2>
          <p className="text-gray-500 text-sm">ยินดีต้อนรับเข้าทีม ขอให้วันนี้เป็นวันที่ดี</p>
        </div>
        <div className="shrink-0">
          {photoUrl && !photoError ? (
            <button
              type="button"
              onClick={() => setShowPhoto(true)}
              className="block rounded-full ring-2 ring-emerald-100 shadow-sm overflow-hidden"
            >
              <img
                src={photoUrl}
                alt={displayName}
                onError={() => setPhotoError(true)}
                className="w-14 h-14 rounded-full object-cover"
              />
            </button>
          ) : (
            <span className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center ring-2 ring-emerald-100 shadow-sm">
              <FiUser className="w-7 h-7" />
            </span>
          )}
        </div>
      </section>

      <section className="rounded-2xl bg-emerald-50 border border-emerald-100 p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm text-emerald-700 font-semibold">วันลาคงเหลือ</p>
          {(leaveSummary?.balances?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => setShowAllBalance(true)}
              className="text-xs text-emerald-700 font-medium underline"
            >
              ดูทั้งหมด
            </button>
          )}
        </div>
        {leaveSummary?.balances?.length ? (
          <div className="grid grid-cols-3 gap-2">
            {leaveSummary.balances
              .filter((b) => isMainLeaveType(b.leave_type_name))
              .map((b) => (
                <div key={b.leave_type_name} className="rounded-xl bg-white/70 px-2 py-2 text-center">
                  <p className="text-[11px] text-emerald-700 leading-tight">{b.leave_type_name}</p>
                  <p className="text-xl font-bold text-emerald-800">{b.remaining}</p>
                  <p className="text-[10px] text-emerald-600/70">วัน</p>
                </div>
              ))}
          </div>
        ) : (
          <p className="text-sm text-emerald-600">ยังไม่มีข้อมูลสิทธิ์การลา</p>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-900 flex items-center gap-2">
            <FiBell className="w-5 h-5 text-emerald-600" />
            แจ้งเตือน
          </h3>
        </div>

        {/* แถบ รออนุมัติ / ผลอนุมัติ — แท็บรออนุมัติซ่อนรายการที่อนุมัติ/ปฏิเสธไปแล้ว */}
        {(() => {
          const isResultNotification = (n: HRNotification) => n.type.includes('result')
          const matchesResultFilters = (n: HRNotification) => {
            if (!isResultNotification(n)) return false
            const date = toLocalDateInput(new Date(n.created_at))
            if (resultStartDate && date < resultStartDate) return false
            if (resultEndDate && date > resultEndDate) return false
            if (resultTypeFilter !== 'all' && !n.type.includes(resultTypeFilter)) return false
            if (resultStatusFilter !== 'all' && resultStatus(n.title) !== resultStatusFilter) return false
            return true
          }
          const pendingList = notifications.filter(
            (n) => isPendingNotif(n.type) && (!n.related_id || pendingRequestIds.has(n.related_id)),
          )
          const filteredResultList = notifications.filter(matchesResultFilters)
          return (
        <>
        <div className="flex gap-2 mb-3">
          {([
            ['pending', 'รออนุมัติ'],
            ['result', 'ผลอนุมัติ'],
          ] as [typeof notifTab, string][]).map(([key, label]) => {
            const count = key === 'pending' ? pendingList.length : filteredResultList.length
            return (
              <button
                key={key}
                type="button"
                onClick={() => setNotifTab(key)}
                className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
                  notifTab === key
                    ? 'bg-emerald-600 text-white'
                    : 'bg-white text-gray-600 border border-gray-200'
                }`}
              >
                {label} {count > 0 && `(${count})`}
              </button>
            )
          })}
        </div>

        {notifTab === 'result' && (
          <div className="mb-3 rounded-2xl border border-gray-200 bg-white p-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-gray-500">
                ตั้งแต่วันที่
                <input
                  type="date"
                  value={resultStartDate}
                  max={resultEndDate || undefined}
                  onChange={(e) => setResultStartDate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-xs text-gray-700"
                />
              </label>
              <label className="text-xs text-gray-500">
                ถึงวันที่
                <input
                  type="date"
                  value={resultEndDate}
                  min={resultStartDate || undefined}
                  onChange={(e) => setResultEndDate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-xs text-gray-700"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={resultTypeFilter}
                onChange={(e) => setResultTypeFilter(e.target.value as typeof resultTypeFilter)}
                className="rounded-lg border border-gray-200 px-2 py-2 text-xs text-gray-700"
                aria-label="กรองประเภทคำขอ"
              >
                <option value="all">ทุกประเภท</option>
                <option value="leave">การลา</option>
                <option value="ot">OT</option>
                <option value="wfh">WFH</option>
              </select>
              <select
                value={resultStatusFilter}
                onChange={(e) => setResultStatusFilter(e.target.value as typeof resultStatusFilter)}
                className="rounded-lg border border-gray-200 px-2 py-2 text-xs text-gray-700"
                aria-label="กรองสถานะผลอนุมัติ"
              >
                <option value="all">ทุกสถานะ</option>
                <option value="approved">อนุมัติ</option>
                <option value="rejected">ปฏิเสธ</option>
              </select>
            </div>
          </div>
        )}

        <div className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
          {(() => {
            const completeList = notifTab === 'pending' ? pendingList : filteredResultList
            const list = notifTab === 'result' ? completeList.slice(0, resultVisibleCount) : completeList
            if (list.length === 0) {
              return <p className="p-4 text-center text-gray-500 text-sm">ไม่มีรายการ</p>
            }
            return (
              <>
              <ul className="divide-y divide-gray-100">
                {list.map((n) => {
                  const { Icon, color, bg } = notifIcon(n.type)
                  const pendingT = n.related_id ? pendingById.get(n.related_id) : undefined
                  const resultT = n.related_id ? resultById.get(n.related_id) : undefined
                  const actionable = canApprove && isPendingNotif(n.type) && !!pendingT
                  // ชื่อผู้ขอ: แท็บรออนุมัติดึงจากคำขอที่รออยู่, แท็บผลอนุมัติดึงจากคำขอของตัวเอง
                  const requesterName = pendingT
                    ? reqEmpName(pendingT.req.employee)
                    : resultT
                      ? reqEmpName(resultT.req.employee)
                      : null
                  // ชื่อผู้ดำเนินการ (แท็บผลอนุมัติ)
                  const actorName =
                    !isPendingNotif(n.type) && resultT?.req.approver ? reqEmpName(resultT.req.approver) : null
                  const actorLabel = resultStatus(n.title) === 'rejected' ? 'ผู้ปฏิเสธ' : 'ผู้อนุมัติ'
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => handleNotifClick(n)}
                        className={`w-full text-left p-4 active:bg-gray-50 ${!n.is_read ? 'bg-emerald-50/50' : ''}`}
                      >
                        <div className="flex items-start gap-3">
                          <span className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${bg}`}>
                            <Icon className={`w-5 h-5 ${color}`} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              {!n.is_read && <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />}
                              <p className="font-medium text-gray-900 text-sm">{n.title}</p>
                            </div>
                            {requesterName && (
                              <p className="text-gray-700 text-xs mt-0.5">
                                ผู้ขอ: <span className="font-medium">{requesterName}</span>
                              </p>
                            )}
                            {n.message && <p className="text-gray-600 text-xs mt-0.5 line-clamp-2">{n.message}</p>}
                            {actorName && (
                              <p className="text-gray-500 text-xs mt-0.5">{actorLabel}: {actorName}</p>
                            )}
                            <p className="text-gray-400 text-xs mt-1">{formatTimeAgo(n.created_at)}</p>
                          </div>
                          {(() => {
                            if (actionable) {
                              return (
                                <span className="shrink-0 self-start inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-600 text-white">
                                  อนุมัติ ›
                                </span>
                              )
                            }
                            const st = resultStatus(n.title)
                            if (!st) return null
                            return (
                              <span
                                className={`shrink-0 self-start inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                                  st === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                                }`}
                              >
                                {st === 'approved' ? (
                                  <><FiCheckCircle className="w-3.5 h-3.5" /> อนุมัติ</>
                                ) : (
                                  <><FiXCircle className="w-3.5 h-3.5" /> ปฏิเสธ</>
                                )}
                              </span>
                            )
                          })()}
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
              {notifTab === 'result' && resultVisibleCount < completeList.length && (
                <div className="border-t border-gray-100 p-3 text-center">
                  <button
                    type="button"
                    onClick={() => setResultVisibleCount((count) => count + 30)}
                    className="rounded-xl border border-emerald-200 px-5 py-2 text-sm font-medium text-emerald-700 active:bg-emerald-50"
                  >
                    ดูเพิ่มเติม ({completeList.length - resultVisibleCount} รายการ)
                  </button>
                </div>
              )}
              </>
            )
          })()}
        </div>
        </>
          )
        })()}
      </section>

      <section>
        <h3 className="font-semibold text-gray-900 mb-3">ดำเนินการด่วน</h3>
        <div className="grid grid-cols-2 gap-3">
          <Link
            to="/employee?tab=leave"
            className="flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 text-white py-4 px-4 shadow-md active:bg-emerald-700"
          >
            <FiCalendar className="w-6 h-6" />
            <span className="font-medium">ขอลา</span>
          </Link>
          <Link
            to="/employee?tab=timeclock"
            className="flex items-center justify-center gap-2 rounded-2xl bg-white border-2 border-emerald-600 text-emerald-600 py-4 px-4 shadow-sm active:bg-emerald-50"
          >
            <FiClock className="w-6 h-6" />
            <span className="font-medium">ลงเวลา</span>
          </Link>
        </div>
      </section>

      {/* อนุมัติ/ปฏิเสธ จากมือถือ (เฉพาะ superadmin/admin/hr) */}
      <Modal open={!!approvalTarget} onClose={closeApproval} closeOnBackdropClick contentClassName="max-w-sm">
        {approvalTarget && (
          <div className="relative p-5">
            <button
              type="button"
              onClick={closeApproval}
              aria-label="ปิดหน้าต่างอนุมัติ"
              className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full text-gray-400 active:bg-gray-100 active:text-gray-700"
            >
              <FiX className="h-5 w-5" />
            </button>
            <h3 className="mb-3 pr-10 text-lg font-semibold text-gray-800">
              {approvalTarget.kind === 'leave' ? 'อนุมัติการลา' : approvalTarget.kind === 'ot' ? 'อนุมัติคำขอ OT' : 'อนุมัติคำขอ WFH'}
            </h3>
            <div className="space-y-1.5 text-sm text-gray-700">
              <p>ผู้ขอ: <span className="font-medium">{reqEmpName(approvalTarget.req.employee)}</span></p>
              {approvalTarget.kind === 'leave' ? (
                <>
                  <p>ประเภท: {(approvalTarget.req.leave_type as { name?: string })?.name ?? '-'}</p>
                  <p>วันที่: {approvalTarget.req.start_date} – {approvalTarget.req.end_date} ({approvalTarget.req.total_days} วัน)</p>
                  {approvalTarget.req.reason && <p>เหตุผล: {approvalTarget.req.reason}</p>}
                </>
              ) : approvalTarget.kind === 'ot' ? (
                <>
                  <p>วันที่: {approvalTarget.req.request_date}</p>
                  <p>ช่วงเวลา: {approvalTarget.req.ot_start?.slice(0, 5)} – {approvalTarget.req.ot_end?.slice(0, 5)} น.{approvalTarget.req.hours ? ` (${approvalTarget.req.hours} ชม.)` : ''}</p>
                  {approvalTarget.req.reason && <p>เหตุผล: {approvalTarget.req.reason}</p>}
                </>
              ) : (
                <>
                  <p>วันที่: {approvalTarget.req.start_date} – {approvalTarget.req.end_date}</p>
                  <p>เหตุผล: {approvalTarget.req.reason}</p>
                </>
              )}
            </div>

            {rejectMode ? (
              <div className="mt-4">
                <label className="block text-sm text-gray-600 mb-1">เหตุผลที่ไม่อนุมัติ (จำเป็น)</label>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
                  placeholder="ระบุเหตุผล…"
                />
                <div className="flex gap-2 mt-3">
                  <button
                    type="button"
                    onClick={() => { setRejectMode(false); setRejectReason('') }}
                    className="flex-1 py-2.5 rounded-xl border border-gray-300 text-gray-600 text-sm font-medium"
                  >
                    ย้อนกลับ
                  </button>
                  <button
                    type="button"
                    onClick={() => submitDecision('rejected')}
                    disabled={actionBusy || !rejectReason.trim()}
                    className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-medium disabled:opacity-40"
                  >
                    ยืนยันไม่อนุมัติ
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2 mt-5">
                <button
                  type="button"
                  onClick={() => setRejectMode(true)}
                  disabled={actionBusy}
                  className="flex-1 py-2.5 rounded-xl bg-red-100 text-red-700 text-sm font-medium active:bg-red-200 disabled:opacity-40"
                >
                  ไม่อนุมัติ
                </button>
                <button
                  type="button"
                  onClick={() => submitDecision('approved')}
                  disabled={actionBusy}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-medium active:bg-emerald-700 disabled:opacity-40"
                >
                  {actionBusy ? 'กำลังบันทึก…' : 'อนุมัติ'}
                </button>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* รูปพนักงานแบบเต็ม */}
      <Modal
        open={showPhoto}
        onClose={() => setShowPhoto(false)}
        contentClassName="max-w-md"
        closeOnBackdropClick
      >
        <div className="relative p-2">
          <button
            type="button"
            onClick={() => setShowPhoto(false)}
            aria-label="ปิด"
            className="absolute top-3 right-3 z-10 w-9 h-9 rounded-full bg-black/50 text-white flex items-center justify-center active:bg-black/70"
          >
            <FiX className="w-5 h-5" />
          </button>
          <button type="button" onClick={() => setShowPhoto(false)} className="block w-full">
            <img
              src={photoUrl ?? undefined}
              alt={displayName}
              className="w-full max-h-[75vh] object-contain rounded-xl"
            />
          </button>
        </div>
      </Modal>

      {/* วันลาคงเหลือทั้งหมด */}
      <Modal
        open={showAllBalance}
        onClose={() => setShowAllBalance(false)}
        contentClassName="max-w-sm"
        closeOnBackdropClick
      >
        <div className="p-5">
          <h3 className="text-lg font-semibold text-gray-800 mb-3">วันลาคงเหลือทั้งหมด</h3>
          <div className="overflow-hidden rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-600">
                  <th className="px-3 py-2 text-left font-semibold">ประเภทลา</th>
                  <th className="px-3 py-2 text-center font-semibold">ใช้</th>
                  <th className="px-3 py-2 text-center font-semibold">คงเหลือ</th>
                </tr>
              </thead>
              <tbody>
                {(leaveSummary?.balances ?? []).map((b) => (
                  <tr key={b.leave_type_name} className="border-t border-gray-100">
                    <td className="px-3 py-2 text-gray-800">{b.leave_type_name}</td>
                    <td className="px-3 py-2 text-center text-gray-600">{b.used_days ?? 0}</td>
                    <td className="px-3 py-2 text-center font-semibold text-emerald-700">{b.remaining}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={() => setShowAllBalance(false)}
            className="mt-4 w-full py-2.5 rounded-xl bg-emerald-600 text-white font-medium active:bg-emerald-700"
          >
            ปิด
          </button>
        </div>
      </Modal>
    </div>
  )
}
