import { useAuthContext } from '../../contexts/AuthContext'
import { useLocation } from 'react-router-dom'

interface TopBarProps {
  sidebarOpen: boolean
}

export default function TopBar({ sidebarOpen }: TopBarProps) {
  const { user, signOut } = useAuthContext()
  const location = useLocation()

  const pageTitle = location.pathname.startsWith('/packing')
    ? 'จัดของ'
    : location.pathname.startsWith('/transport')
      ? 'ทวนสอบขนส่ง'
      : location.pathname.startsWith('/wms')
        ? 'จัดสินค้า'
        : ''

  const handleLogout = async () => {
    if (confirm('ต้องการออกจากระบบหรือไม่?')) {
      await signOut()
    }
  }

  return (
    <header
      className={`bg-green-600 text-white h-16 flex items-center justify-between px-6 shadow-md fixed top-0 right-0 z-10 transition-all duration-300 ${
        sidebarOpen ? 'left-64' : 'left-20'
      }`}
    >
      <div className="flex items-center gap-4">
        <h2 className="text-xl font-semibold">TR-ERP System</h2>
        {pageTitle && (
          <span className="text-base font-medium text-green-100">• {pageTitle}</span>
        )}
      </div>

      <div className="flex items-center gap-4">
        {user && (
          <div className="text-sm">
            <span className="mr-4">{user.username || user.email}</span>
            <span className="text-green-200">({user.role})</span>
          </div>
        )}
        <button
          onClick={handleLogout}
          className="px-4 py-2 bg-red-500 hover:bg-red-600 rounded-lg transition-colors"
        >
          ออกจากระบบ
        </button>
      </div>
    </header>
  )
}
