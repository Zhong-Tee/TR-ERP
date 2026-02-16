import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { MenuAccessProvider } from './contexts/MenuAccessContext'
import Login from './components/auth/Login'
import Layout from './components/layout/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import { useAuthContext } from './contexts/AuthContext'
import { useMenuAccess } from './contexts/MenuAccessContext'
import Orders from './pages/Orders'
import AdminQC from './pages/AdminQC'
import Account from './pages/Account'
import QC from './pages/QC'
import Packing from './pages/Packing'
import TransportVerification from './pages/TransportVerification'
import Plan from './pages/Plan'
import Wms from './pages/Wms'
import Products from './pages/Products'
import CartoonPatterns from './pages/CartoonPatterns'
import SalesReports from './pages/SalesReports'
import Settings from './pages/Settings'
import Warehouse from './pages/Warehouse'
import WarehouseAudit from './pages/WarehouseAudit'
import WarehouseAdjust from './pages/WarehouseAdjust'
import WarehouseReturns from './pages/WarehouseReturns'
import PurchasePR from './pages/PurchasePR'
import PurchasePO from './pages/PurchasePO'
import PurchaseGR from './pages/PurchaseGR'
import DashboardPage from './pages/Dashboard'

const MENU_PATH_ORDER: { key: string; path: string; roles: string[] }[] = [
  { key: 'dashboard', path: '/dashboard', roles: ['superadmin', 'admin', 'admin-tr', 'admin-pump', 'admin_qc', 'account'] },
  { key: 'orders', path: '/orders', roles: ['superadmin', 'admin', 'admin-tr', 'admin-pump', 'admin_qc', 'account'] },
  { key: 'admin-qc', path: '/admin-qc', roles: ['superadmin', 'admin', 'admin-tr', 'admin_qc'] },
  { key: 'plan', path: '/plan', roles: ['superadmin', 'admin', 'admin-tr', 'admin-pump'] },
  { key: 'wms', path: '/wms', roles: ['superadmin', 'admin', 'admin-tr', 'store', 'production'] },
  { key: 'qc', path: '/qc', roles: ['superadmin', 'admin', 'admin-tr', 'qc_staff'] },
  { key: 'packing', path: '/packing', roles: ['superadmin', 'admin', 'admin-tr', 'packing_staff'] },
  { key: 'transport', path: '/transport', roles: ['superadmin', 'admin', 'admin-tr', 'packing_staff'] },
  { key: 'account', path: '/account', roles: ['superadmin', 'admin', 'admin-tr', 'account'] },
  { key: 'products', path: '/products', roles: ['superadmin', 'admin', 'admin-tr', 'admin-pump'] },
  { key: 'warehouse', path: '/warehouse', roles: ['superadmin', 'admin', 'admin-tr', 'store'] },
  { key: 'sales-reports', path: '/sales-reports', roles: ['superadmin', 'admin', 'admin-tr', 'viewer'] },
  { key: 'settings', path: '/settings', roles: ['superadmin', 'admin', 'admin-tr'] },
]

function SmartRedirect() {
  const { user } = useAuthContext()
  const { menuAccess, menuAccessLoading, hasAccess } = useMenuAccess()

  if (!user) return <Navigate to="/" replace />

  if (menuAccessLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
          <p className="mt-4 text-gray-600">กำลังโหลด...</p>
        </div>
      </div>
    )
  }

  for (const menu of MENU_PATH_ORDER) {
    if (menuAccess !== null) {
      if (hasAccess(menu.key)) return <Navigate to={menu.path} replace />
    } else {
      if (menu.roles.includes(user.role)) return <Navigate to={menu.path} replace />
    }
  }

  return <Navigate to="/orders" replace />
}

function AppRoutes() {
  const { user, loading } = useAuthContext()
  const location = useLocation()

  // Debug
  console.log('AppRoutes - loading:', loading, 'user:', user)

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
          <p className="mt-4 text-gray-600">กำลังโหลด...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    console.log('No user found, showing login page')
    // onLoginSuccess จะไม่ถูกเรียกแล้ว เพราะ onAuthStateChange จะจัดการให้
    return <Login onLoginSuccess={() => {}} />
  }

  const isWmsMobileRole = user ? ['picker', 'production_mb', 'manager'].includes(user.role) : false

  if (user && isWmsMobileRole && location.pathname !== '/wms') {
    return <Navigate to="/wms" replace />
  }

  return (
    <Routes>
      <Route
        path="/"
        element={<SmartRedirect />}
      />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <Layout>
              <DashboardPage />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/orders"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'admin-pump', 'admin_qc', 'account']}>
            <Layout>
              <Orders />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin-qc"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'admin_qc']}>
            <Layout>
              <AdminQC />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/account"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'account']}>
            <Layout>
              <Account />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/plan"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'admin-pump']}>
            <Layout>
              <div className="p-6">
                <Plan />
              </div>
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/wms"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store', 'production', 'production_mb', 'manager', 'picker']}>
            {isWmsMobileRole ? (
              <Wms />
            ) : (
              <Layout>
                <Wms />
              </Layout>
            )}
          </ProtectedRoute>
        }
      />
      <Route
        path="/qc"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'qc_staff']}>
            <Layout>
              <QC />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/packing"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'packing_staff']}>
            <Layout>
              <Packing />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/transport"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'packing_staff']}>
            <Layout>
              <TransportVerification />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/products"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'admin-pump']}>
            <Layout>
              <Products />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store']}>
            <Layout>
              <Warehouse />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/audit"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store']}>
            <Layout>
              <WarehouseAudit />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/adjust"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store']}>
            <Layout>
              <WarehouseAdjust />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/returns"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store']}>
            <Layout>
              <WarehouseReturns />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/purchase/pr"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store']}>
            <Layout>
              <PurchasePR />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/purchase/po"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store']}>
            <Layout>
              <PurchasePO />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/purchase/gr"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store']}>
            <Layout>
              <PurchaseGR />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/cartoon-patterns"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'admin-pump']}>
            <Layout>
              <CartoonPatterns />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/sales-reports"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'viewer']}>
            <Layout>
              <SalesReports />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr']}>
            <Layout>
              <Settings />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function App() {
  return (
    <Router>
      <AuthProvider>
        <MenuAccessProvider>
          <AppRoutes />
        </MenuAccessProvider>
      </AuthProvider>
    </Router>
  )
}

export default App
