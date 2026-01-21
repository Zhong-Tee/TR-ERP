import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import Login from './components/auth/Login'
import Layout from './components/layout/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import { useAuthContext } from './contexts/AuthContext'
import Orders from './pages/Orders'
import AdminQC from './pages/AdminQC'
import Account from './pages/Account'
import QC from './pages/QC'
import Packing from './pages/Packing'
import Products from './pages/Products'
import CartoonPatterns from './pages/CartoonPatterns'
import SalesReports from './pages/SalesReports'
import Settings from './pages/Settings'

function AppRoutes() {
  const { user, loading } = useAuthContext()

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

  return (
    <Routes>
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout>
              <div className="p-6">
                <h1 className="text-3xl font-bold mb-4">Dashboard</h1>
                <p className="text-gray-600">ยินดีต้อนรับสู่ระบบ TR-ERP</p>
              </div>
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/orders"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'order_staff', 'admin_qc', 'account_staff']}>
            <Layout>
              <Orders />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin-qc"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'admin_qc']}>
            <Layout>
              <AdminQC />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/account"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'account_staff']}>
            <Layout>
              <Account />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/export"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'order_staff']}>
            <Layout>
              <div className="p-6">
                <h1 className="text-3xl font-bold mb-4">ใบงาน</h1>
                <p className="text-gray-600">Work Orders Export - Coming Soon</p>
              </div>
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/qc"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'qc_staff']}>
            <Layout>
              <QC />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/packing"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'packing_staff']}>
            <Layout>
              <Packing />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/products"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'order_staff']}>
            <Layout>
              <Products />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/cartoon-patterns"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'order_staff']}>
            <Layout>
              <CartoonPatterns />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/sales-reports"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin', 'viewer']}>
            <Layout>
              <SalesReports />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute allowedRoles={['superadmin', 'admin']}>
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
        <AppRoutes />
      </AuthProvider>
    </Router>
  )
}

export default App
