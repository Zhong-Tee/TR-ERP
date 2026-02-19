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
import ProductsInactive from './pages/ProductsInactive'
import CartoonPatterns from './pages/CartoonPatterns'
import SalesReports from './pages/SalesReports'
import KPIDashboard from './pages/KPI'
import Settings from './pages/Settings'
import Warehouse from './pages/Warehouse'
import WarehouseAudit from './pages/WarehouseAudit'
import WarehouseAdjust from './pages/WarehouseAdjust'
import CreateAuditForm from './components/audit/CreateAuditForm'
import MobileCountView from './components/audit/MobileCountView'
import AuditReviewView from './components/audit/AuditReviewView'
import AuditorHome from './components/audit/AuditorHome'
import WarehouseReturns from './pages/WarehouseReturns'
import PurchasePR from './pages/PurchasePR'
import PurchasePO from './pages/PurchasePO'
import PurchaseGR from './pages/PurchaseGR'
import PurchaseSample from './pages/PurchaseSample'
import DashboardPage from './pages/Dashboard'

const MENU_PATH_ORDER: { key: string; path: string; roles: string[] }[] = [
  { key: 'dashboard', path: '/dashboard', roles: ['superadmin', 'admin', 'admin-tr', 'admin-pump', 'admin_qc', 'account'] },
  { key: 'orders', path: '/orders', roles: ['superadmin', 'admin', 'admin-tr', 'admin-pump', 'admin_qc', 'account'] },
  { key: 'admin-qc', path: '/admin-qc', roles: ['superadmin', 'admin', 'admin-tr', 'admin_qc'] },
  { key: 'plan', path: '/plan', roles: ['superadmin', 'admin', 'admin-tr', 'admin-pump'] },
  { key: 'wms', path: '/wms', roles: ['superadmin', 'admin', 'admin-tr', 'store', 'production', 'production_mb', 'manager', 'picker'] },
  { key: 'qc', path: '/qc', roles: ['superadmin', 'admin', 'admin-tr', 'qc_staff'] },
  { key: 'packing', path: '/packing', roles: ['superadmin', 'admin', 'admin-tr', 'packing_staff'] },
  { key: 'transport', path: '/transport', roles: ['superadmin', 'admin', 'admin-tr', 'packing_staff'] },
  { key: 'account', path: '/account', roles: ['superadmin', 'admin', 'admin-tr', 'account'] },
  { key: 'products', path: '/products', roles: ['superadmin', 'admin', 'admin-tr', 'admin-pump'] },
  { key: 'warehouse', path: '/warehouse', roles: ['superadmin', 'admin', 'admin-tr', 'store'] },
  { key: 'sales-reports', path: '/sales-reports', roles: ['superadmin', 'admin', 'admin-tr'] },
  { key: 'kpi', path: '/kpi', roles: ['superadmin', 'admin', 'admin-tr'] },
  { key: 'settings', path: '/settings', roles: ['superadmin', 'admin', 'admin-tr'] },
]

function SmartRedirect() {
  const { user, signOut } = useAuthContext()
  const { menuAccess, menuAccessLoading, hasAccess } = useMenuAccess()

  if (!user) return <Navigate to="/" replace />

  // Special roles: redirect immediately without waiting for menuAccess
  if (user.role === 'auditor') return <Navigate to="/warehouse/audit" replace />

  const WMS_MOBILE_ROLES = ['picker', 'production_mb', 'manager']
  if (WMS_MOBILE_ROLES.includes(user.role)) return <Navigate to="/wms" replace />

  // Desktop roles: wait for menuAccess to determine first accessible page
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

  // หา menu แรกที่ role มีสิทธิ์เข้าถึง
  for (const menu of MENU_PATH_ORDER) {
    if (menuAccess !== null) {
      // มีข้อมูลจาก DB → ใช้ DB เป็น single source of truth
      if (hasAccess(menu.key)) return <Navigate to={menu.path} replace />
    } else {
      // ยังไม่มีข้อมูลจาก DB → fallback ใช้ hardcoded roles
      if (menu.roles.includes(user.role)) return <Navigate to={menu.path} replace />
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="text-center space-y-4 p-8 bg-white rounded-xl shadow-lg max-w-md">
        <div className="text-5xl">🔒</div>
        <p className="text-xl font-bold text-gray-700">ไม่มีเมนูที่สามารถเข้าถึงได้</p>
        <p className="text-gray-500">กรุณาติดต่อผู้ดูแลระบบเพื่อตั้งค่าสิทธิ์การใช้งาน</p>
        <div className="flex gap-3 justify-center pt-2">
          <button onClick={() => window.location.reload()} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            รีเฟรช
          </button>
          <button onClick={() => signOut()} className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300">
            ออกจากระบบ
          </button>
        </div>
      </div>
    </div>
  )
}

function AuditRouteSwitch() {
  const { user } = useAuthContext()
  if (user?.role === 'auditor') return <AuditorHome />
  return <Layout><WarehouseAudit /></Layout>
}

function AppRoutes() {
  const { user, loading } = useAuthContext()
  const location = useLocation()

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
    if (location.pathname !== '/') {
      return <Navigate to="/" replace />
    }
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
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'admin-pump', 'admin_qc', 'account']}>
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
        path="/products/inactive"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'admin-pump']}>
            <Layout>
              <ProductsInactive />
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
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store', 'auditor']}>
            <AuditRouteSwitch />
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/audit/create"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store']}>
            <Layout>
              <CreateAuditForm />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/audit/:id/count"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store', 'auditor']}>
            <MobileCountView />
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/audit/:id/review"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store', 'manager']}>
            <Layout>
              <AuditReviewView />
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
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store', 'account']}>
            <Layout>
              <PurchasePR />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/purchase/po"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store', 'account']}>
            <Layout>
              <PurchasePO />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/purchase/gr"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store', 'account']}>
            <Layout>
              <PurchaseGR />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/purchase/sample"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr', 'store', 'account']}>
            <Layout>
              <PurchaseSample />
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
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr']}>
            <Layout>
              <SalesReports />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/kpi"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin-tr']}>
            <Layout>
              <KPIDashboard />
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
