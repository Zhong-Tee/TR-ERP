import { useState, useEffect, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FiBell, FiCalendar, FiClock, FiFileText, FiCheckCircle } from 'react-icons/fi'
import type { IconType } from 'react-icons'
import {
  fetchEmployeeByUserId,
  getHRDashboard,
  getEmployeeLeaveSummary,
  fetchNotifications,
  markNotificationRead,
  fetchLeaveRequests,
  fetchOTRequests,
} from '../../../lib/hrApi'
import { useAuthContext } from '../../../contexts/AuthContext'
import Modal from '../../ui/Modal'
import type { HREmployee, HRNotification } from '../../../types'

/** ประเภทลาหลักที่โชว์ในการ์ดหน้าหลัก (ที่เหลือดูใน popup) */
const MAIN_LEAVE_KEYWORDS = ['กิจ', 'ป่วย', 'พักร้อน'] as const
const isMainLeaveType = (name: string) => MAIN_LEAVE_KEYWORDS.some((k) => name.includes(k))

/** true = รออนุมัติ, false = ผลอนุมัติ/อื่นๆ */
const isPendingNotif = (type: string) => type.includes('pending')

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

export default function EmployeeDashboard() {
  const { user } = useAuthContext()
  const [employee, setEmployee] = useState<HREmployee | null>(null)
  const [loading, setLoading] = useState(true)
  const [dashboard, setDashboard] = useState<{
    unread_notifications: number
  } | null>(null)
  const [leaveSummary, setLeaveSummary] = useState<{
    balances: { leave_type_name: string; remaining: number; entitled_days: number; used_days: number }[]
  } | null>(null)
  const [notifications, setNotifications] = useState<HRNotification[]>([])
  const [showAllBalance, setShowAllBalance] = useState(false)
  const [notifTab, setNotifTab] = useState<'pending' | 'result'>('result')
  const [searchParams] = useSearchParams()
  /** id คำขอลา/OT ที่ยังรออนุมัติจริง — ใช้ซ่อนแจ้งเตือน "รออนุมัติ" ที่ถูกอนุมัติ/ปฏิเสธไปแล้ว */
  const [pendingRequestIds, setPendingRequestIds] = useState<Set<string>>(new Set())

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
      const [dash, summary, notifs, leavePending, otPending] = await Promise.all([
        getHRDashboard(emp.id),
        getEmployeeLeaveSummary(emp.id, new Date().getFullYear()),
        fetchNotifications(emp.id).then((n) => n.slice(0, 30)),
        fetchLeaveRequests({ status: 'pending' }).catch(() => []),
        fetchOTRequests({ status: 'pending' }).catch(() => []),
      ])
      setDashboard(dash)
      setLeaveSummary(summary)
      setNotifications(notifs)
      setPendingRequestIds(new Set([...leavePending.map((r) => r.id), ...otPending.map((r) => r.id)]))
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    load()
  }, [load])

  // กดกระดิ่งจาก header → เปิดแท็บผลอนุมัติ
  useEffect(() => {
    if (searchParams.get('notif') === 'result') setNotifTab('result')
  }, [searchParams])

  const handleMarkRead = async (id: string) => {
    try {
      await markNotificationRead(id)
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)))
      setDashboard((d) => (d ? { ...d, unread_notifications: Math.max(0, (d.unread_notifications ?? 0) - 1) } : null))
    } catch (e) {
      console.error(e)
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

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-1">สวัสดี คุณ{displayName}</h2>
        <p className="text-gray-500 text-sm">ยินดีต้อนรับเข้าทีม ขอให้วันนี้เป็นวันที่ดี</p>
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
          {dashboard && (dashboard.unread_notifications ?? 0) > 0 && (
            <span className="rounded-full bg-emerald-500 text-white text-xs font-bold min-w-[20px] h-5 flex items-center justify-center px-1.5">
              {dashboard.unread_notifications}
            </span>
          )}
        </div>

        {/* แถบ รออนุมัติ / ผลอนุมัติ — แท็บรออนุมัติซ่อนรายการที่อนุมัติ/ปฏิเสธไปแล้ว */}
        {(() => {
          const inTab = (n: HRNotification, tab: 'pending' | 'result') =>
            tab === 'pending'
              ? isPendingNotif(n.type) && (!n.related_id || pendingRequestIds.has(n.related_id))
              : !isPendingNotif(n.type)
          return (
        <>
        <div className="flex gap-2 mb-3">
          {([
            ['pending', 'รออนุมัติ'],
            ['result', 'ผลอนุมัติ'],
          ] as [typeof notifTab, string][]).map(([key, label]) => {
            const count = notifications.filter((n) => inTab(n, key)).length
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

        <div className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
          {(() => {
            const list = notifications.filter((n) => inTab(n, notifTab))
            if (list.length === 0) {
              return <p className="p-4 text-center text-gray-500 text-sm">ไม่มีรายการ</p>
            }
            return (
              <ul className="divide-y divide-gray-100">
                {list.map((n) => {
                  const { Icon, color, bg } = notifIcon(n.type)
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => handleMarkRead(n.id)}
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
                            {n.message && <p className="text-gray-600 text-xs mt-0.5 line-clamp-2">{n.message}</p>}
                            <p className="text-gray-400 text-xs mt-1">{formatTimeAgo(n.created_at)}</p>
                          </div>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
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
