import { useState, useEffect, useCallback, useMemo, useSyncExternalStore, ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuthContext } from '../../contexts/AuthContext'
import { useMenuAccess } from '../../contexts/MenuAccessContext'
import { UserRole } from '../../types'
import { supabase } from '../../lib/supabase'
import { countReadScope, createRefreshBatch } from '../../lib/readRefresh'
import { SIDEBAR_COUNT_GROUPS, SIDEBAR_COUNT_TABLES, sidebarGroupsForContextTable, sidebarGroupsForEvent, readSidebarCounts, invalidateSidebarCounts, type SidebarCountGroup, type SidebarCountPatch } from '../../lib/sidebarCounts'
import { getIssueOnCountSnapshot, subscribeIssueOnCount } from '../../lib/issueOnCountBroadcast'
import { HR_MY_OPEN_TASK_COUNT_EVENT, loadHrMyOpenTaskCount } from '../../lib/hrTaskBadge'
import {
  FiCheckCircle,
  FiDollarSign,
  FiClipboard,
  FiSearch,
  FiTruck,
  FiShoppingBag,
  FiImage,
  FiHome,
  FiGlobe,
  FiShoppingCart,
  FiBarChart2,
  FiBookOpen,
  FiSettings,
  FiUsers,
  FiUser,
} from 'react-icons/fi'
import { LuWarehouse, LuGauge, LuPackageOpen, LuClipboardList } from 'react-icons/lu'
import { MdConveyorBelt, MdTrolley } from 'react-icons/md'

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
    roles: ['superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account'],
  },
  {
    key: 'marketplace',
    label: 'Marketplace',
    icon: <FiGlobe className="w-6 h-6" />,
    path: '/marketplace',
    roles: ['superadmin', 'admin', 'sales-tr'],
  },
  {
    key: 'orders',
    label: 'ออเดอร์',
    icon: (
      <span className="relative block h-6 w-6" aria-hidden="true">
        <FiUser className="absolute left-0 top-0 h-5 w-5" />
        <LuClipboardList className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 stroke-[2.5]" />
      </span>
    ),
    path: '/orders',
    roles: ['superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account'],
  },
  {
    key: 'admin-qc',
    label: 'รอตรวจคำสั่งซื้อ',
    icon: <FiCheckCircle className="w-6 h-6" />,
    path: '/admin-qc',
    roles: ['superadmin', 'admin', 'sales-tr', 'qc_order'],
  },
  {
    key: 'plan',
    label: 'Plan',
    icon: <FiClipboard className="w-6 h-6" />,
    path: '/plan',
    roles: ['superadmin', 'admin', 'sales-tr', 'sales-pump', 'production'],
  },
  {
    key: 'machinery',
    label: 'Machinery',
    icon: <MdConveyorBelt className="w-6 h-6" />,
    path: '/machinery',
    roles: ['superadmin', 'admin', 'production'],
  },
  {
    key: 'wms',
    label: 'จัดสินค้า',
    icon: <MdTrolley className="h-6 w-6" />,
    path: '/wms',
    roles: ['superadmin', 'admin', 'sales-tr', 'store', 'production'],
  },
  {
    key: 'qc',
    label: 'QC Operation',
    icon: <FiSearch className="w-6 h-6" />,
    path: '/qc',
    roles: ['superadmin', 'admin', 'sales-tr', 'qc_staff', 'production'],
  },
  {
    key: 'packing',
    label: 'แพ็คสินค้า',
    icon: <LuPackageOpen className="w-6 h-6" />,
    path: '/packing',
    roles: ['superadmin', 'admin', 'sales-tr', 'packing_staff', 'production'],
  },
  {
    key: 'transport',
    label: 'ทวนสอบขนส่ง',
    icon: <FiTruck className="w-6 h-6" />,
    path: '/transport',
    roles: ['superadmin', 'admin', 'sales-tr', 'packing_staff', 'account'],
  },
  {
    key: 'account',
    label: 'บัญชี',
    icon: <FiDollarSign className="w-6 h-6" />,
    path: '/account',
    roles: ['superadmin', 'admin', 'sales-tr', 'sales-pump', 'account'],
  },
  {
    key: 'products',
    label: 'สินค้า',
    icon: <FiShoppingBag className="w-6 h-6" />,
    path: '/products',
    roles: ['superadmin', 'admin', 'sales-tr', 'sales-pump'],
  },
  {
    key: 'cartoon-patterns',
    label: 'ลายการ์ตูน',
    icon: <FiImage className="w-6 h-6" />,
    path: '/cartoon-patterns',
    roles: ['superadmin', 'admin', 'sales-tr', 'sales-pump'],
  },
  {
    key: 'warehouse',
    label: 'คลัง',
    icon: <LuWarehouse className="w-6 h-6" />,
    path: '/warehouse',
    roles: ['superadmin', 'admin', 'sales-tr', 'store', 'account'],
  },
  {
    key: 'purchase',
    label: 'สั่งซื้อ',
    icon: <FiShoppingCart className="w-6 h-6" />,
    path: '/purchase/pr',
    roles: ['superadmin', 'admin', 'sales-tr', 'store', 'account'],
  },
  {
    key: 'sales-reports',
    label: 'รายงานยอดขาย',
    icon: <FiBarChart2 className="w-6 h-6" />,
    path: '/sales-reports',
    roles: ['superadmin', 'admin', 'sales-tr'],
  },
  {
    key: 'kpi',
    label: 'KPI',
    icon: <LuGauge className="w-6 h-6" />,
    path: '/kpi',
    roles: ['superadmin', 'admin', 'sales-tr'],
  },
  {
    key: 'hr',
    label: 'HR',
    icon: <FiUsers className="w-6 h-6" />,
    path: '/hr',
    roles: ['superadmin', 'admin', 'hr', 'account'],
  },
  {
    key: 'settings',
    label: 'ตั้งค่า',
    icon: <FiSettings className="w-6 h-6" />,
    path: '/settings',
    roles: ['superadmin', 'admin', 'sales-tr'],
  },
  {
    key: 'knowledge-hub',
    label: 'Knowledge Hub',
    icon: <FiBookOpen className="w-6 h-6" />,
    path: '/knowledge-hub',
    roles: ['superadmin'],
  },
]

