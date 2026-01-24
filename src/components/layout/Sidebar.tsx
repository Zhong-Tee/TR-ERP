import { Link, useLocation } from 'react-router-dom'
import { useAuthContext } from '../../contexts/AuthContext'
import { UserRole } from '../../types'

interface MenuItem {
  key: string
  label: string
  icon: string
  path: string
  roles: UserRole[]
}

const menuItems: MenuItem[] = [
  {
    key: 'orders',
    label: 'ออเดอร์',
    icon: '📦',
    path: '/orders',
    roles: ['superadmin', 'admin', 'order_staff', 'admin_qc', 'account_staff'],
  },
  {
    key: 'admin-qc',
    label: 'รอตรวจคำสั่งซื้อ',
    icon: '✅',
    path: '/admin-qc',
    roles: ['superadmin', 'admin', 'admin_qc'],
  },
  {
    key: 'account',
    label: 'บัญชี',
    icon: '💰',
    path: '/account',
    roles: ['superadmin', 'admin', 'account_staff'],
  },
  {
    key: 'export',
    label: 'ใบงาน',
    icon: '📄',
    path: '/export',
    roles: ['superadmin', 'admin', 'order_staff'],
  },
  {
    key: 'qc',
    label: 'QC',
    icon: '🔍',
    path: '/qc',
    roles: ['superadmin', 'admin', 'qc_staff'],
  },
  {
    key: 'packing',
    label: 'จัดของ',
    icon: '📦',
    path: '/packing',
    roles: ['superadmin', 'admin', 'packing_staff'],
  },
  {
    key: 'products',
    label: 'สินค้า',
    icon: '🛍️',
    path: '/products',
    roles: ['superadmin', 'admin', 'order_staff'],
  },
  {
    key: 'cartoon-patterns',
    label: 'ลายการ์ตูน',
    icon: '🎨',
    path: '/cartoon-patterns',
    roles: ['superadmin', 'admin', 'order_staff'],
  },
  {
    key: 'sales-reports',
    label: 'รายงานยอดขาย',
    icon: '📊',
    path: '/sales-reports',
    roles: ['superadmin', 'admin', 'viewer'],
  },
  {
    key: 'settings',
    label: 'ตั้งค่า',
    icon: '⚙️',
    path: '/settings',
    roles: ['superadmin', 'admin'],
  },
]

interface SidebarProps {
  isOpen: boolean
  onToggle?: () => void
}

export default function Sidebar({ isOpen, onToggle }: SidebarProps) {
  const location = useLocation()
  const { user } = useAuthContext()

  const filteredMenuItems = menuItems.filter((item) =>
    user?.role ? item.roles.includes(user.role) : false
  )

  return (
    <aside
      className={`bg-gray-800 text-white min-h-screen fixed left-0 top-0 overflow-y-auto transition-all duration-300 z-20 ${
        isOpen ? 'w-64' : 'w-20'
      }`}
    >
      <div className={`p-6 border-b border-gray-700 ${!isOpen ? 'px-3' : ''}`}>
        <div className="flex items-center justify-between">
          {isOpen ? (
            <>
              <div>
                <h1 className="text-2xl font-bold">TR-ERP</h1>
                <p className="text-sm text-gray-400 mt-1">ระบบจัดการออเดอร์</p>
              </div>
              {onToggle && (
                <button
                  onClick={onToggle}
                  className="p-2 hover:bg-gray-700 rounded-lg transition-colors"
                  title="ปิดเมนู"
                  aria-label="ปิดเมนู"
                >
                  <svg
                    className="w-5 h-5 text-white"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center w-full gap-2">
              <h1 className="text-xl font-bold">TR</h1>
              {onToggle && (
                <button
                  onClick={onToggle}
                  className="p-2 hover:bg-gray-700 rounded-lg transition-colors"
                  title="เปิดเมนู"
                  aria-label="เปิดเมนู"
                >
                  <svg
                    className="w-5 h-5 text-white"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 6h16M4 12h16M4 18h16"
                    />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <nav className="p-4">
        <ul className="space-y-2">
          {filteredMenuItems.map((item) => {
            const isActive = location.pathname === item.path
            return (
              <li key={item.key}>
                <Link
                  to={item.path}
                  className={`flex items-center gap-3 rounded-lg transition-colors ${
                    isOpen ? 'px-4 py-3' : 'px-3 py-3 justify-center'
                  } ${
                    isActive
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-300 hover:bg-gray-700'
                  }`}
                  title={!isOpen ? item.label : undefined}
                >
                  <span className="text-xl flex-shrink-0">{item.icon}</span>
                  {isOpen && <span className="whitespace-nowrap">{item.label}</span>}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      {user && isOpen && (
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-gray-700">
          <div className="text-sm">
            <p className="text-gray-300 truncate">{user.username || user.email}</p>
            <p className="text-gray-500 text-xs">{user.role}</p>
          </div>
        </div>
      )}
    </aside>
  )
}
