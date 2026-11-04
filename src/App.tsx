import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { MenuAccessProvider } from './contexts/MenuAccessContext'
import Login from './components/auth/Login'
import Layout from './components/layout/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import { useAuthContext } from './contexts/AuthContext'
import { useMenuAccess } from './contexts/MenuAccessContext'
import { WAREHOUSE_TRANSFER_ROLES } from './lib/warehouseTransferAccess'
import { lazy, Suspense } from 'react'
import RoutePage from './components/RoutePage'
import MissedClockInAlert from './components/hr/MissedClockInAlert'
import UnreadAnnouncementAlert from './components/hr/UnreadAnnouncementAlert'
import UnreadWarningCertificateAlert from './components/hr/UnreadWarningCertificateAlert'
import {
  DESKTOP_MENU_PATH_ORDER,
  MACHINERY_MOBILE_ROLES,
  TECHNICIAN_ROLE,
  WMS_MOBILE_SPECIAL_ROLES,
} from './config/accessPolicy'
import { getActiveMobileMode, getMobileAccess, getSelectableMobileModes, hasDesktopOverride, modeAllowsPath } from './lib/mobileMode'

const SalesMobile = lazy(() => import('./pages/SalesMobile'))
const Orders = lazy(() => import('./pages/Orders'))
const AdminQC = lazy(() => import('./pages/AdminQC'))
const Account = lazy(() => import('./pages/Account'))
const QC = lazy(() => import('./pages/QC'))
const Packing = lazy(() => import('./pages/Packing'))
const TransportVerification = lazy(() => import('./pages/TransportVerification'))
const Plan = lazy(() => import('./pages/Plan'))
const Wms = lazy(() => import('./pages/Wms'))
const Products = lazy(() => import('./pages/Products'))
const ProductsInactive = lazy(() => import('./pages/ProductsInactive'))
const ProductInformation = lazy(() => import('./pages/ProductInformation'))
const CartoonPatterns = lazy(() => import('./pages/CartoonPatterns'))
const SalesReports = lazy(() => import('./pages/SalesReports'))
const KPIDashboard = lazy(() => import('./pages/KPI'))
const Settings = lazy(() => import('./pages/Settings'))
const Warehouse = lazy(() => import('./pages/Warehouse'))
const WarehouseAudit = lazy(() => import('./pages/WarehouseAudit'))
const WarehouseAdjust = lazy(() => import('./pages/WarehouseAdjust'))
const WarehouseSub = lazy(() => import('./pages/WarehouseSub'))
const WarehouseTransfers = lazy(() => import('./pages/WarehouseTransfers'))
const WarehouseReturns = lazy(() => import('./pages/WarehouseReturns'))
const InternalProduction = lazy(() => import('./pages/InternalProduction'))
const RollMaterialCalc = lazy(() => import('./pages/RollMaterialCalc'))
const ProductSalesList = lazy(() => import('./pages/ProductSalesList'))
const InventoryBalanceHistory = lazy(() => import('./pages/InventoryBalanceHistory'))
const PurchasePR = lazy(() => import('./pages/PurchasePR'))
const PurchasePO = lazy(() => import('./pages/PurchasePO'))
const PurchaseGR = lazy(() => import('./pages/PurchaseGR'))
const PurchaseReceivingCases = lazy(() => import('./pages/PurchaseReceivingCases'))
const PurchaseSample = lazy(() => import('./pages/PurchaseSample'))
const DashboardPage = lazy(() => import('./pages/Dashboard'))
const Marketplace = lazy(() => import('./pages/Marketplace'))
const Machinery = lazy(() => import('./pages/Machinery'))
const KnowledgeHub = lazy(() => import('./pages/KnowledgeHub'))
const EmployeePortal = lazy(() => import('./pages/EmployeePortal'))
const ModeLauncher = lazy(() => import('./pages/ModeLauncher'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const CreateAuditForm = lazy(() => import('./components/audit/CreateAuditForm'))
const MobileCountView = lazy(() => import('./components/audit/MobileCountView'))
const AuditReviewView = lazy(() => import('./components/audit/AuditReviewView'))
const AuditorHome = lazy(() => import('./components/audit/AuditorHome'))
const TechnicianHome = lazy(() => import('./components/wms/technician/TechnicianHome'))

const HREmployeeRegistry = lazy(() => import('./components/hr/EmployeeRegistry'))
const HRLeaveManagement = lazy(() => import('./components/hr/LeaveManagement'))
const HRInterviewSchedule = lazy(() => import('./components/hr/InterviewSchedule'))
const HRTimeAttendance = lazy(() => import('./components/hr/TimeAttendance'))
const HRWorkScore = lazy(() => import('./components/hr/WorkScore'))
const HRWorkCalendar = lazy(() => import('./components/hr/WorkCalendar'))
const HRContractTemplates = lazy(() => import('./components/hr/ContractTemplates'))
const HRCompanyDocuments = lazy(() => import('./components/hr/CompanyDocuments'))
const HROnboardingPlan = lazy(() => import('./components/hr/OnboardingPlan'))
const HRSalaryPath = lazy(() => import('./components/hr/SalaryPath'))
const HRAnnouncements = lazy(() => import('./components/hr/AnnouncementManagement'))
const HRWarningLetters = lazy(() => import('./components/hr/WarningLetters'))
const HRTrainingCertificates = lazy(() => import('./components/hr/TrainingCertificates'))
const HRAssetRegistry = lazy(() => import('./components/hr/AssetRegistryPage'))
const HRSettings = lazy(() => import('./components/hr/HRSettings'))
const HRTaskManagement = lazy(() => import('./components/hr/TaskManagement'))
const HRRequests = lazy(() => import('./components/hr/HRRequests'))

const HRLoading = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" />
  </div>
)

const MOBILE_MAX_WIDTH = 1024

function SmartRedirect() {
  const { user, signOut } = useAuthContext()
  const { menuAccessLoading, hasAccess } = useMenuAccess()

  if (!user) return <Navigate to="/" replace />

  // เข้าจากมือถือ + มีสิทธิ์โหมดมือถือ → พาไปหน้าเลือกโหมด (เว้นแต่กด "โหมด PC Desktop" ไว้)
  if (window.innerWidth <= MOBILE_MAX_WIDTH && !hasDesktopOverride()) {
    const mobileChoiceCount =
      getSelectableMobileModes(user).length +
      (user.employee_access === true ? 1 : 0) +
      (user.role === TECHNICIAN_ROLE ? 1 : 0) // PC Desktop
    if (mobileChoiceCount > 1) {
      return <Navigate to="/mode" replace />
    }
    if (getMobileAccess(user).length > 0) {
      return <Navigate to="/mode" replace />
    }
    // เปิดสวิตช์ employee_access อย่างเดียว → เข้าหน้า Employee ทันที (พฤติกรรมเดิม)
    if (user.employee_access === true) {
      return <Navigate to="/employee" replace />
    }
  }

  // Special roles: redirect immediately without waiting for menuAccess
  if (user.role === 'auditor') return <Navigate to="/warehouse/audit" replace />

  if (user.role === TECHNICIAN_ROLE) {
    const useDesktopMode = window.innerWidth > MOBILE_MAX_WIDTH || hasDesktopOverride()
    return <Navigate to={useDesktopMode ? '/plan' : '/technician'} replace />
  }

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
  if (user?.role === 'auditor' || getActiveMobileMode(user) === 'auditor') return <AuditorHome />
  return <Layout><WarehouseAudit /></Layout>
}

function AppRoutes() {
  const { user, loading } = useAuthContext()
  const location = useLocation()

  // reset-password ต้องแสดงเสมอ ไม่ว่า auth state จะเป็นอะไร
  // เพราะหลัง verify OTP สำเร็จ user จะถูก set แต่ยังต้องกรอก password ใหม่อยู่
  if (location.pathname === '/reset-password') {
    return <ResetPassword />
  }

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

  // โหมดมือถือที่สวมอยู่ (จากหน้าเลือกโหมด /mode) — ใช้ layout มือถือของ role นั้นแทน
  const activeMobileMode = getActiveMobileMode(user)
  const isWmsMobileRole = user
    ? WMS_MOBILE_SPECIAL_ROLES.includes(user.role) ||
      (activeMobileMode != null && WMS_MOBILE_SPECIAL_ROLES.some(role => role === activeMobileMode))
    : false
  const isMachineryMobileLayout = user
    ? (MACHINERY_MOBILE_ROLES.includes(user.role) && user.role !== TECHNICIAN_ROLE) ||
      (user.role === TECHNICIAN_ROLE && window.innerWidth <= MOBILE_MAX_WIDTH && !hasDesktopOverride()) ||
      (activeMobileMode != null && MACHINERY_MOBILE_ROLES.some(role => role === activeMobileMode))
    : false

  // ผู้ใช้ที่เปิดสวิตช์ employee_access เข้า /employee ได้ทุก role — ไม่โดน redirect ของ role มือถือ
  const onEmployeePortalWithAccess =
    user?.employee_access === true && location.pathname.startsWith('/employee')

  // role มือถือที่ได้รับสิทธิ์หลายโหมด (mobile_access) → เข้า /mode และ path ของโหมดที่สวมอยู่ได้
  // โดยไม่โดน redirect ประจำ role ของตัวเอง
  const mobileModeExempt =
    (location.pathname === '/mode' && (
      getSelectableMobileModes(user).length + (user?.employee_access === true ? 1 : 0) > 1
    )) ||
    (activeMobileMode != null && modeAllowsPath(activeMobileMode, location.pathname))

  // Technician บนจอ PC ใช้ desktop Layout เป็นค่าเริ่มต้น เว้นแต่เลือกโหมด Mobile ไว้ชัดเจน
  if (
    user?.role === TECHNICIAN_ROLE &&
    location.pathname === '/technician' &&
    activeMobileMode !== 'technician' &&
    (window.innerWidth > MOBILE_MAX_WIDTH || hasDesktopOverride())
  ) {
    return <Navigate to="/plan" replace />
  }

  if (
    user &&
    user.role === TECHNICIAN_ROLE &&
    !onEmployeePortalWithAccess &&
    !mobileModeExempt &&
    location.pathname !== '/plan' &&
    location.pathname !== '/machinery' &&
    location.pathname !== '/technician'
  ) {
    return <Navigate to="/technician" replace />
  }

  if (
    user &&
    user.role === 'picker' &&
    !onEmployeePortalWithAccess &&
    !mobileModeExempt &&
    location.pathname !== '/wms'
  ) {
    return <Navigate to="/wms" replace />
  }

  if (
    user &&
    (user.role === 'production_mb' || user.role === 'manager') &&
    !onEmployeePortalWithAccess &&
    !mobileModeExempt &&
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
      <Route path="/sales-mobile" element={<ProtectedRoute><RoutePage><SalesMobile /></RoutePage></ProtectedRoute>} />
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
        path="/marketplace"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr']}>
            <Layout>
              <Marketplace />
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
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'sales-pump', 'production', 'qc_staff', 'packing_staff', 'technician']}>
            <Layout>
              <Plan />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/plan/tv"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'sales-pump', 'production']}>
            <Plan tvMode />
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
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'production', 'production_mb', 'manager', 'technician', 'packing_staff', 'store']}>
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
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'production', 'packing_staff']}>
            <Layout>
              <QC />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/packing"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'packing_staff', 'production']}>
            <Layout>
              <Packing />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/transport"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'packing_staff', 'account']}>
            <Layout>
              <TransportVerification />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/products/information"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'sales-pump']}>
            <Layout>
              <ProductInformation />
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
        path="/warehouse/sub"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store', 'qc_order', 'sales-pump', 'qc_staff', 'packing_staff', 'account', 'production', 'hr']}>
            <Layout>
              <WarehouseSub />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store', 'account']}>
            <Layout>
              <Warehouse />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/transfers"
        element={
          <ProtectedRoute allowedRoles={[...WAREHOUSE_TRANSFER_ROLES]}>
            <Layout>
              <WarehouseTransfers />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/audit"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store', 'auditor', 'account']}>
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
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store', 'manager', 'account']}>
            <Layout>
              <AuditReviewView />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouse/adjust"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store', 'account']}>
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
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'store', 'production', 'packing_staff', 'account']}>
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
        path="/purchase/requests"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'account']}>
            <Layout>
              <PurchasePR key="machinery-purchase-requests" fixedPrType="machinery" hideCreate />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/purchase/pr"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'account']}>
            <Layout>
              <PurchasePR key="standard-purchase-pr" />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/purchase/po"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'account']}>
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
      <Route path="/purchase/receiving-cases" element={<ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'store', 'account']}><Layout><PurchaseReceivingCases /></Layout></ProtectedRoute>} />
      <Route
        path="/purchase/sample"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'store', 'account']}>
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
        path="/warehouse/inventory-history"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'store']}>
            <Layout>
              <InventoryBalanceHistory />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/knowledge-hub"
        element={<ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'qc_order', 'sales-pump', 'qc_staff', 'packing_staff', 'account', 'store', 'production', 'hr']}><Layout><KnowledgeHub /></Layout></ProtectedRoute>}
      />
      <Route
        path="/knowledge-hub/new"
        element={<ProtectedRoute allowedRoles={['superadmin', 'admin']}><Layout><KnowledgeHub /></Layout></ProtectedRoute>}
      />
      <Route
        path="/knowledge-hub/categories"
        element={<ProtectedRoute allowedRoles={['superadmin', 'admin']}><Layout><KnowledgeHub /></Layout></ProtectedRoute>}
      />
      <Route
        path="/knowledge-hub/tasks"
        element={<ProtectedRoute allowedRoles={['superadmin', 'admin']}><Layout><KnowledgeHub /></Layout></ProtectedRoute>}
      />
      <Route
        path="/knowledge-hub/:id"
        element={<ProtectedRoute allowedRoles={['superadmin', 'admin', 'sales-tr', 'qc_order', 'sales-pump', 'qc_staff', 'packing_staff', 'account', 'store', 'production', 'hr']}><Layout><KnowledgeHub /></Layout></ProtectedRoute>}
      />
      <Route
        path="/knowledge-hub/:id/edit"
        element={<ProtectedRoute allowedRoles={['superadmin', 'admin']}><Layout><KnowledgeHub /></Layout></ProtectedRoute>}
      />
      <Route
        path="/hr"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HREmployeeRegistry /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/leave"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HRLeaveManagement /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/interview"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HRInterviewSchedule /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/attendance"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HRTimeAttendance /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/work-score"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HRWorkScore /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/work-calendar"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HRWorkCalendar /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/contracts"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HRContractTemplates /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/documents"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HRCompanyDocuments /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/onboarding"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HROnboardingPlan /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/salary"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HRSalaryPath /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/announcements"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HRAnnouncements /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/warnings"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HRWarningLetters /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/certificates"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HRTrainingCertificates /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/assets"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HRAssetRegistry /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/tasks"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HRTaskManagement /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/requests"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
            <Layout><Suspense fallback={<HRLoading />}><HRRequests /></Suspense></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/settings"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'hr', 'account']}>
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
      <Route
        path="/mode"
        element={
          <ProtectedRoute>
            <ModeLauncher />
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
          <RoutePage><AppRoutes /></RoutePage>
          {/* เตือน "ลืมบันทึกเวลาเข้างาน" ทันทีที่ login — ครอบทุกหน้า */}
          <MissedClockInAlert />
          {/* เตือน "ประกาศที่ยังไม่รับทราบ" ทันทีที่ login — ครอบทุกหน้า ทั้ง PC และมือถือ */}
          <UnreadAnnouncementAlert />
          <UnreadWarningCertificateAlert />
        </MenuAccessProvider>
      </AuthProvider>
    </Router>
  )
}

export default App
