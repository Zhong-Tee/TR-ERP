import { lazy, Suspense, useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuthContext } from '../contexts/AuthContext'
import { FiHome, FiCalendar, FiTrendingUp, FiBookOpen, FiFileText, FiBell, FiSmartphone } from 'react-icons/fi'

const EmployeeDashboard = lazy(() => import('../components/hr/employee/EmployeeDashboard'))
const EmployeeLeave = lazy(() => import('../components/hr/employee/EmployeeLeave'))
const EmployeeSalaryPath = lazy(() => import('../components/hr/employee/EmployeeSalaryPath'))
const EmployeeOnboarding = lazy(() => import('../components/hr/employee/EmployeeOnboarding'))
const EmployeeDocuments = lazy(() => import('../components/hr/employee/EmployeeDocuments'))

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
  { id: 'leave', label: 'ขอลา', icon: FiCalendar, Component: EmployeeLeave },
  { id: 'salary', label: 'เส้นทาง', icon: FiTrendingUp, Component: EmployeeSalaryPath },
  { id: 'onboarding', label: 'Onboarding', icon: FiBookOpen, Component: EmployeeOnboarding },
  { id: 'documents', label: 'เอกสาร', icon: FiFileText, Component: EmployeeDocuments },
] as const

const TAB_IDS = TABS.map((t) => t.id)

export default function EmployeePortal() {
  const isMobile = useIsMobile()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabFromUrl = searchParams.get('tab')
  const [activeTab, setActiveTab] = useState<(typeof TABS)[number]['id']>(
    (tabFromUrl && TAB_IDS.includes(tabFromUrl as (typeof TAB_IDS)[number])) ? (tabFromUrl as (typeof TABS)[number]['id']) : 'dashboard'
  )
  const { signOut } = useAuthContext()

  useEffect(() => {
    const t = searchParams.get('tab')
    if (t && TAB_IDS.includes(t as (typeof TAB_IDS)[number])) setActiveTab(t as (typeof TABS)[number]['id'])
  }, [searchParams])

  const setActiveTabAndUrl = (id: (typeof TABS)[number]['id']) => {
    setActiveTab(id)
    setSearchParams(id === 'dashboard' ? {} : { tab: id })
  }

  if (!isMobile) return <DesktopBlockScreen />

  const currentTab = TABS.find((t) => t.id === activeTab)
  const TabComponent = currentTab?.Component

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 pb-20">
      <header className="sticky top-0 z-30 flex items-center justify-between px-4 py-3 bg-emerald-600 text-white shadow-md">
        <h1 className="text-lg font-semibold">TR-ERP</h1>
        <div className="flex items-center gap-2">
          <button type="button" className="p-2 rounded-full hover:bg-white/20" aria-label="แจ้งเตือน">
            <FiBell className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={() => signOut()}
            className="px-3 py-1.5 text-sm font-medium bg-white/20 rounded-lg hover:bg-white/30"
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
        className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around py-2 bg-white border-t border-gray-200 shadow-[0_-2px_10px_rgba(0,0,0,0.08)]"
        aria-label="แท็บนำทาง"
      >
        {TABS.map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTabAndUrl(tab.id)}
              className={`flex flex-col items-center justify-center gap-0.5 min-w-[64px] py-2 px-2 rounded-lg transition-colors ${
                isActive ? 'text-emerald-600 bg-emerald-50' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              <Icon className="w-6 h-6" />
              <span className="text-xs font-medium">{tab.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