interface SidebarProps {
  isOpen: boolean
  onToggle?: () => void
}

/** เมนูที่แสดงตัวเลขจำนวนแบบเรียลไทม์ */
const MENU_KEYS_WITH_COUNT = [
  'marketplace',
  'orders',
  'admin-qc',
  'plan',
  'machinery',
  'account',
  'wms',
  'qc',
  'packing',
  'warehouse',
  'purchase',
  'hr',
] as const

export default function Sidebar({ isOpen }: SidebarProps) {
  const location = useLocation()
  const { user } = useAuthContext()
  const [menuCounts, setMenuCounts] = useState<Record<string, number>>({
    marketplace: 0,
    orders: 0,
    'admin-qc': 0,
    plan: 0,
    machinery: 0,
    account: 0,
    wms: 0,
    qc: 0,
    packing: 0,
    warehouse: 0,
    purchase: 0,
    hr: 0,
  })
  const [machineryAlertCounts, setMachineryAlertCounts] = useState({ warning: 0, critical: 0 })
  /** นับ Issue สถานะ On (จาก TopBar broadcast — ไม่ query เพิ่ม) */
  const planIssueOnCount = useSyncExternalStore(
    subscribeIssueOnCount,
    getIssueOnCountSnapshot,
    getIssueOnCountSnapshot,
  )
  const [hrMyOpenTaskCount, setHrMyOpenTaskCount] = useState(0)
  const { hasAccess, menuAccessLoading, isWmsStoreBackup } = useMenuAccess()

  useEffect(() => {
    if (!hasAccess('hr-tasks') || !user?.id) {
      setHrMyOpenTaskCount(0)
      return
    }

    const loadCount = async () => {
      try {
        setHrMyOpenTaskCount(await loadHrMyOpenTaskCount(user.id))
      } catch (error) {
        console.error('Sidebar HR task count:', error)
      }
    }
    const onCount = (event: Event) => {
      const count = (event as CustomEvent<{ count?: number }>).detail?.count
      if (typeof count === 'number') setHrMyOpenTaskCount(count)
    }

    void loadCount()
    window.addEventListener(HR_MY_OPEN_TASK_COUNT_EVENT, onCount)
    window.addEventListener('hr-tasks-changed', loadCount)
    return () => {
      window.removeEventListener(HR_MY_OPEN_TASK_COUNT_EVENT, onCount)
      window.removeEventListener('hr-tasks-changed', loadCount)
    }
  }, [hasAccess, user?.id])

  const scope = user ? countReadScope(user, isWmsStoreBackup) : ''
  const allowedKey = JSON.stringify(menuItems.filter(item => user?.role === 'technician'
    ? item.key === 'plan' || item.key === 'machinery' : hasAccess(item.key)).map(item => item.key).sort())
  const countContext = useMemo(() => ({
    scope, role: user?.role || '', username: user?.username, email: user?.email,
    allowed: JSON.parse(allowedKey) as string[],
  }), [scope, user?.role, user?.username, user?.email, allowedKey])
  const countReader = useMemo(() => {
    const applied = new Map<SidebarCountGroup, SidebarCountPatch>()
    const batch = createRefreshBatch<SidebarCountGroup>({
      isVisible: () => document.visibilityState === 'visible',
      load: async (groups) => {
        if (!countContext.scope) return
        const results = await readSidebarCounts(countContext, groups)
        if (!batch.isActive()) return
        for (const { group, patch } of results) {
          // A navigation cache hit must not overwrite a newer count broadcast by a page.
          if (applied.get(group) === patch) continue
          applied.set(group, patch)
          if (patch.counts) setMenuCounts(previous => ({ ...previous, ...patch.counts }))
          if (patch.machinery) setMachineryAlertCounts(patch.machinery)
          if (patch.purchase) window.dispatchEvent(new CustomEvent('sidebar-purchase-badge', { detail: patch.purchase }))
          if (patch.warehouse != null) window.dispatchEvent(new CustomEvent('sidebar-warehouse-count', { detail: { count: patch.warehouse } }))
          if (patch.returns != null) window.dispatchEvent(new CustomEvent('sidebar-pending-return-count', { detail: { count: patch.returns } }))
        }
      },
      onError: error => console.error('Sidebar loadCounts:', error),
    })
    return {
      request: batch.request,
      activate: () => { batch.resume() },
      dispose: () => { batch.dispose() },
    }
  }, [countContext])
  useEffect(() => { countReader.activate(); return () => countReader.dispose() }, [countReader])
  const loadCounts = useCallback(() => {
    if (!menuAccessLoading) countReader.request(SIDEBAR_COUNT_GROUPS)
  }, [countReader, menuAccessLoading])
  const refreshCounts = useCallback((groups: readonly SidebarCountGroup[]) => {
    invalidateSidebarCounts(countContext, groups)
    if (!menuAccessLoading) countReader.request(groups)
  }, [countContext, countReader, menuAccessLoading])

  useEffect(() => {
    if (menuAccessLoading || !scope) return
    loadCounts()
    let channel = supabase.channel('sidebar-menu-counts')
    for (const table of SIDEBAR_COUNT_TABLES) {
      const groups = sidebarGroupsForContextTable(countContext, table)
      if (!groups.length) continue
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table },
        payload => refreshCounts(sidebarGroupsForEvent(countContext, table, payload)))
    }
    channel.subscribe(status => { if (status === 'SUBSCRIBED') loadCounts() })
    return () => { void supabase.removeChannel(channel) }
  }, [scope, countContext, menuAccessLoading, loadCounts, refreshCounts])

  // ฟัง event จากหน้า HR (ยื่น/อนุมัติ/ปฏิเสธ ลา/OT) → โหลด count ใหม่ทันที
  useEffect(() => {
    const onHrChanged = () => refreshCounts(['hr'])
    window.addEventListener('hr-counts-changed', onHrChanged)
    return () => window.removeEventListener('hr-counts-changed', onHrChanged)
  }, [refreshCounts])

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
    if (
      [
        '/orders',
        '/admin-qc',
        '/account',
        '/wms',
        '/qc',
        '/packing',
        '/warehouse',
        '/machinery',
        '/purchase/pr',
        '/purchase/po',
        '/purchase/gr',
        '/purchase/receiving-cases',
      ].includes(location.pathname)
    ) {
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
    const onRefresh = () => refreshCounts(SIDEBAR_COUNT_GROUPS)
    window.addEventListener('sidebar-refresh-counts', onRefresh)
    return () => window.removeEventListener('sidebar-refresh-counts', onRefresh)
  }, [refreshCounts])

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

  // ฟัง event จากหน้าจัดซื้อเมื่อมีการเปลี่ยนแปลงข้อมูล
  useEffect(() => {
    const onPurchaseRefresh = () => refreshCounts(['purchase', 'core'])
    window.addEventListener('purchase-badge-refresh', onPurchaseRefresh)
    return () => window.removeEventListener('purchase-badge-refresh', onPurchaseRefresh)
  }, [refreshCounts])

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
    if (user.role === 'technician') return item.key === 'plan' || item.key === 'machinery'
    return hasAccess(item.key)
  })

  return (
    <aside
      className={`fixed left-0 top-0 z-50 flex h-screen w-64 flex-col overflow-hidden border-r border-slate-200 bg-white text-slate-700 transition-all duration-300 md:z-20 ${
        isOpen ? 'translate-x-0 md:w-64' : '-translate-x-full md:w-20 md:translate-x-0'
      }`}
    >
      <div className="relative flex h-16 items-center justify-center border-b border-slate-200 px-3">
        <div className="flex items-center gap-3">
          <img
            src="/icon.png?v=2"
            alt="TR-ERP"
            className="block h-10 w-10 flex-shrink-0 rounded-lg object-contain"
          />
          {isOpen && (
            <h1 className="m-0 text-2xl font-semibold leading-none text-slate-900 tracking-tight">
              TR-ERP
            </h1>
          )}
        </div>
        {isOpen && (
          <span className="absolute bottom-1 right-2 text-[10px] leading-none text-slate-400">V {__APP_VERSION__}</span>
        )}
      </div>

      <nav className="p-4 flex-1 overflow-y-auto scrollbar-none" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        <ul className="space-y-2">
          {filteredMenuItems.map((item) => {
            const itemPath = item.key === 'purchase' && user?.role === 'store' ? '/purchase/gr' : item.path
            const isActive = item.key === 'purchase'
              ? location.pathname.startsWith('/purchase')
              : location.pathname === item.path || location.pathname.startsWith(item.path + '/')
            const baseCount = menuCounts[item.key] ?? 0
            /** คลัง: แสดงเฉพาะจำนวน "ถึงจุดสั่งซื้อ" (ไม่บวกคืนของค้าง — แยก badge ที่แท็บคืนของ) */
            const displayCount = baseCount
            const withCount = MENU_KEYS_WITH_COUNT.includes(item.key as (typeof MENU_KEYS_WITH_COUNT)[number])
            const isPlan = item.key === 'plan'
            const isHr = item.key === 'hr'
            const isMachinery = item.key === 'machinery'
            const planShowBadges = isPlan && (baseCount > 0 || planIssueOnCount > 0)
            const hrShowBadges = isHr && (baseCount > 0 || hrMyOpenTaskCount > 0)
            const machineryShowBadges = isMachinery && (machineryAlertCounts.warning > 0 || machineryAlertCounts.critical > 0)
            const showDefaultBadge = withCount && displayCount > 0 && !isPlan && !isHr && !isMachinery
            return (
              <li key={item.key}>
                <Link
                  to={itemPath}
                  className={`relative flex items-center gap-3 rounded-xl transition-colors font-medium ${
                    isOpen ? 'px-4 py-3' : 'px-3 py-3 justify-center'
                  } ${
                    isActive
                      ? 'bg-emerald-50 text-emerald-900 ring-1 ring-emerald-100 font-semibold'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                  title={!isOpen ? item.label : undefined}
                >
                  <span
                    className={`text-2xl flex-shrink-0 transition-colors ${
                      isActive ? 'text-emerald-600' : 'text-slate-500'
                    }`}
                  >
                    {item.icon}
                  </span>
                  {isOpen ? (
                    <span className="whitespace-nowrap flex items-center gap-1.5 text-base">
                      {item.label}
                      {isMachinery ? (
                        <>
                          {machineryAlertCounts.warning > 0 && (
                            <span className="min-w-[1.4rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold shadow-sm bg-amber-400 text-amber-950" title="ปิดเครื่อง">
                              {machineryAlertCounts.warning > 99 ? '99+' : machineryAlertCounts.warning}
                            </span>
                          )}
                          {machineryAlertCounts.critical > 0 && (
                            <span className="min-w-[1.4rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold shadow-sm bg-red-500 text-white" title="เครื่องเสีย + กำลังซ่อม">
                              {machineryAlertCounts.critical > 99 ? '99+' : machineryAlertCounts.critical}
                            </span>
                          )}
                        </>
                      ) : isPlan ? (
                        <>
                          {baseCount > 0 && (
                            <span className="min-w-[1.4rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold shadow-sm bg-amber-400 text-amber-950">
                              {baseCount > 99 ? '99+' : baseCount}
                            </span>
                          )}
                          {planIssueOnCount > 0 && (
                            <span className="min-w-[1.4rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold shadow-sm bg-red-500 text-white">
                              {planIssueOnCount > 99 ? '99+' : planIssueOnCount}
                            </span>
                          )}
                        </>
                      ) : isHr ? (
                        <>
                          {baseCount > 0 && (
                            <span className="min-w-[1.4rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold shadow-sm bg-amber-400 text-amber-950" title="รายการ HR รออนุมัติ">
                              {baseCount > 99 ? '99+' : baseCount}
                            </span>
                          )}
                          {hrMyOpenTaskCount > 0 && (
                            <span className="min-w-[1.4rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold shadow-sm bg-red-500 text-white" title="งานของฉันที่ยังไม่เสร็จ">
                              {hrMyOpenTaskCount > 99 ? '99+' : hrMyOpenTaskCount}
                            </span>
                          )}
                        </>
                      ) : (
                        showDefaultBadge && (
                          <span
                            className={`min-w-[1.4rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold shadow-sm ${
                              item.key === 'warehouse' ? 'bg-orange-500 text-white' : 'bg-amber-400 text-amber-950'
                            }`}
                          >
                            {displayCount > 99 ? '99+' : displayCount}
                          </span>
                        )
                      )}
                    </span>
                  ) : machineryShowBadges ? (
                    <span className="absolute -top-1 -right-1 flex flex-row-reverse items-center gap-0.5 pointer-events-none">
                      {machineryAlertCounts.critical > 0 && (
                        <span className="min-w-[1.2rem] h-[1.2rem] px-1 flex items-center justify-center rounded-full text-[10px] font-bold shadow-sm bg-red-500 text-white">
                          {machineryAlertCounts.critical > 99 ? '99+' : machineryAlertCounts.critical}
                        </span>
                      )}
                      {machineryAlertCounts.warning > 0 && (
                        <span className="min-w-[1.2rem] h-[1.2rem] px-1 flex items-center justify-center rounded-full text-[10px] font-bold shadow-sm bg-amber-400 text-amber-950">
                          {machineryAlertCounts.warning > 99 ? '99+' : machineryAlertCounts.warning}
                        </span>
                      )}
                    </span>
                  ) : planShowBadges ? (
                    <span className="absolute -top-1 -right-1 flex flex-row-reverse items-center gap-0.5 pointer-events-none">
                      {planIssueOnCount > 0 && (
                        <span className="min-w-[1.2rem] h-[1.2rem] px-1 flex items-center justify-center rounded-full text-[10px] font-bold shadow-sm bg-red-500 text-white">
                          {planIssueOnCount > 99 ? '99+' : planIssueOnCount}
                        </span>
                      )}
                      {baseCount > 0 && (
                        <span className="min-w-[1.2rem] h-[1.2rem] px-1 flex items-center justify-center rounded-full text-[10px] font-bold shadow-sm bg-amber-400 text-amber-950">
                          {baseCount > 99 ? '99+' : baseCount}
                        </span>
                      )}
                    </span>
                  ) : hrShowBadges ? (
                    <span className="absolute -top-1 -right-1 flex flex-row-reverse items-center gap-0.5 pointer-events-none">
                      {hrMyOpenTaskCount > 0 && (
                        <span className="min-w-[1.2rem] h-[1.2rem] px-1 flex items-center justify-center rounded-full text-[10px] font-bold shadow-sm bg-red-500 text-white">
                          {hrMyOpenTaskCount > 99 ? '99+' : hrMyOpenTaskCount}
                        </span>
                      )}
                      {baseCount > 0 && (
                        <span className="min-w-[1.2rem] h-[1.2rem] px-1 flex items-center justify-center rounded-full text-[10px] font-bold shadow-sm bg-amber-400 text-amber-950">
                          {baseCount > 99 ? '99+' : baseCount}
                        </span>
                      )}
                    </span>
                  ) : (
                    showDefaultBadge && (
                      <span
                        className={`absolute -top-1 -right-1 min-w-[1.2rem] h-[1.2rem] px-1 flex items-center justify-center rounded-full text-[10px] font-bold shadow-sm ${
                          item.key === 'warehouse' ? 'bg-orange-500 text-white' : 'bg-amber-400 text-amber-950'
                        }`}
                      >
                        {displayCount > 99 ? '99+' : displayCount}
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
