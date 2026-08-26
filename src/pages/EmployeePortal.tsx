import { lazy, Suspense, useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuthContext } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { fetchAnnouncements, fetchCertificates, fetchEmployeeByUserId, fetchNotifications, fetchMyAnnouncementReads, fetchMyUnreadAnnouncementCount, fetchTasks, fetchWarnings, markNotificationRead } from '../lib/hrApi'
import { pickPendingHRDocuments } from '../lib/hrDocumentAlert'
import { FiHome, FiClock, FiCalendar, FiTrendingUp, FiBookOpen, FiFileText, FiBox, FiAward, FiBell, FiSmartphone, FiMapPin, FiWifi, FiBriefcase, FiMessageSquare, FiTarget } from 'react-icons/fi'
import type { HRAnnouncement, HRCertificate, HREmployee, HRNotification, HRWarning } from '../types'

const EmployeeDashboard = lazy(() => import('../components/hr/employee/EmployeeDashboard'))
const EmployeeTasks = lazy(() => import('../components/hr/employee/EmployeeTasks'))
const EmployeeTimeClock = lazy(() => import('../components/hr/employee/EmployeeTimeClock'))
const EmployeeLeave = lazy(() => import('../components/hr/employee/EmployeeLeave'))
const EmployeeLeaveCalendar = lazy(() => import('../components/hr/employee/EmployeeLeaveCalendar'))
const EmployeeWorkCalendar = lazy(() => import('../components/hr/employee/EmployeeWorkCalendar'))
const EmployeeWFH = lazy(() => import('../components/hr/employee/EmployeeWFH'))
const EmployeeWorkScore = lazy(() => import('../components/hr/employee/EmployeeWorkScore'))
const EmployeeSalaryPath = lazy(() => import('../components/hr/employee/EmployeeSalaryPath'))
const EmployeeOnboarding = lazy(() => import('../components/hr/employee/EmployeeOnboarding'))
const EmployeeDocuments = lazy(() => import('../components/hr/employee/EmployeeDocuments'))
const EmployeeAssets = lazy(() => import('../components/hr/employee/EmployeeAssets'))
const EmployeeWarningsCerts = lazy(() => import('../components/hr/employee/EmployeeWarningsCerts'))
const EmployeeRequests = lazy(() => import('../components/hr/employee/EmployeeRequests'))
const AdminClockLocationsMobile = lazy(() => import('../components/hr/employee/AdminClockLocationsMobile'))
import ModeSwitchButton from '../components/ModeSwitchButton'

const Loading = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" />
  </div>
)

const MOBILE_MAX_WIDTH = 1024
const MY_OPEN_TASK_STATUSES = ['new', 'acknowledged', 'in_progress', 'review', 'revision', 'paused'] as const

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= MOBILE_MAX_WIDTH)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    setIsMobile(mq.matches)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return isMobile
}

function DesktopBlockScreen() {
  const { signOut } = useAuthContext()
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-50 to-emerald-100 p-6">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md text-center space-y-5">
        <div className="mx-auto w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center">
          <FiSmartphone className="w-10 h-10 text-emerald-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-800">สำหรับมือถือเท่านั้น</h1>
        <p className="text-gray-500 leading-relaxed">
          ระบบ Employee Portal ออกแบบมาสำหรับใช้งานบนมือถือ
          กรุณาเปิดจากมือถือของคุณเพื่อเข้าใช้งาน
        </p>
        <div className="pt-2">
          <button
            type="button"
            onClick={() => signOut()}
            className="px-6 py-2.5 bg-emerald-600 text-white rounded-xl font-medium hover:bg-emerald-700 transition-colors"
          >
            ออกจากระบบ
          </button>
        </div>
      </div>
    </div>
  )
}

