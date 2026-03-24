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
import InternalProduction from './pages/InternalProduction'
import RollMaterialCalc from './pages/RollMaterialCalc'
import ProductSalesList from './pages/ProductSalesList'
import PurchasePR from './pages/PurchasePR'
import PurchasePO from './pages/PurchasePO'
import PurchaseGR from './pages/PurchaseGR'
import PurchaseSample from './pages/PurchaseSample'
import DashboardPage from './pages/Dashboard'
import Machinery from './pages/Machinery'
import TechnicianHome from './components/wms/technician/TechnicianHome'
import { lazy, Suspense } from 'react'
import EmployeePortal from './pages/EmployeePortal'
import {
  DESKTOP_MENU_PATH_ORDER,
  MACHINERY_MOBILE_ROLES,
  TECHNICIAN_ROLE,
  WMS_MOBILE_SPECIAL_ROLES,
} from './config/accessPolicy'

const HREmployeeRegistry = lazy(() => import('./components/hr/EmployeeRegistry'))
const HRLeaveManagement = lazy(() => import('./components/hr/LeaveManagement'))
const HRInterviewSchedule = lazy(() => import('./components/hr/InterviewSchedule'))
const HRAttendanceCalc = lazy(() => import('./components/hr/AttendanceCalc'))
const HRContractTemplates = lazy(() => import('./components/hr/ContractTemplates'))
const HRCompanyDocuments = lazy(() => import('./components/hr/CompanyDocuments'))
const HROnboardingPlan = lazy(() => import('./components/hr/OnboardingPlan'))
const HRSalaryPath = lazy(() => import('./components/hr/SalaryPath'))
const HRWarningLetters = lazy(() => import('./components/hr/WarningLetters'))
const HRTrainingCertificates = lazy(() => import('./components/hr/TrainingCertificates'))
const HRAssetRegistry = lazy(() => import('./components/hr/AssetRegistry'))
const HRSettings = lazy(() => import('./components/hr/HRSettings'))

const HRLoading = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" />
  </div>
)

