import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuthContext } from '../contexts/AuthContext'
import { UserRole } from '../types'

interface ProtectedRouteProps {
  children: React.ReactNode
  allowedRoles?: UserRole[]
}

export default function ProtectedRoute({
  children,
  allowedRoles,
}: ProtectedRouteProps) {
  const { user, loading, signOut } = useAuthContext()
  const [forceLogin, setForceLogin] = useState(false)

  useEffect(() => {
    if (loading || !user || !allowedRoles) return
    if (!allowedRoles.includes(user.role)) {
      setForceLogin(true)
      signOut().catch((error) => {
        console.error('Sign out failed after unauthorized access:', error)
      })
    }
  }, [loading, user, allowedRoles, signOut])

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
    return <Navigate to="/login" replace />
  }

  if (forceLogin) {
    return <Navigate to="/login" replace />
  }

  if (allowedRoles) {
    if (!allowedRoles.includes(user.role)) {
      return <Navigate to="/login" replace />
    }
  }

  return <>{children}</>
}
