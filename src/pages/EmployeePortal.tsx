import { lazy, Suspense, useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuthContext } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { fetchEmployeeByUserId, fetchNotifications } from '../lib/hrApi'
import { FiHome, FiClock, FiCalendar, FiTrendingUp, FiBookOpen, FiFileText, FiBox, FiAward, FiBell, FiSmartphone, FiMapPin } from 'react-icons/fi'

const EmployeeDashboard = lazy(() => import('../components/hr/employee/EmployeeDashboard'))
const EmployeeTimeClock = lazy(() => import('../components/hr/employee/EmployeeTimeClock'))
const EmployeeLeave = lazy(() => import('../components/hr/employee/EmployeeLeave'))
const EmployeeSalaryPath = lazy(() => import('../components/hr/employee/EmployeeSalaryPath'))
const EmployeeOnboarding = lazy(() => import('../components/hr/employee/EmployeeOnboarding'))
const EmployeeDocuments = lazy(() => import('../components/hr/employee/EmployeeDocuments'))
const EmployeeAssets = lazy(() => import('../components/hr/employee/EmployeeAssets'))
const EmployeeWarningsCerts = lazy(() => import('../components/hr/employee/EmployeeWarningsCerts'))
const AdminClockLocationsMobile = lazy(() => import('../components/hr/employee/AdminClockLocationsMobile'))
import ModeSwitchButton from '../components/ModeSwitchButton'

const Loading = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" />
  </div>
)

const MOBILE_MAX_WIDTH = 1024

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
  { id: 'timeclock', label: 'ลงเวลา', icon: FiClock, Component: EmployeeTimeClock },
  { id: 'leave', label: 'ขอลา', icon: FiCalendar, Component: EmployeeLeave },
  { id: 'warnings-certs', label: 'เตือน/รับรอง', icon: FiAward, Component: EmployeeWarningsCerts },
  { id: 'assets', label: 'ทรัพย์สิน', icon: FiBox, Component: EmployeeAssets },
  { id: 'documents', label: 'เอกสาร', icon: FiFileText, Component: EmployeeDocuments },
  { id: 'salary', label: 'เส้นทาง', icon: FiTrendingUp, Component: EmployeeSalaryPath },
  { id: 'onboarding', label: 'Onboarding', icon: FiBookOpen, Component: EmployeeOnboarding },
] as const

/** แท็บพิเศษของ superadmin — ดึงพิกัด GPS จากมือถือไปตั้งเป็นจุดพิกัดออฟฟิศ */
const ADMIN_TABS = [
  { id: 'admin-gps', label: 'พิกัด GPS', icon: FiMapPin, Component: AdminClockLocationsMobile },
] as const

const ALL_TABS = [...TABS, ...ADMIN_TABS]
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
  const visibleTabs: readonly TabDef[] = user?.role === 'superadmin' ? ALL_TABS : TABS
  /** จำนวนแจ้งเตือนผลอนุมัติ (อนุมัติ/ปฏิเสธ) ที่ยังไม่อ่าน — โชว์บนกระดิ่ง */
  const [resultUnread, setResultUnread] = useState(0)

  useEffect(() => {
    const t = searchParams.get('tab')
    if (t && TAB_IDS.includes(t as (typeof TAB_IDS)[number])) setActiveTab(t as TabId)
  }, [searchParams])

  // นับแจ้งเตือนผลอนุมัติที่ยังไม่อ่าน (เรียลไทม์)
  useEffect(() => {
    if (!user?.id) return
    let channel: ReturnType<typeof supabase.channel> | null = null
    let cancelled = false
    fetchEmployeeByUserId(user.id).then((emp) => {
      if (!emp || cancelled) return
      const loadCount = () =>
        fetchNotifications(emp.id, true)
          .then((list) => setResultUnread(list.filter((n) => n.type.includes('result')).length))
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

  const setActiveTabAndUrl = (id: TabId) => {
    setActiveTab(id)
    setSearchParams(id === 'dashboard' ? {} : { tab: id })
  }

  const openResultNotifications = () => {
    setActiveTab('dashboard')
    setSearchParams({ notif: 'result' })
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
            aria-label="แจ้งเตือนผลอนุมัติ"
          >
            <FiBell className="w-5 h-5" />
            {resultUnread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">
                {resultUnread > 99 ? '99+' : resultUnread}
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
              className={`flex flex-col items-center justify-center gap-0.5 w-[19%] min-w-[19%] flex-shrink-0 py-2 px-1 rounded-lg transition-colors ${
                isActive ? 'text-emerald-600 bg-emerald-50' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              <Icon className="w-6 h-6" />
              <span className="text-[11px] font-medium whitespace-nowrap">{tab.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
