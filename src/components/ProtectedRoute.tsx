import { useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuthContext } from '../contexts/AuthContext'
import { UserRole } from '../types'
import { supabase } from '../lib/supabase'

/** แปลง pathname → menu_key สำหรับตรวจสอบสิทธิ์จาก st_user_menus */
function pathToMenuKey(pathname: string): string | null {
  if (pathname.startsWith('/orders')) return 'orders'
  if (pathname.startsWith('/admin-qc')) return 'admin-qc'
  if (pathname.startsWith('/account')) return 'account'
  // 'export' removed – no longer used
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
  if (pathname.startsWith('/dashboard')) return 'dashboard'
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
  const [dbAccess, setDbAccess] = useState<boolean | null>(null)
  const [dbLoading, setDbLoading] = useState(false)

  // ถ้า role ไม่อยู่ใน allowedRoles → ตรวจ st_user_menus จาก DB
  useEffect(() => {
    if (loading || !user || !allowedRoles) return
    if (allowedRoles.includes(user.role)) {
      // role อยู่ใน hardcoded list → อนุญาตเลย
      setDbAccess(true)
      return
    }
    // role ไม่อยู่ใน hardcoded list → ตรวจจาก DB
    const menuKey = pathToMenuKey(location.pathname)
    if (!menuKey) {
      setDbAccess(false)
      return
    }
    setDbLoading(true)
    supabase
      .from('st_user_menus')
      .select('has_access')
      .eq('role', user.role)
      .eq('menu_key', menuKey)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          console.error('ProtectedRoute: error checking menu access:', error)
          setDbAccess(false)
        } else {
          setDbAccess(data?.has_access === true)
        }
        setDbLoading(false)
      })
  }, [loading, user, allowedRoles, location.pathname])

  if (loading || dbLoading) {
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

  // ถ้ามี allowedRoles → ตรวจทั้ง hardcoded roles และ DB
  if (allowedRoles && !allowedRoles.includes(user.role) && dbAccess !== true) {
    return <Navigate to="/dashboard" replace />
  }

  return <>{children}</>
}
