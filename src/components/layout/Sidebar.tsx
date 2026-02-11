import { useState, useEffect, useCallback, ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuthContext } from '../../contexts/AuthContext'
import { UserRole } from '../../types'
import { supabase } from '../../lib/supabase'
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
    roles: ['superadmin', 'admin-tr', 'admin-pump', 'admin_qc', 'account'],
  },
  {
    key: 'orders',
    label: 'ออเดอร์',
    icon: <FiPackage className="w-6 h-6" />,
    path: '/orders',
    roles: ['superadmin', 'admin-tr', 'admin-pump', 'admin_qc', 'account'],
  },
  {
    key: 'admin-qc',
    label: 'รอตรวจคำสั่งซื้อ',
    icon: <FiCheckCircle className="w-6 h-6" />,
    path: '/admin-qc',
    roles: ['superadmin', 'admin-tr', 'admin_qc'],
  },
  {
    key: 'account',
    label: 'บัญชี',
    icon: <FiDollarSign className="w-6 h-6" />,
    path: '/account',
    roles: ['superadmin', 'admin-tr', 'account'],
  },
  {
    key: 'plan',
    label: 'Plan',
    icon: <FiClipboard className="w-6 h-6" />,
    path: '/plan',
    roles: ['superadmin', 'admin-tr', 'admin-pump'],
  },
  {
    key: 'wms',
    label: 'จัดสินค้า',
    icon: <FiGrid className="w-6 h-6" />,
    path: '/wms',
    roles: ['superadmin', 'admin-tr', 'store', 'production'],
  },
  {
    key: 'qc',
    label: 'QC',
    icon: <FiSearch className="w-6 h-6" />,
    path: '/qc',
    roles: ['superadmin', 'admin-tr', 'qc_staff'],
  },
  {
    key: 'packing',
    label: 'จัดของ',
    icon: <FiArchive className="w-6 h-6" />,
    path: '/packing',
    roles: ['superadmin', 'admin-tr', 'packing_staff'],
  },
  {
    key: 'transport',
    label: 'ทวนสอบขนส่ง',
    icon: <FiTruck className="w-6 h-6" />,
    path: '/transport',
    roles: ['superadmin', 'admin-tr', 'packing_staff'],
  },
  {
    key: 'products',
    label: 'สินค้า',
    icon: <FiShoppingBag className="w-6 h-6" />,
    path: '/products',
    roles: ['superadmin', 'admin-tr', 'admin-pump'],
  },
  {
    key: 'cartoon-patterns',
    label: 'ลายการ์ตูน',
    icon: <FiImage className="w-6 h-6" />,
    path: '/cartoon-patterns',
    roles: ['superadmin', 'admin-tr', 'admin-pump'],
  },
  {
    key: 'warehouse',
    label: 'คลัง',
    icon: <FiHome className="w-6 h-6" />,
    path: '/warehouse',
    roles: ['superadmin', 'admin-tr', 'store'],
  },
  {
    key: 'purchase',
    label: 'สั่งซื้อ',
    icon: <FiShoppingCart className="w-6 h-6" />,
    path: '/purchase/pr',
    roles: ['superadmin', 'admin-tr', 'store'],
  },
  {
    key: 'sales-reports',
    label: 'รายงานยอดขาย',
    icon: <FiBarChart2 className="w-6 h-6" />,
    path: '/sales-reports',
    roles: ['superadmin', 'admin-tr', 'viewer'],
  },
  {
    key: 'settings',
    label: 'ตั้งค่า',
    icon: <FiSettings className="w-6 h-6" />,
    path: '/settings',
    roles: ['superadmin', 'admin-tr'],
  },
]

interface SidebarProps {
  isOpen: boolean
  onToggle?: () => void
}

/** เมนูที่แสดงตัวเลขจำนวนแบบเรียลไทม์ */
const MENU_KEYS_WITH_COUNT = ['admin-qc', 'account', 'wms'] as const

