import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuthContext } from '../contexts/AuthContext'
import { UserRole } from '../types'
import { useMenuAccess } from '../contexts/MenuAccessContext'

/** sub-path → menu_key mapping (ตรวจก่อน main path เพื่อให้ได้ key ที่เจาะจงกว่า) */
const SUB_PATH_MAP: Record<string, string> = {
  '/warehouse/audit': 'warehouse-audit',
  '/warehouse/adjust': 'warehouse-adjust',
  '/warehouse/returns': 'warehouse-returns',
  '/warehouse/production': 'warehouse-production',
  '/warehouse/roll-calc': 'warehouse-roll-calc',
  '/warehouse/sales-list': 'warehouse-sales-list',
  '/purchase/pr': 'purchase-pr',
  '/purchase/po': 'purchase-po',
  '/purchase/gr': 'purchase-gr',
  '/purchase/sample': 'purchase-sample',
  '/products/inactive': 'products-inactive',
  '/hr/leave': 'hr-leave',
  '/hr/interview': 'hr-interview',
  '/hr/attendance': 'hr-attendance',
  '/hr/contracts': 'hr-contracts',
  '/hr/documents': 'hr-documents',
  '/hr/onboarding': 'hr-onboarding',
  '/hr/salary': 'hr-salary',
  '/hr/warnings': 'hr-warnings',
  '/hr/certificates': 'hr-certificates',
  '/hr/settings': 'hr-settings',
}

/** sub-pages ของแต่ละเมนูหลัก สำหรับ redirect ไปหน้าแรกที่มีสิทธิ์ */
const PARENT_SUB_PAGES: Record<string, { path: string; key: string }[]> = {
  '/warehouse': [
    { path: '/warehouse', key: 'warehouse-stock' },
    { path: '/warehouse/audit', key: 'warehouse-audit' },
    { path: '/warehouse/adjust', key: 'warehouse-adjust' },
    { path: '/warehouse/returns', key: 'warehouse-returns' },
    { path: '/warehouse/production', key: 'warehouse-production' },
    { path: '/warehouse/roll-calc', key: 'warehouse-roll-calc' },
    { path: '/warehouse/sales-list', key: 'warehouse-sales-list' },
  ],
  '/hr': [
    { path: '/hr', key: 'hr-employees' },
    { path: '/hr/leave', key: 'hr-leave' },
    { path: '/hr/interview', key: 'hr-interview' },
    { path: '/hr/attendance', key: 'hr-attendance' },
    { path: '/hr/contracts', key: 'hr-contracts' },
    { path: '/hr/documents', key: 'hr-documents' },
    { path: '/hr/onboarding', key: 'hr-onboarding' },
    { path: '/hr/salary', key: 'hr-salary' },
    { path: '/hr/warnings', key: 'hr-warnings' },
    { path: '/hr/certificates', key: 'hr-certificates' },
    { path: '/hr/settings', key: 'hr-settings' },
  ],
  '/purchase': [
    { path: '/purchase/pr', key: 'purchase-pr' },
    { path: '/purchase/po', key: 'purchase-po' },
    { path: '/purchase/gr', key: 'purchase-gr' },
    { path: '/purchase/sample', key: 'purchase-sample' },
  ],
  '/products': [
    { path: '/products', key: 'products' },
    { path: '/products/inactive', key: 'products-inactive' },
  ],
}

/** แปลง pathname → menu_key สำหรับตรวจสอบสิทธิ์จาก st_user_menus */
function pathToMenuKey(pathname: string): string | null {
  for (const [subPath, key] of Object.entries(SUB_PATH_MAP)) {
    if (pathname.startsWith(subPath)) return key
  }
  if (pathname.startsWith('/dashboard')) return 'dashboard'
  if (pathname.startsWith('/orders')) return 'orders'
  if (pathname.startsWith('/admin-qc')) return 'admin-qc'
  if (pathname.startsWith('/account')) return 'account'
  if (pathname.startsWith('/plan')) return 'plan'
  if (pathname.startsWith('/wms')) return 'wms'
  if (pathname.startsWith('/qc')) return 'qc'
  if (pathname.startsWith('/packing')) return 'packing'
  if (pathname.startsWith('/transport')) return 'transport'
  if (pathname.startsWith('/products')) return 'products'
  if (pathname.startsWith('/cartoon-patterns')) return 'cartoon-patterns'
  if (pathname === '/warehouse') return 'warehouse-stock'
  if (pathname.startsWith('/warehouse')) return 'warehouse'
  if (pathname.startsWith('/purchase')) return 'purchase'
  if (pathname.startsWith('/sales-reports')) return 'sales-reports'
  if (pathname.startsWith('/kpi')) return 'kpi'
  if (pathname === '/hr') return 'hr-employees'
  if (pathname.startsWith('/hr')) return 'hr'
  if (pathname.startsWith('/settings')) return 'settings'
  return null
}