const TABS = [
  { id: 'dashboard', label: 'หน้าหลัก', icon: FiHome, Component: EmployeeDashboard },
  { id: 'tasks', label: 'งาน', icon: FiBriefcase, Component: EmployeeTasks },
  { id: 'timeclock', label: 'ลงเวลา', icon: FiClock, Component: EmployeeTimeClock },
  { id: 'leave', label: 'ขอลา', icon: FiCalendar, Component: EmployeeLeave },
  { id: 'calendar', label: 'ตารางงาน', icon: FiCalendar, Component: EmployeeWorkCalendar },
  { id: 'work-score', label: 'คะแนน', icon: FiTarget, Component: EmployeeWorkScore },
  { id: 'wfh', label: 'ขอ WFH', icon: FiWifi, Component: EmployeeWFH },
  { id: 'warnings-certs', label: 'เตือน/รับรอง', icon: FiAward, Component: EmployeeWarningsCerts },
  { id: 'assets', label: 'ทรัพย์สิน', icon: FiBox, Component: EmployeeAssets },
  { id: 'requests', label: 'คำร้อง', icon: FiMessageSquare, Component: EmployeeRequests },
  { id: 'documents', label: 'เอกสาร', icon: FiFileText, Component: EmployeeDocuments },
  { id: 'salary', label: 'เส้นทาง', icon: FiTrendingUp, Component: EmployeeSalaryPath },
  { id: 'onboarding', label: 'Onboarding', icon: FiBookOpen, Component: EmployeeOnboarding },
] as const

/** ปฏิทินลาทั้งบริษัท — เห็นได้เฉพาะ superadmin / admin / account (ตรงกับสิทธิ์ RPC get_leave_calendar) */
const LEAVE_CALENDAR_TABS = [
  { id: 'leave-calendar', label: 'ปฏิทินลา', icon: FiCalendar, Component: EmployeeLeaveCalendar },
] as const
const LEAVE_CALENDAR_ROLES = ['superadmin', 'admin', 'account']

/** แท็บพิเศษของ superadmin — ดึงพิกัด GPS จากมือถือไปตั้งเป็นจุดพิกัดออฟฟิศ */
const ADMIN_TABS = [
  { id: 'admin-gps', label: 'พิกัด GPS', icon: FiMapPin, Component: AdminClockLocationsMobile },
] as const

const ALL_TABS = [...TABS, ...LEAVE_CALENDAR_TABS, ...ADMIN_TABS]
type TabDef = (typeof ALL_TABS)[number]
type TabId = TabDef['id']

const TAB_IDS = ALL_TABS.map((t) => t.id)