function SmartRedirect() {
  const { user, signOut } = useAuthContext()
  const { menuAccessLoading, hasAccess } = useMenuAccess()

  if (!user) return <Navigate to="/" replace />

  // Special roles: redirect immediately without waiting for menuAccess
  if (user.role === 'auditor') return <Navigate to="/warehouse/audit" replace />

  if (user.role === TECHNICIAN_ROLE) return <Navigate to="/technician" replace />

  if (WMS_MOBILE_SPECIAL_ROLES.includes(user.role)) return <Navigate to="/wms" replace />

  if (user.role === 'employee') return <Navigate to="/employee" replace />

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
  for (const menu of DESKTOP_MENU_PATH_ORDER) {
    if (hasAccess(menu.key)) return <Navigate to={menu.path} replace />
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

  const isWmsMobileRole = user ? WMS_MOBILE_SPECIAL_ROLES.includes(user.role) : false
  const isMachineryMobileLayout = user ? MACHINERY_MOBILE_ROLES.includes(user.role) : false

  if (
    user &&
    user.role === TECHNICIAN_ROLE &&
    location.pathname !== '/machinery' &&
    location.pathname !== '/technician'
  ) {
    return <Navigate to="/technician" replace />
  }

  if (user && user.role === 'picker' && location.pathname !== '/wms') {
    return <Navigate to="/wms" replace />
  }

  if (
    user &&
    (user.role === 'production_mb' || user.role === 'manager') &&
    location.pathname !== '/wms' &&
    location.pathname !== '/machinery'
  ) {
    return <Navigate to="/wms" replace />
  }

  if (user && user.role === 'employee' && !location.pathname.startsWith('/employee')) {
    return <Navigate to="/employee" replace />
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
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account']}>
            <Layout>
              <DashboardPage />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/orders"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account']}>
            <Layout>
              <Orders />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin-qc"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'qc_order']}>
            <Layout>
              <AdminQC />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/account"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'account']}>
            <Layout>
              <Account />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/plan"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'sales-pump', 'production']}>
            <Layout>
              <div className="p-6">
                <Plan />
              </div>
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/technician"
        element={
          <ProtectedRoute allowedRoles={['technician']}>
            <TechnicianHome />
          </ProtectedRoute>
        }
      />
      <Route
        path="/machinery"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'production', 'production_mb', 'manager', 'technician']}>
            {isMachineryMobileLayout ? (
              <Machinery />
            ) : (
              <Layout>
                <Machinery />
              </Layout>
            )}
          </ProtectedRoute>
        }
      />
      <Route
        path="/wms"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store', 'production', 'production_mb', 'manager', 'picker']}>
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
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'qc_staff']}>
            <Layout>
              <QC />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/packing"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'packing_staff']}>
            <Layout>
              <Packing />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/transport"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'packing_staff']}>
            <Layout>
              <TransportVerification />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/products/inactive"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'sales-pump']}>
            <Layout>
              <ProductsInactive />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/products"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'sales-pump']}>
            <Layout>
              <Products />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store']}>
            <Layout>
              <Warehouse />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/audit"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store', 'auditor']}>
            <AuditRouteSwitch />
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/audit/create"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store']}>
            <Layout>
              <CreateAuditForm />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/audit/:id/count"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store', 'auditor']}>
            <MobileCountView />
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/audit/:id/review"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store', 'manager']}>
            <Layout>
              <AuditReviewView />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/adjust"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store']}>
            <Layout>
              <WarehouseAdjust />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/returns"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store']}>
            <Layout>
              <WarehouseReturns />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/production"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'store']}>
            <Layout>
              <InternalProduction />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/roll-calc"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'store']}>
            <Layout>
              <RollMaterialCalc />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/sales-list"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'store']}>
            <Layout>
              <ProductSalesList />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/purchase/pr"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store', 'account']}>
            <Layout>
              <PurchasePR />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/purchase/po"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store', 'account']}>
            <Layout>
              <PurchasePO />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/purchase/gr"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store', 'account']}>
            <Layout>
              <PurchaseGR />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/purchase/sample"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store', 'account']}>
            <Layout>
              <PurchaseSample />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/cartoon-patterns"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'sales-pump']}>
            <Layout>
              <CartoonPatterns />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/sales-reports"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr']}>
            <Layout>
              <SalesReports />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/kpi"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr']}>
            <Layout>
              <KPIDashboard />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr']}>
            <Layout>
              <Settings />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'hr']}>
            <Layout><Suspense fallback={<HRLoading />}><HREmployeeRegistry /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/leave"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'hr']}>
            <Layout><Suspense fallback={<HRLoading />}><HRLeaveManagement /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/interview"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'hr']}>
            <Layout><Suspense fallback={<HRLoading />}><HRInterviewSchedule /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/attendance"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'hr']}>
            <Layout><Suspense fallback={<HRLoading />}><HRAttendanceCalc /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/contracts"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'hr']}>
            <Layout><Suspense fallback={<HRLoading />}><HRContractTemplates /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/documents"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'hr']}>
            <Layout><Suspense fallback={<HRLoading />}><HRCompanyDocuments /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/onboarding"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'hr']}>
            <Layout><Suspense fallback={<HRLoading />}><HROnboardingPlan /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/salary"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'hr']}>
            <Layout><Suspense fallback={<HRLoading />}><HRSalaryPath /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/warnings"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'hr']}>
            <Layout><Suspense fallback={<HRLoading />}><HRWarningLetters /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/certificates"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'hr']}>
            <Layout><Suspense fallback={<HRLoading />}><HRTrainingCertificates /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/assets"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'hr']}>
            <Layout><Suspense fallback={<HRLoading />}><HRAssetRegistry /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/settings"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'hr']}>
            <Layout><Suspense fallback={<HRLoading />}><HRSettings /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/employee/*"
        element={
          <ProtectedRoute allowedRoles={['employee']}>
            <EmployeePortal />
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