/** หา path ของ parent menu แล้วหา sub-page แรกที่ user มีสิทธิ์ */
function findFirstAccessibleSubPage(
  pathname: string,
  hasAccess: (key: string) => boolean,
): string | null {
  for (const [parentPath, subPages] of Object.entries(PARENT_SUB_PAGES)) {
    const isExactParent = pathname === parentPath
    const isDefaultSubPath =
      parentPath === '/purchase' && pathname === '/purchase/pr'
    if (!isExactParent && !isDefaultSubPath) continue

    const first = subPages.find((sp) => hasAccess(sp.key))
    if (first && first.path !== pathname) return first.path
  }
  return null
}

interface ProtectedRouteProps {
  children: React.ReactNode
  allowedRoles?: UserRole[]
}

function NoAccessFallback() {
  const { signOut } = useAuthContext()
  const navigate = useNavigate()
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="text-center space-y-4 p-8 bg-white rounded-xl shadow-lg max-w-md">
        <div className="text-5xl">🔒</div>
        <p className="text-xl font-bold text-gray-700">ไม่มีสิทธิ์เข้าถึงหน้านี้</p>
        <p className="text-gray-500">กรุณาติดต่อผู้ดูแลระบบเพื่อตั้งค่าสิทธิ์การใช้งาน</p>
        <div className="flex gap-3 justify-center pt-2">
          <button onClick={() => navigate('/')} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            กลับหน้าหลัก
          </button>
          <button onClick={() => signOut()} className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300">
            ออกจากระบบ
          </button>
        </div>
      </div>
    </div>
  )
}

const WMS_MOBILE_ROLES: string[] = ['picker', 'production_mb', 'manager']

export default function ProtectedRoute({
  children,
  allowedRoles,
}: ProtectedRouteProps) {
  const { user, loading } = useAuthContext()
  const location = useLocation()
  const { menuAccess, menuAccessLoading, hasAccess } = useMenuAccess()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
          <p className="mt-4 text-gray-600">กำลังโหลด...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/" replace />
  }

  // Auditor: bypass menuAccess, only allow /warehouse/audit paths
  if (user.role === 'auditor') {
    const isAuditPath = location.pathname.startsWith('/warehouse/audit')
    if (!isAuditPath || (allowedRoles && !allowedRoles.includes('auditor'))) {
      return <NoAccessFallback />
    }
    return <>{children}</>
  }

  // Employee role: bypass menuAccess, only allow /employee paths
  if (user.role === 'employee') {
    const isEmployeePath = location.pathname.startsWith('/employee')
    if (!isEmployeePath || (allowedRoles && !allowedRoles.includes('employee'))) {
      return <NoAccessFallback />
    }
    return <>{children}</>
  }

  // WMS mobile roles: bypass menuAccess, only allow /wms
  if (WMS_MOBILE_ROLES.includes(user.role)) {
    if (location.pathname.startsWith('/wms') && (!allowedRoles || allowedRoles.includes(user.role))) {
      return <>{children}</>
    }
    return <NoAccessFallback />
  }

  // Desktop roles: wait for menuAccess before deciding
  if (menuAccessLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
          <p className="mt-4 text-gray-600">กำลังโหลด...</p>
        </div>
      </div>
    )
  }

  const menuKey = pathToMenuKey(location.pathname)

  if (menuAccess !== null) {
    if (menuKey && !hasAccess(menuKey)) {
      const redirectPath = findFirstAccessibleSubPage(location.pathname, hasAccess)
      if (redirectPath) return <Navigate to={redirectPath} replace />
      return <NoAccessFallback />
    }
  } else {
    // ยังไม่มีข้อมูลจาก DB สำหรับ role นี้ → fallback ใช้ allowedRoles
    if (allowedRoles && !allowedRoles.includes(user.role)) {
      return <NoAccessFallback />
    }
  }

  return <>{children}</>
}
