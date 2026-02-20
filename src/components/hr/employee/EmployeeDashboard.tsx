import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { FiBell, FiCalendar, FiTrendingUp } from 'react-icons/fi'
import {
  fetchEmployeeByUserId,
  getHRDashboard,
  getEmployeeLeaveSummary,
  fetchNotifications,
  markNotificationRead,
  fetchOnboardingPlans,
} from '../../../lib/hrApi'
import { useAuthContext } from '../../../contexts/AuthContext'
import type { HREmployee, HRNotification } from '../../../types'

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
    balances: { leave_type_name: string; remaining: number; entitled_days: number }[]
  } | null>(null)
  const [notifications, setNotifications] = useState<HRNotification[]>([])
  const [activeOnboarding, setActiveOnboarding] = useState(false)

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
      const [dash, summary, notifs, plans] = await Promise.all([
        getHRDashboard(emp.id),
        getEmployeeLeaveSummary(emp.id, new Date().getFullYear()),
        fetchNotifications(emp.id).then((n) => n.slice(0, 10)),
        fetchOnboardingPlans({ employee_id: emp.id, status: 'in_progress' }),
      ])
      setDashboard(dash)
      setLeaveSummary(summary)
      setNotifications(notifs)
      setActiveOnboarding(Array.isArray(plans) && plans.length > 0)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    load()
  }, [load])

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
        <h2 className="text-xl font-semibold text-gray-900 mb-1">สวัสดี, {displayName}</h2>
        <p className="text-gray-500 text-sm">ยินดีต้อนรับสู่พอร์ทัลพนักงาน</p>
      </section>

      <section className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-4">
          <p className="text-xs text-emerald-700 font-medium mb-1">วันลาคงเหลือ</p>
          {leaveSummary?.balances?.length ? (
            <p className="text-lg font-bold text-emerald-800">
              {leaveSummary.balances.reduce((s, b) => s + (b.remaining ?? 0), 0)} วัน
            </p>
          ) : (
            <p className="text-sm text-emerald-600">-</p>
          )}
        </div>
        <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
          <p className="text-xs text-gray-600 font-medium mb-1">สถานะ Onboarding</p>
          <p className={`text-sm font-semibold ${activeOnboarding ? 'text-emerald-600' : 'text-gray-500'}`}>
            {activeOnboarding ? 'กำลังดำเนินการ' : 'ไม่มีแผน'}
          </p>
        </div>
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
        <div className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
          {notifications.length === 0 ? (
            <p className="p-4 text-center text-gray-500 text-sm">ไม่มีแจ้งเตือน</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {notifications.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => handleMarkRead(n.id)}
                    className={`w-full text-left p-4 active:bg-gray-50 ${!n.is_read ? 'bg-emerald-50/50' : ''}`}
                  >
                    <div className="flex items-start gap-2">
                      {!n.is_read && (
                        <span className="mt-1.5 w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-gray-900 text-sm">{n.title}</p>
                        {n.message && <p className="text-gray-600 text-xs mt-0.5 line-clamp-2">{n.message}</p>}
                        <p className="text-gray-400 text-xs mt-1">{formatTimeAgo(n.created_at)}</p>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
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
            to="/employee?tab=salary"
            className="flex items-center justify-center gap-2 rounded-2xl bg-white border-2 border-emerald-600 text-emerald-600 py-4 px-4 shadow-sm active:bg-emerald-50"
          >
            <FiTrendingUp className="w-6 h-6" />
            <span className="font-medium">ดูเส้นทางเงินเดือน</span>
          </Link>
        </div>
      </section>
    </div>
  )
}
