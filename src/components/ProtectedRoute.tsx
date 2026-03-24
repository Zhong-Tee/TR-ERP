import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuthContext } from '../contexts/AuthContext'
import { UserRole } from '../types'
import { useMenuAccess } from '../contexts/MenuAccessContext'
import {
  isRoleInAllowedList,
  PARENT_SUB_PAGES,
  resolveMenuKeyFromPath,
  TECHNICIAN_ROLE,
  WMS_MOBILE_SPECIAL_ROLES,
} from '../config/accessPolicy'

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

export default function ProtectedRoute({
  children,
  allowedRoles,
}: ProtectedRouteProps) {
  const { user, loading } = useAuthContext()
  const location = useLocation()
  const { menuAccessLoading, hasAccess } = useMenuAccess()

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
    if (!isAuditPath || (allowedRoles && !isRoleInAllowedList('auditor', allowedRoles))) {
      return <NoAccessFallback />
    }
    return <>{children}</>
  }

  // Employee role: bypass menuAccess, only allow /employee paths
  if (user.role === 'employee') {
    const isEmployeePath = location.pathname.startsWith('/employee')
    if (!isEmployeePath || (allowedRoles && !isRoleInAllowedList('employee', allowedRoles))) {
      return <NoAccessFallback />
    }
    return <>{children}</>
  }

  // Technician: mobile — หน้า home /technician และ /machinery
  if (user.role === TECHNICIAN_ROLE) {
    const ok =
      location.pathname.startsWith('/machinery') || location.pathname.startsWith('/technician')
    if (ok && (!allowedRoles || isRoleInAllowedList(user.role, allowedRoles))) {
      return <>{children}</>
    }
    return <NoAccessFallback />
  }

  // WMS mobile roles: bypass menuAccess, /wms or /machinery (picker ไม่เข้า machinery)
  if (WMS_MOBILE_SPECIAL_ROLES.includes(user.role)) {
    const onMachinery = location.pathname.startsWith('/machinery')
    if (user.role === 'picker' && onMachinery) {
      return <NoAccessFallback />
    }
    const ok = location.pathname.startsWith('/wms') || onMachinery
    if (ok && (!allowedRoles || isRoleInAllowedList(user.role, allowedRoles))) {
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

  const menuKey = resolveMenuKeyFromPath(location.pathname)

  if (menuKey && !hasAccess(menuKey)) {
    const redirectPath = findFirstAccessibleSubPage(location.pathname, hasAccess)
    if (redirectPath) return <Navigate to={redirectPath} replace />
    return <NoAccessFallback />
  }

  return <>{children}</>
}
