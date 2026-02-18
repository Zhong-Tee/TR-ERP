import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuthContext } from '../contexts/AuthContext'
import { UserRole } from '../types'
import { useMenuAccess } from '../contexts/MenuAccessContext'

/** แปลง pathname → menu_key สำหรับตรวจสอบสิทธิ์จาก st_user_menus */
function pathToMenuKey(pathname: string): string | null {
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
  if (pathname.startsWith('/warehouse')) return 'warehouse'
  if (pathname.startsWith('/purchase')) return 'purchase'
  if (pathname.startsWith('/sales-reports')) return 'sales-reports'
  if (pathname.startsWith('/settings')) return 'settings'
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

  const menuBlocked = menuKey && menuAccess !== null && !hasAccess(menuKey)
  const roleBlocked = !menuBlocked && allowedRoles && !allowedRoles.includes(user.role)

  if (menuBlocked || roleBlocked) {
    return <NoAccessFallback />
  }

  return <>{children}</>
}
