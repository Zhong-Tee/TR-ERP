import { useState, useEffect, useCallback } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuthContext } from '../../contexts/AuthContext'
import { UserRole } from '../../types'
import { supabase } from '../../lib/supabase'

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
    key: 'plan',
    label: 'Plan',
    icon: '📋',
    path: '/plan',
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

/** เมนูที่แสดงตัวเลขจำนวนแบบเรียลไทม์ */
const MENU_KEYS_WITH_COUNT = ['admin-qc', 'account'] as const

export default function Sidebar({ isOpen, onToggle }: SidebarProps) {
  const location = useLocation()
  const { user } = useAuthContext()
  const [menuCounts, setMenuCounts] = useState<Record<string, number>>({ 'admin-qc': 0, account: 0 })

  const loadCounts = useCallback(async () => {
    try {
      const [qcRes, refundRes, taxRes, cashRes] = await Promise.all([
        supabase
          .from('or_orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'ตรวจสอบแล้ว'),
        supabase
          .from('ac_refunds')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
        supabase
          .from('or_orders')
          .select('id, billing_details')
          .contains('billing_details', { request_tax_invoice: true }),
        supabase
          .from('or_orders')
          .select('id, billing_details')
          .contains('billing_details', { request_cash_bill: true }),
      ])
      const taxPending = ((taxRes.data || []) as { billing_details?: { account_confirmed_tax?: boolean } }[]).filter(
        (o) => !o.billing_details?.account_confirmed_tax
      ).length
      const cashPending = ((cashRes.data || []) as { billing_details?: { account_confirmed_cash?: boolean } }[]).filter(
        (o) => !o.billing_details?.account_confirmed_cash
      ).length
      const accountTotal = (refundRes.count ?? 0) + taxPending + cashPending
      setMenuCounts({
        'admin-qc': qcRes.count ?? 0,
        account: accountTotal,
      })
    } catch (e) {
      console.error('Sidebar loadCounts:', e)
    }
  }, [])

  // โหลดครั้งแรก + Realtime (ถ้าเปิดใช้ใน Supabase)
  useEffect(() => {
    loadCounts()
    const channel = supabase
      .channel('sidebar-menu-counts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, () => loadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ac_refunds' }, () => loadCounts())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [loadCounts])

  // โพลทุก 30 วินาทีเมื่อแท็บเปิดอยู่ (fallback ให้ตัวเลขอัปเดตเรียลไทม์แม้ Realtime จะไม่ fire)
  const POLL_INTERVAL_MS = 30_000
  useEffect(() => {
    if (document.visibilityState !== 'visible') return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') loadCounts()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [loadCounts])

  // Refetch counts เมื่อเปลี่ยนไปหน้า admin-qc หรือ account เพื่อให้ตัวเลขตรงกับหน้านั้น
  useEffect(() => {
    if (location.pathname === '/admin-qc' || location.pathname === '/account') {
      loadCounts()
    }
  }, [location.pathname, loadCounts])

  // Refetch counts เมื่อผู้ใช้กลับมาเปิดแท็บ/หน้าต่าง (visibility change)
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') loadCounts()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [loadCounts])

  // ฟัง event จากหน้า admin-qc / account เมื่อมีการอนุมัติ/ไม่อนุมัติ/อัปเดต เพื่อให้ตัวเลขเมนูอัปเดตทันที
  useEffect(() => {
    const onRefresh = () => loadCounts()
    window.addEventListener('sidebar-refresh-counts', onRefresh)
    return () => window.removeEventListener('sidebar-refresh-counts', onRefresh)
  }, [loadCounts])

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
                  <span className="relative text-xl flex-shrink-0">
                    {item.icon}
                    {MENU_KEYS_WITH_COUNT.includes(item.key as typeof MENU_KEYS_WITH_COUNT[number]) &&
                      (menuCounts[item.key] ?? 0) > 0 && (
                        <span
                          className={`absolute -top-1.5 -right-1.5 min-w-[1.25rem] h-5 px-1 flex items-center justify-center rounded-full text-xs font-bold ${
                            isActive ? 'bg-white text-blue-600' : 'bg-amber-500 text-white'
                          }`}
                        >
                          {(menuCounts[item.key] ?? 0) > 99 ? '99+' : menuCounts[item.key]}
                        </span>
                      )}
                  </span>
                  {isOpen && (
                    <span className="whitespace-nowrap flex items-center gap-2">
                      {item.label}
                      {MENU_KEYS_WITH_COUNT.includes(item.key as typeof MENU_KEYS_WITH_COUNT[number]) &&
                        (menuCounts[item.key] ?? 0) > 0 && (
                          <span
                            className={`min-w-[1.25rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold ${
                              isActive ? 'bg-white/20 text-white' : 'bg-amber-500/90 text-white'
                            }`}
                          >
                            {(menuCounts[item.key] ?? 0) > 99 ? '99+' : menuCounts[item.key]}
                          </span>
                        )}
                    </span>
                  )}
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