export default function EmployeePortal() {
  const isMobile = useIsMobile()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabFromUrl = searchParams.get('tab')
  const [activeTab, setActiveTab] = useState<TabId>(
    (tabFromUrl && TAB_IDS.includes(tabFromUrl as (typeof TAB_IDS)[number])) ? (tabFromUrl as TabId) : 'dashboard'
  )
  const { user, signOut } = useAuthContext()
  const [portalEmployee, setPortalEmployee] = useState<HREmployee | null>(null)
  const canViewLeaveCalendar = LEAVE_CALENDAR_ROLES.includes(user?.role ?? '')
  // แท็บ "ปฏิทินลา" แทรกต่อจาก "ขอลา" — เฉพาะ role ที่มีสิทธิ์ดูใบลาทั้งบริษัท
  const employeeTabs = TABS.filter((tab) => tab.id !== 'wfh' || portalEmployee?.work_mode === 'hybrid')
    .flatMap<TabDef>((tab) => (tab.id === 'leave' && canViewLeaveCalendar ? [tab, ...LEAVE_CALENDAR_TABS] : [tab]))
  const visibleTabs: readonly TabDef[] = user?.role === 'superadmin' ? [...employeeTabs, ...ADMIN_TABS] : employeeTabs
  /** จำนวนแจ้งเตือนผลอนุมัติ (อนุมัติ/ปฏิเสธ) ที่ยังไม่อ่าน — โชว์บนกระดิ่ง */
  const [resultUnread, setResultUnread] = useState(0)
  const [resultNotifications, setResultNotifications] = useState<HRNotification[]>([])
  const [taskNotifications, setTaskNotifications] = useState<HRNotification[]>([])
  /** งานที่มอบหมายให้ฉันและยังไม่เสร็จ — โชว์บนเมนูงาน */
  const [myOpenTaskCount, setMyOpenTaskCount] = useState(0)
  /** ประกาศที่ยังไม่กดรับทราบ — โชว์เป็นตัวเลขบนแท็บเอกสาร */
  const [announcementUnread, setAnnouncementUnread] = useState(0)
  const [hrDocumentUnread, setHrDocumentUnread] = useState(0)
  const [unreadAnnouncements, setUnreadAnnouncements] = useState<HRAnnouncement[]>([])
  const [unreadWarnings, setUnreadWarnings] = useState<HRWarning[]>([])
  const [unreadCertificates, setUnreadCertificates] = useState<HRCertificate[]>([])
  const [notificationOpen, setNotificationOpen] = useState(false)

  useEffect(() => {
    const t = searchParams.get('tab')
    if (t && TAB_IDS.includes(t as (typeof TAB_IDS)[number])) setActiveTab(t as TabId)
  }, [searchParams])

  useEffect(() => {
    if (!user?.id) return
    fetchEmployeeByUserId(user.id).then(setPortalEmployee).catch(() => setPortalEmployee(null))
  }, [user?.id])

  useEffect(() => {
    if (!portalEmployee?.id) return
    const loadCount = () => Promise.all([
      fetchWarnings({ employeeId: portalEmployee.id }),
      fetchCertificates({ employeeId: portalEmployee.id }),
    ]).then(([warnings, certificates]) => {
      const pending = pickPendingHRDocuments(warnings, certificates)
      setUnreadWarnings(pending.filter((entry) => entry.kind === 'warning').map((entry) => entry.item as HRWarning))
      setUnreadCertificates(pending.filter((entry) => entry.kind === 'certificate').map((entry) => entry.item as HRCertificate))
      setHrDocumentUnread(pending.length)
    }).catch(() => {})
    loadCount()
    window.addEventListener('hr-documents-changed', loadCount)
    const channel = supabase
      .channel(`employee-portal-hr-documents-${portalEmployee.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_warnings', filter: `employee_id=eq.${portalEmployee.id}` }, loadCount)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_certificates', filter: `employee_id=eq.${portalEmployee.id}` }, loadCount)
      .subscribe()
    return () => {
      window.removeEventListener('hr-documents-changed', loadCount)
      supabase.removeChannel(channel)
    }
  }, [portalEmployee?.id])

  // นับแจ้งเตือนผลอนุมัติและงานใหม่ที่ยังไม่อ่าน (เรียลไทม์)
  useEffect(() => {
    if (!user?.id) return
    let channel: ReturnType<typeof supabase.channel> | null = null
    let cancelled = false
    fetchEmployeeByUserId(user.id).then((emp) => {
      if (!emp || cancelled) return
      const loadCount = () =>
        fetchNotifications(emp.id, true)
          .then((list) => {
            const results = list.filter((n) => n.type.includes('result'))
            const newTasks = list.filter((n) => n.type === 'task_new')
            setResultNotifications(results)
            setResultUnread(results.length)
            setTaskNotifications(newTasks)
          })
          .catch(() => {})
      loadCount()
      channel = supabase
        .channel('employee-portal-notif-count')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'hr_notifications', filter: `employee_id=eq.${emp.id}` },
          loadCount,
        )
        .subscribe()
    })
    return () => {
      cancelled = true
      if (channel) supabase.removeChannel(channel)
    }
  }, [user?.id])

  // badge เมนูงานยึดสถานะงานจริง และลดลงเมื่องานเสร็จหรือถูกยกเลิก
  useEffect(() => {
    if (!portalEmployee?.id) return
    const employeeId = portalEmployee.id
    const loadCount = () => fetchTasks({ employeeId })
      .then((tasks) => setMyOpenTaskCount(tasks.filter((task) =>
        MY_OPEN_TASK_STATUSES.includes(task.status as (typeof MY_OPEN_TASK_STATUSES)[number])
        && task.participants?.some((participant) => participant.employee_id === employeeId && participant.role === 'assignee'),
      ).length))
      .catch(() => {})
    loadCount()
    window.addEventListener('hr-tasks-changed', loadCount)
    const channel = supabase
      .channel(`employee-portal-new-tasks-${employeeId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_tasks' }, loadCount)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_task_participants', filter: `employee_id=eq.${employeeId}` }, loadCount)
      .subscribe()
    return () => {
      window.removeEventListener('hr-tasks-changed', loadCount)
      supabase.removeChannel(channel)
    }
  }, [portalEmployee?.id])

  useEffect(() => {
    if (!portalEmployee?.id) return
    const loadItems = () => Promise.all([
      fetchAnnouncements(),
      fetchMyAnnouncementReads(portalEmployee.id),
    ]).then(([announcements, readIds]) => {
      const readSet = new Set(readIds)
      setUnreadAnnouncements(announcements.filter((item) => item.status === 'published' && !readSet.has(item.id)))
    }).catch(() => {})
    loadItems()
    window.addEventListener('hr-announcements-changed', loadItems)
    return () => window.removeEventListener('hr-announcements-changed', loadItems)
  }, [portalEmployee?.id])

  // นับประกาศที่ยังไม่กดรับทราบ (อัปเดตเมื่อมีประกาศใหม่เผยแพร่ หรือกดรับทราบ)
  useEffect(() => {
    if (!user?.id) return
    const loadCount = () =>
      fetchMyUnreadAnnouncementCount().then(setAnnouncementUnread).catch(() => {})
    loadCount()
    window.addEventListener('hr-announcements-changed', loadCount)
    const channel = supabase
      .channel('employee-portal-announcements')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_announcements' }, () => {
        loadCount()
        window.dispatchEvent(new Event('hr-announcements-changed'))
      })
      .subscribe()
    return () => {
      window.removeEventListener('hr-announcements-changed', loadCount)
      supabase.removeChannel(channel)
    }
  }, [user?.id])

  const setActiveTabAndUrl = (id: TabId) => {
    setActiveTab(id)
    setSearchParams(id === 'dashboard' ? {} : { tab: id })
  }

  const openResultNotifications = () => {
    setNotificationOpen((open) => !open)
  }

  const totalBellUnread = resultUnread + taskNotifications.length + announcementUnread + hrDocumentUnread

  const openNotificationTarget = (target: 'result' | 'task' | 'announcement' | 'hr-document') => {
    setNotificationOpen(false)
    if (target === 'result') {
      setActiveTab('dashboard')
      setSearchParams({ notif: 'result' })
    } else if (target === 'task') {
      setActiveTabAndUrl('tasks')
    } else if (target === 'announcement') {
      setActiveTabAndUrl('documents')
    } else {
      setActiveTabAndUrl('warnings-certs')
    }
  }

  if (!isMobile) return <DesktopBlockScreen />

  const currentTab = visibleTabs.find((t) => t.id === activeTab) ?? visibleTabs[0]
  const TabComponent = currentTab?.Component

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 pb-20">
      <header className="sticky top-0 z-30 flex items-center justify-between px-4 py-3 bg-emerald-600 text-white shadow-md">
        <div className="flex flex-col min-w-0">
          <span className="text-xs text-emerald-100/80 font-bold uppercase truncate">พนักงาน</span>
          <span className="text-sm font-black leading-tight truncate">
            {user?.username || user?.email || '---'}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={openResultNotifications}
            className="relative p-2 rounded-full bg-white/15 hover:bg-white/30"
            aria-label="การแจ้งเตือน"
          >
            <FiBell className="w-5 h-5" />
            {totalBellUnread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">
                {totalBellUnread > 99 ? '99+' : totalBellUnread}
              </span>
            )}
          </button>
          <ModeSwitchButton />
          <button
            type="button"
            onClick={() => signOut()}
            className="px-3 py-1.5 text-xs font-bold bg-red-500 text-white rounded-lg hover:bg-red-600 whitespace-nowrap"
          >
            ออกจากระบบ
          </button>
        </div>
      </header>

      {notificationOpen && (
        <div className="fixed inset-0 z-50 bg-black/40" onClick={() => setNotificationOpen(false)}>
          <div className="absolute top-[68px] left-3 right-3 max-h-[70vh] overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <h2 className="font-bold text-gray-900">การแจ้งเตือน</h2>
                <p className="text-xs text-gray-500">ยังไม่รับทราบ {totalBellUnread} รายการ</p>
              </div>
              <button type="button" onClick={() => setNotificationOpen(false)} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100">✕</button>
            </div>
            <div className="max-h-[calc(70vh-64px)] overflow-y-auto divide-y">
              {totalBellUnread === 0 && <p className="p-8 text-center text-sm text-gray-400">ไม่มีการแจ้งเตือนใหม่</p>}
              {unreadAnnouncements.map((item) => (
                <button key={`announcement-${item.id}`} type="button" onClick={() => openNotificationTarget('announcement')} className="w-full px-4 py-3 text-left hover:bg-amber-50">
                  <div className="text-xs font-semibold text-amber-600">ประกาศ</div>
                  <div className="mt-0.5 text-sm font-medium text-gray-900 line-clamp-2">{item.title}</div>
                </button>
              ))}
              {unreadWarnings.map((item) => (
                <button key={`warning-${item.id}`} type="button" onClick={() => openNotificationTarget('hr-document')} className="w-full px-4 py-3 text-left hover:bg-red-50">
                  <div className="text-xs font-semibold text-red-600">ใบเตือน · {item.warning_number}</div>
                  <div className="mt-0.5 text-sm font-medium text-gray-900 line-clamp-2">{item.subject}</div>
                </button>
              ))}
              {unreadCertificates.map((item) => (
                <button key={`certificate-${item.id}`} type="button" onClick={() => openNotificationTarget('hr-document')} className="w-full px-4 py-3 text-left hover:bg-emerald-50">
                  <div className="text-xs font-semibold text-emerald-600">ใบรับรอง · {item.certificate_number}</div>
                  <div className="mt-0.5 text-sm font-medium text-gray-900 line-clamp-2">{item.training_name}</div>
                </button>
              ))}
              {taskNotifications.map((item) => (
                <button key={`task-${item.id}`} type="button" onClick={async () => {
                  try {
                    await markNotificationRead(item.id)
                    setTaskNotifications((current) => current.filter((notification) => notification.id !== item.id))
                  } catch { /* ยังคงรายการไว้เพื่อให้ผู้ใช้ลองเปิดใหม่ได้ */ }
                  openNotificationTarget('task')
                }} className="w-full px-4 py-3 text-left hover:bg-emerald-50">
                  <div className="text-xs font-semibold text-emerald-600">งานใหม่</div>
                  <div className="mt-0.5 text-sm font-medium text-gray-900 line-clamp-2">{item.message || item.title}</div>
                </button>
              ))}
              {resultNotifications.map((item) => (
                <button key={`result-${item.id}`} type="button" onClick={() => openNotificationTarget('result')} className="w-full px-4 py-3 text-left hover:bg-blue-50">
                  <div className="text-xs font-semibold text-blue-600">ผลคำร้อง</div>
                  <div className="mt-0.5 text-sm font-medium text-gray-900 line-clamp-2">{item.title}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 overflow-auto p-4">
        <Suspense fallback={<Loading />}>
          {TabComponent && <TabComponent />}
        </Suspense>
      </main>

      <nav
        className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-start gap-0.5 py-2 px-1 bg-white border-t border-gray-200 shadow-[0_-2px_10px_rgba(0,0,0,0.08)] overflow-x-auto scrollbar-thin"
        aria-label="แท็บนำทาง"
      >
        {visibleTabs.map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTabAndUrl(tab.id)}
              className={`relative flex flex-col items-center justify-center gap-0.5 w-[19%] min-w-[19%] flex-shrink-0 py-2 px-1 rounded-lg transition-colors ${
                isActive ? 'text-emerald-600 bg-emerald-50' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              <Icon className="w-6 h-6" />
              {tab.id === 'tasks' && myOpenTaskCount > 0 && (
                <span className="absolute top-1 right-[18%] min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">
                  {myOpenTaskCount > 99 ? '99+' : myOpenTaskCount}
                </span>
              )}
              {tab.id === 'documents' && announcementUnread > 0 && (
                <span className="absolute top-1 right-[18%] min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">
                  {announcementUnread > 99 ? '99+' : announcementUnread}
                </span>
              )}
              {tab.id === 'warnings-certs' && hrDocumentUnread > 0 && (
                <span className="absolute top-1 right-[18%] min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">
                  {hrDocumentUnread > 99 ? '99+' : hrDocumentUnread}
                </span>
              )}
              <span className="text-[11px] font-medium whitespace-nowrap">{tab.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
