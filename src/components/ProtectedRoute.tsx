import { Navigate, useLocation } from 'react-router-dom'
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

export default function ProtectedRoute({
  children,
  allowedRoles,
}: ProtectedRouteProps) {
  const { user, loading } = useAuthContext()
  const location = useLocation()
  const { menuAccess, menuAccessLoading, hasAccess } = useMenuAccess()

  if (loading || menuAccessLoading) {
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
    return <Navigate to="/login" replace />
  }

  const menuKey = pathToMenuKey(location.pathname)

  if (menuKey && menuAccess !== null) {
    if (!hasAccess(menuKey)) {
      return <Navigate to="/" replace />
    }
  } else if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}