export default function Sidebar({ isOpen }: SidebarProps) {
  const location = useLocation()
  const { user } = useAuthContext()
  const [menuCounts, setMenuCounts] = useState<Record<string, number>>({ 'admin-qc': 0, account: 0, wms: 0 })
  const [dbMenuAccess, setDbMenuAccess] = useState<Record<string, boolean> | null>(null)

  // โหลดสิทธิ์เมนูจากตาราง st_user_menus ตาม role ของผู้ใช้
  useEffect(() => {
    if (!user?.role) return
    ;(async () => {
      try {
        const { data, error } = await supabase
          .from('st_user_menus')
          .select('menu_key, has_access')
          .eq('role', user.role)
        if (error) {
          console.error('Error loading menu access:', error)
          return
        }
        // ถ้าไม่มีข้อมูลในตาราง = ยังไม่เคยตั้งค่า → ใช้ค่า default (hardcoded roles)
        if (!data || data.length === 0) {
          setDbMenuAccess(null)
          return
        }
        const map: Record<string, boolean> = {}
        data.forEach((row: { menu_key: string; has_access: boolean }) => {
          map[row.menu_key] = row.has_access
        })
        setDbMenuAccess(map)
      } catch (e) {
        console.error('Sidebar loadMenuAccess:', e)
      }
    })()
  }, [user?.role])

  const loadCounts = useCallback(async () => {
    try {
      const today = new Date().toISOString().split('T')[0]

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
          .contains('billing_details', { request_tax_invoice: true })
          .not('status', 'in', '("ตรวจสอบไม่ผ่าน","รอลงข้อมูล","ลงข้อมูลผิด")'),
        supabase
          .from('or_orders')
          .select('id, billing_details')
          .contains('billing_details', { request_cash_bill: true })
          .not('status', 'in', '("ตรวจสอบไม่ผ่าน","รอลงข้อมูล","ลงข้อมูลผิด")'),
      ])
      const taxPending = ((taxRes.data || []) as { billing_details?: { account_confirmed_tax?: boolean } }[]).filter(
        (o) => !o.billing_details?.account_confirmed_tax
      ).length
      const cashPending = ((cashRes.data || []) as { billing_details?: { account_confirmed_cash?: boolean } }[]).filter(
        (o) => !o.billing_details?.account_confirmed_cash
      ).length
      const accountTotal = (refundRes.count ?? 0) + taxPending + cashPending

      // ── WMS counts ──
      // 1. ใบงานใหม่
      const { data: woData } = await supabase
        .from('or_work_orders')
        .select('work_order_name')
        .eq('status', 'กำลังผลิต')
      let newOrdersCount = 0
      if (woData && woData.length > 0) {
        const woNames = woData.map((wo: any) => wo.work_order_name)
        const { data: assignedRows } = await supabase.from('wms_orders').select('order_id').in('order_id', woNames)
        const assignedSet = new Set((assignedRows || []).map((r: any) => r.order_id))
        newOrdersCount = woData.filter((wo: any) => !assignedSet.has(wo.work_order_name)).length
      }
      // 2. รายการใบงาน (เฉพาะ IN PROGRESS)
      const { data: uploadData } = await supabase
        .from('wms_orders')
        .select('order_id, status')
        .gte('created_at', today + 'T00:00:00')
        .lte('created_at', today + 'T23:59:59')
      const uploadGroups: Record<string, boolean> = {}
      ;(uploadData || []).forEach((r: any) => {
        if (!uploadGroups[r.order_id]) uploadGroups[r.order_id] = false
        if (['pending', 'wrong', 'not_find'].includes(r.status)) uploadGroups[r.order_id] = true
      })
      const uploadCount = Object.values(uploadGroups).filter(Boolean).length
      // 3. ตรวจสินค้า
      const { data: reviewData } = await supabase
        .from('wms_orders')
        .select('order_id, status')
        .gte('created_at', today + 'T00:00:00')
        .lte('created_at', today + 'T23:59:59')
      let reviewCount = 0
      if (reviewData) {
        const grouped: Record<string, { total: number; finished: number; picked: number }> = {}
        reviewData.forEach((r: any) => {
          if (!grouped[r.order_id]) grouped[r.order_id] = { total: 0, finished: 0, picked: 0 }
          grouped[r.order_id].total++
          if (['picked', 'correct', 'wrong', 'not_find', 'out_of_stock'].includes(r.status)) grouped[r.order_id].finished++
          if (r.status === 'picked') grouped[r.order_id].picked++
        })
        reviewCount = Object.values(grouped).filter((g) => g.finished === g.total && g.picked > 0).length
      }
      // 4. รายการเบิก (pending)
      const { count: reqCount } = await supabase
        .from('wms_requisitions')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .gte('created_at', today + 'T00:00:00')
        .lte('created_at', today + 'T23:59:59')
      // 5. แจ้งเตือน (unread)
      const { count: notifCount } = await supabase
        .from('wms_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'unread')

      const wmsTotal = newOrdersCount + uploadCount + reviewCount + (reqCount ?? 0) + (notifCount ?? 0)

      setMenuCounts({
        'admin-qc': qcRes.count ?? 0,
        account: accountTotal,
        wms: wmsTotal,
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_work_orders' }, () => loadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_orders' }, () => loadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_requisitions' }, () => loadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_notifications' }, () => loadCounts())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [loadCounts])

  // โพลทุก 15 วินาทีเมื่อแท็บเปิดอยู่ (fallback ให้ตัวเลขอัปเดตเรียลไทม์แม้ Realtime จะไม่ fire)
  const POLL_INTERVAL_MS = 15_000
  useEffect(() => {
    if (document.visibilityState !== 'visible') return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') loadCounts()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [loadCounts])

  // Refetch counts เมื่อเปลี่ยนไปหน้า admin-qc, account หรือ wms เพื่อให้ตัวเลขตรงกับหน้านั้น
  useEffect(() => {
    if (['/admin-qc', '/account', '/wms'].includes(location.pathname)) {
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

  const filteredMenuItems = menuItems.filter((item) => {
    if (!user?.role) return false
    // ถ้ามีข้อมูลจาก st_user_menus → ใช้ค่าจาก DB
    if (dbMenuAccess !== null) {
      if (item.key === 'dashboard') return true
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
