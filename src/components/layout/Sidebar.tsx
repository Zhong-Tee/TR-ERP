import { useState, useEffect, useCallback, useRef, ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuthContext } from '../../contexts/AuthContext'
import { useMenuAccess } from '../../contexts/MenuAccessContext'
import { UserRole } from '../../types'
import { supabase } from '../../lib/supabase'
import { loadWmsTabCounts } from '../wms/wmsUtils'
import { fetchWorkOrdersWithProgress } from '../../lib/qcApi'
import {
  FiPackage,
  FiCheckCircle,
  FiDollarSign,
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
import { LuWarehouse, LuGauge } from 'react-icons/lu'

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
    roles: ['superadmin', 'admin', 'admin-tr', 'admin-pump', 'admin_qc', 'account'],
  },
  {
    key: 'orders',
    label: 'ออเดอร์',
    icon: <FiPackage className="w-6 h-6" />,
    path: '/orders',
    roles: ['superadmin', 'admin', 'admin-tr', 'admin-pump', 'admin_qc', 'account'],
  },
  {
    key: 'admin-qc',
    label: 'รอตรวจคำสั่งซื้อ',
    icon: <FiCheckCircle className="w-6 h-6" />,
    path: '/admin-qc',
    roles: ['superadmin', 'admin', 'admin-tr', 'admin_qc'],
  },
  {
    key: 'plan',
    label: 'Plan',
    icon: <FiClipboard className="w-6 h-6" />,
    path: '/plan',
    roles: ['superadmin', 'admin', 'admin-tr', 'admin-pump'],
  },
  {
    key: 'wms',
    label: 'จัดสินค้า',
    icon: <FiGrid className="w-6 h-6" />,
    path: '/wms',
    roles: ['superadmin', 'admin', 'admin-tr', 'store', 'production'],
  },
  {
    key: 'qc',
    label: 'QC',
    icon: <FiSearch className="w-6 h-6" />,
    path: '/qc',
    roles: ['superadmin', 'admin', 'admin-tr', 'qc_staff'],
  },
  {
    key: 'packing',
    label: 'จัดของ',
    icon: <FiArchive className="w-6 h-6" />,
    path: '/packing',
    roles: ['superadmin', 'admin', 'admin-tr', 'packing_staff'],
  },
  {
    key: 'transport',
    label: 'ทวนสอบขนส่ง',
    icon: <FiTruck className="w-6 h-6" />,
    path: '/transport',
    roles: ['superadmin', 'admin', 'admin-tr', 'packing_staff'],
  },
  {
    key: 'account',
    label: 'บัญชี',
    icon: <FiDollarSign className="w-6 h-6" />,
    path: '/account',
    roles: ['superadmin', 'admin', 'admin-tr', 'account'],
  },
  {
    key: 'products',
    label: 'สินค้า',
    icon: <FiShoppingBag className="w-6 h-6" />,
    path: '/products',
    roles: ['superadmin', 'admin', 'admin-tr', 'admin-pump'],
  },
  {
    key: 'cartoon-patterns',
    label: 'ลายการ์ตูน',
    icon: <FiImage className="w-6 h-6" />,
    path: '/cartoon-patterns',
    roles: ['superadmin', 'admin', 'admin-tr', 'admin-pump'],
  },
  {
    key: 'warehouse',
    label: 'คลัง',
    icon: <LuWarehouse className="w-6 h-6" />,
    path: '/warehouse',
    roles: ['superadmin', 'admin', 'admin-tr', 'store'],
  },
  {
    key: 'purchase',
    label: 'สั่งซื้อ',
    icon: <FiShoppingCart className="w-6 h-6" />,
    path: '/purchase/pr',
    roles: ['superadmin', 'admin', 'admin-tr', 'store', 'account'],
  },
  {
    key: 'sales-reports',
    label: 'รายงานยอดขาย',
    icon: <FiBarChart2 className="w-6 h-6" />,
    path: '/sales-reports',
    roles: ['superadmin', 'admin', 'admin-tr'],
  },
  {
    key: 'kpi',
    label: 'KPI',
    icon: <LuGauge className="w-6 h-6" />,
    path: '/kpi',
    roles: ['superadmin', 'admin', 'admin-tr'],
  },
  {
    key: 'settings',
    label: 'ตั้งค่า',
    icon: <FiSettings className="w-6 h-6" />,
    path: '/settings',
    roles: ['superadmin', 'admin', 'admin-tr'],
  },
]

