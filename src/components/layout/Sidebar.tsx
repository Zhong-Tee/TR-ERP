import { useState, useEffect, useCallback, ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuthContext } from '../../contexts/AuthContext'
import { UserRole } from '../../types'
import { supabase } from '../../lib/supabase'
import {
  FiPackage,
  FiCheckCircle,
  FiDollarSign,
  FiFileText,
  FiClipboard,
  FiGrid,
  FiSearch,
  FiArchive,
  FiTruck,
  FiShoppingBag,
  FiImage,
  FiHome,
  FiShoppingCart,
  FiBarChart2,
  FiSettings,
} from 'react-icons/fi'

interface MenuItem {
  key: string
  label: string
  icon: ReactNode
  path: string
  roles: UserRole[]
}

const menuItems: MenuItem[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    icon: <FiHome className="w-6 h-6" />,
    path: '/dashboard',
    roles: ['superadmin', 'admin', 'order_staff', 'admin_qc', 'account_staff'],
  },
  {
    key: 'orders',
    label: 'ออเดอร์',
    icon: <FiPackage className="w-6 h-6" />,
    path: '/orders',
    roles: ['superadmin', 'admin', 'order_staff', 'admin_qc', 'account_staff'],
  },
  {
    key: 'admin-qc',
    label: 'รอตรวจคำสั่งซื้อ',
    icon: <FiCheckCircle className="w-6 h-6" />,
    path: '/admin-qc',
    roles: ['superadmin', 'admin', 'admin_qc'],
  },
  {
    key: 'account',
    label: 'บัญชี',
    icon: <FiDollarSign className="w-6 h-6" />,
    path: '/account',
    roles: ['superadmin', 'admin', 'account_staff'],
  },
  {
    key: 'export',
    label: 'ใบงาน',
    icon: <FiFileText className="w-6 h-6" />,
    path: '/export',
    roles: ['superadmin', 'admin', 'order_staff'],
  },
  {
    key: 'plan',
    label: 'Plan',
    icon: <FiClipboard className="w-6 h-6" />,
    path: '/plan',
    roles: ['superadmin', 'admin', 'order_staff'],
  },
  {
    key: 'wms',
    label: 'จัดสินค้า',
    icon: <FiGrid className="w-6 h-6" />,
    path: '/wms',
    roles: ['superadmin', 'admin', 'store', 'production', 'manager', 'picker'],
  },
  {
    key: 'qc',
    label: 'QC',
    icon: <FiSearch className="w-6 h-6" />,
    path: '/qc',
    roles: ['superadmin', 'admin', 'qc_staff'],
  },
  {
    key: 'packing',
    label: 'จัดของ',
    icon: <FiArchive className="w-6 h-6" />,
    path: '/packing',
    roles: ['superadmin', 'admin', 'packing_staff'],
  },
  {
    key: 'transport',
    label: 'ทวนสอบขนส่ง',
    icon: <FiTruck className="w-6 h-6" />,
    path: '/transport',
    roles: ['superadmin', 'admin', 'packing_staff'],
  },
  {
    key: 'products',
    label: 'สินค้า',
    icon: <FiShoppingBag className="w-6 h-6" />,
    path: '/products',
    roles: ['superadmin', 'admin', 'order_staff'],
  },
  {
    key: 'cartoon-patterns',
    label: 'ลายการ์ตูน',
    icon: <FiImage className="w-6 h-6" />,
    path: '/cartoon-patterns',
    roles: ['superadmin', 'admin', 'order_staff'],
  },
  {
    key: 'warehouse',
    label: 'คลัง',
    icon: <FiHome className="w-6 h-6" />,
    path: '/warehouse',
    roles: ['superadmin', 'admin', 'store', 'manager'],
  },
  {
    key: 'purchase',
    label: 'สั่งซื้อ',
    icon: <FiShoppingCart className="w-6 h-6" />,
    path: '/purchase/pr',
    roles: ['superadmin', 'admin', 'store', 'manager'],
  },
  {
    key: 'sales-reports',
    label: 'รายงานยอดขาย',
    icon: <FiBarChart2 className="w-6 h-6" />,
    path: '/sales-reports',
    roles: ['superadmin', 'admin', 'viewer'],
  },
  {
    key: 'settings',
    label: 'ตั้งค่า',
    icon: <FiSettings className="w-6 h-6" />,
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

export default function Sidebar({ isOpen }: SidebarProps) {
  const location = useLocation()
  const { user } = useAuthContext()
  const [menuCounts, setMenuCounts] = useState<Record<string, number>>({ 'admin-qc': 0, account: 0 })

  const loadCounts = useCallback(async () => {
    try {
      const [qcRes, refundRes, taxRes, cashRes] = await Promise.all([
        supabase
          .from('or_orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'ตรวจสอบแล้ว')
          .neq('channel_code', 'PUMP'),
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
      className={`text-white h-screen fixed left-0 top-0 overflow-hidden transition-all duration-300 z-20 flex flex-col ${
        isOpen ? 'w-64' : 'w-20'
      }`}
      style={{ backgroundColor: '#059669' }}
    >
      <div className={`p-6 border-b border-white/20 ${!isOpen ? 'px-3' : ''}`}>
        <div className="flex items-center justify-center">
          {isOpen ? (
            <h1 className="text-2xl font-semibold text-white">TR-ERP</h1>
          ) : (
            <h1 className="text-xl font-semibold text-white">TR</h1>
          )}
        </div>
      </div>

      <nav className="p-4 flex-1 overflow-y-auto scrollbar-none" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        <ul className="space-y-2">
          {filteredMenuItems.map((item) => {
            const isActive = location.pathname === item.path
            return (
              <li key={item.key}>
                <Link
                  to={item.path}
                  className={`relative flex items-center gap-3 rounded-xl transition-colors font-medium ${
                    isOpen ? 'px-4 py-3' : 'px-3 py-3 justify-center'
                  } ${
                    isActive ? 'bg-white/25 text-white font-semibold' : 'text-emerald-100 hover:bg-white/15 hover:text-white'
                  }`}
                  title={!isOpen ? item.label : undefined}
                >
                  <span className="text-2xl flex-shrink-0">
                    {item.icon}
                  </span>
                  {isOpen ? (
                    <span className="whitespace-nowrap flex items-center gap-2 text-base">
                      {item.label}
                      {MENU_KEYS_WITH_COUNT.includes(item.key as typeof MENU_KEYS_WITH_COUNT[number]) &&
                        (menuCounts[item.key] ?? 0) > 0 && (
                          <span className="min-w-[1.4rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold shadow-sm bg-yellow-400 text-emerald-900">
                            {(menuCounts[item.key] ?? 0) > 99 ? '99+' : menuCounts[item.key]}
                          </span>
                        )}
                    </span>
                  ) : (
                    MENU_KEYS_WITH_COUNT.includes(item.key as typeof MENU_KEYS_WITH_COUNT[number]) &&
                    (menuCounts[item.key] ?? 0) > 0 && (
                      <span className="absolute -top-1 -right-1 min-w-[1.2rem] h-[1.2rem] px-1 flex items-center justify-center rounded-full text-[10px] font-bold bg-yellow-400 text-emerald-900 shadow-sm">
                        {(menuCounts[item.key] ?? 0) > 99 ? '99+' : menuCounts[item.key]}
                      </span>
                    )
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

    </aside>
  )
}