interface SidebarProps {
  isOpen: boolean
  onToggle?: () => void
}

/** เมนูที่แสดงตัวเลขจำนวนแบบเรียลไทม์ */
const MENU_KEYS_WITH_COUNT = ['orders', 'admin-qc', 'account', 'wms', 'qc', 'packing', 'warehouse'] as const

export default function Sidebar({ isOpen }: SidebarProps) {
  const location = useLocation()
  const { user } = useAuthContext()
  const [menuCounts, setMenuCounts] = useState<Record<string, number>>({ orders: 0, 'admin-qc': 0, account: 0, wms: 0, qc: 0, packing: 0, warehouse: 0 })
  const { menuAccess: dbMenuAccess } = useMenuAccess()

  const loadCounts = useCallback(async () => {
    try {
      // ── RPC: ดึง counts พื้นฐานทั้งหมดใน 1 query (แทน 8 queries เดิม) ──
      // ส่ง username + role เพื่อให้ admin-tr / admin-pump เห็นเฉพาะ orders ของตัวเอง
      const adminName = (user?.role === 'admin-pump' || user?.role === 'admin-tr')
        ? (user.username ?? user.email ?? '')
        : ''
      const [rpcRes, qcWoList, wmsResult] = await Promise.all([
        supabase.rpc('get_sidebar_counts', { p_username: adminName, p_role: user?.role ?? '' }),
        fetchWorkOrdersWithProgress(true).catch(() => [] as any[]),
        loadWmsTabCounts(),
      ])

      const c = rpcRes.data || {}
      const accountTotal = (c.refund_pending || 0) + (c.tax_pending || 0) + (c.cash_pending || 0)
      const qcWoCount = Array.isArray(qcWoList) ? qcWoList.length : 0
      const qcTotal = qcWoCount + (c.qc_reject || 0)

      setMenuCounts({
        orders: c.orders || 0,
        'admin-qc': c.admin_qc || 0,
        account: accountTotal,
        wms: wmsResult.total,
        qc: qcTotal,
        packing: c.packing || 0,
        warehouse: c.warehouse || 0,
      })

      // ── แจ้ง TopBar ให้ใช้ค่า warehouse count จาก RPC (ลด query ซ้ำ) ──
      window.dispatchEvent(new CustomEvent('sidebar-warehouse-count', { detail: { count: c.warehouse || 0 } }))
    } catch (e) {
      console.error('Sidebar loadCounts:', e)
    }
  }, [user?.role, user?.username, user?.email])

  // ── Debounce: รวม Realtime events หลายครั้งในช่วงเวลาสั้น ๆ เป็นการเรียก loadCounts ครั้งเดียว ──
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const debouncedLoadCounts = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      loadCounts()
    }, 2_000)
  }, [loadCounts])
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

  // โหลดครั้งแรก + Realtime พร้อม debounce (ลด API calls จาก Realtime events ที่มาถี่ ๆ)
  useEffect(() => {
    loadCounts()
    const channel = supabase
      .channel('sidebar-menu-counts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, () => debouncedLoadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ac_refunds' }, () => debouncedLoadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_work_orders' }, () => debouncedLoadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_orders' }, () => debouncedLoadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_requisitions' }, () => debouncedLoadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_notifications' }, () => debouncedLoadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'qc_records' }, () => debouncedLoadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'qc_sessions' }, () => debouncedLoadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'qc_skip_logs' }, () => debouncedLoadCounts())
      // ไม่ subscribe inv_stock_balances — ใช้ event dispatch จากหน้าที่ปรับสต๊อคแทน เพื่อป้องกัน cascade
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [loadCounts, debouncedLoadCounts])

  // ฟัง event จากหน้า QC เมื่อมีการอัปเดตจำนวน (เร็วกว่า Realtime)
  useEffect(() => {
    const onQcCounts = (e: Event) => {
      const total = (e as CustomEvent).detail?.total
      if (typeof total === 'number') {
        setMenuCounts((prev) => ({ ...prev, qc: total }))
      }
    }
    window.addEventListener('sidebar-qc-counts', onQcCounts)
    return () => window.removeEventListener('sidebar-qc-counts', onQcCounts)
  }, [])

  // Refetch counts เมื่อเปลี่ยนไปหน้า admin-qc, account, wms, packing เพื่อให้ตัวเลขตรงกับหน้านั้น
  useEffect(() => {
    if (['/orders', '/admin-qc', '/account', '/wms', '/qc', '/packing', '/warehouse'].includes(location.pathname)) {
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

  // ฟัง event จากหน้า WMS AdminLayout เมื่อมีการอัปเดตตัวเลข (เร็วกว่า Realtime)
  useEffect(() => {
    const onWmsCounts = (e: Event) => {
      const total = (e as CustomEvent).detail?.total
      if (typeof total === 'number') {
        setMenuCounts((prev) => ({ ...prev, wms: total }))
      }
    }
    window.addEventListener('wms-counts-updated', onWmsCounts)
    return () => window.removeEventListener('wms-counts-updated', onWmsCounts)
  }, [])

  // ฟัง event จากหน้า Packing เมื่อจำนวนใบงานพร้อมจัดของเปลี่ยน (เร็วกว่า Realtime)
  useEffect(() => {
    const onPackingCount = (e: Event) => {
      const count = (e as CustomEvent).detail?.count
      if (typeof count === 'number') {
        setMenuCounts((prev) => ({ ...prev, packing: count }))
      }
    }
    window.addEventListener('packing-ready-count', onPackingCount)
    return () => window.removeEventListener('packing-ready-count', onPackingCount)
  }, [])

  // ฟัง event จากหน้า Warehouse เมื่อจำนวนสินค้าต่ำกว่าจุดสั่งซื้อเปลี่ยน
  useEffect(() => {
    const onWarehouseCount = (e: Event) => {
      const count = (e as CustomEvent).detail?.count
      if (typeof count === 'number') {
        setMenuCounts((prev) => ({ ...prev, warehouse: count }))
      }
    }
    window.addEventListener('warehouse-below-order-point', onWarehouseCount)
    return () => window.removeEventListener('warehouse-below-order-point', onWarehouseCount)
  }, [])

  const filteredMenuItems = menuItems.filter((item) => {
    if (!user?.role) return false
    // ถ้ามีข้อมูลจาก st_user_menus → ใช้ค่าจาก DB
    if (dbMenuAccess !== null) {
      // ถ้ามี key อยู่ใน DB → ใช้ค่าจาก DB
      if (item.key in dbMenuAccess) return dbMenuAccess[item.key] === true
      // ถ้าไม่มี key ใน DB (เมนูใหม่ยังไม่เคยบันทึก) → fallback ใช้ hardcoded roles
      return item.roles.includes(user.role)
    }
    // ถ้ายังไม่มีข้อมูลจาก DB → fallback ใช้ hardcoded roles
    return item.roles.includes(user.role)
  })

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
                          <span className={`min-w-[1.4rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold shadow-sm ${
                            item.key === 'warehouse' ? 'bg-orange-400 text-white' : 'bg-yellow-400 text-emerald-900'
                          }`}>
                            {(menuCounts[item.key] ?? 0) > 99 ? '99+' : menuCounts[item.key]}
                          </span>
                        )}
                    </span>
                  ) : (
                    MENU_KEYS_WITH_COUNT.includes(item.key as typeof MENU_KEYS_WITH_COUNT[number]) &&
                    (menuCounts[item.key] ?? 0) > 0 && (
                      <span className={`absolute -top-1 -right-1 min-w-[1.2rem] h-[1.2rem] px-1 flex items-center justify-center rounded-full text-[10px] font-bold shadow-sm ${
                        item.key === 'warehouse' ? 'bg-orange-400 text-white' : 'bg-yellow-400 text-emerald-900'
                      }`}>
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
