import { useState, useEffect, useCallback } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import UploadSection from './UploadSection'
import ReviewSection from './ReviewSection'
import KPISection from './KPISection'
import RequisitionDashboard from './RequisitionDashboard'
import NotificationSection from './NotificationSection'
import SettingsSection from './SettingsSection'
import { useWmsModal } from '../useWmsModal'
import NewOrdersSection from './NewOrdersSection'

const MENU_KEYS = {
  UPLOAD: 'menu-upload',
  NEW_ORDERS: 'menu-new-orders',
  REVIEW: 'menu-review',
  KPI: 'menu-kpi',
  REQUISITION: 'menu-requisition',
  NOTIF: 'menu-notif',
  SETTINGS: 'menu-settings',
}

/** เมนูที่ต้องแสดง badge ตัวเลข */
const COUNTED_KEYS = [MENU_KEYS.NEW_ORDERS, MENU_KEYS.UPLOAD, MENU_KEYS.REVIEW, MENU_KEYS.REQUISITION, MENU_KEYS.NOTIF]

export default function AdminLayout() {
  const { user } = useAuthContext()
  const [activeMenu, setActiveMenu] = useState(MENU_KEYS.NEW_ORDERS)
  const { MessageModal, ConfirmModal } = useWmsModal()
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({})

  const loadTabCounts = useCallback(async () => {
    try {
      const today = new Date().toISOString().split('T')[0]

      // 1. ใบงานใหม่: work orders with status "กำลังผลิต" not yet assigned picker
      const { data: woData } = await supabase
        .from('or_work_orders')
        .select('work_order_name')
        .eq('status', 'กำลังผลิต')
      let newOrdersCount = 0
      if (woData && woData.length > 0) {
        const woNames = woData.map((wo: any) => wo.work_order_name)
        const { data: assignedRows } = await supabase
          .from('wms_orders')
          .select('order_id')
          .in('order_id', woNames)
        const assignedSet = new Set((assignedRows || []).map((r: any) => r.order_id))
        newOrdersCount = woData.filter((wo: any) => !assignedSet.has(wo.work_order_name)).length
      }

      // 2. รายการใบงาน: นับเฉพาะ order_id ที่สถานะภาพรวม = IN PROGRESS (มี item ที่ status เป็น pending/wrong/not_find)
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

      // 3. ตรวจสินค้า: completed orders today that still have unchecked items (picked)
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

      // 4. รายการเบิก: pending requisitions today
      const { count: reqCount } = await supabase
        .from('wms_requisitions')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .gte('created_at', today + 'T00:00:00')
        .lte('created_at', today + 'T23:59:59')

      // 5. แจ้งเตือน: unread notifications
      const { count: notifCount } = await supabase
        .from('wms_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'unread')

      const counts: Record<string, number> = {
        [MENU_KEYS.NEW_ORDERS]: newOrdersCount,
        [MENU_KEYS.UPLOAD]: uploadCount,
        [MENU_KEYS.REVIEW]: reviewCount,
        [MENU_KEYS.REQUISITION]: reqCount ?? 0,
        [MENU_KEYS.NOTIF]: notifCount ?? 0,
      }
      setTabCounts(counts)

      // แจ้ง sidebar ให้อัปเดตตัวเลข
      const total = Object.values(counts).reduce((s, n) => s + n, 0)
      window.dispatchEvent(new CustomEvent('wms-counts-updated', { detail: { total, counts } }))
    } catch (e) {
      console.error('Error loading WMS tab counts:', e)
    }
  }, [])

  useEffect(() => {
    loadTabCounts()
    const ch1 = supabase.channel('wms-tab-cnt-wo').on('postgres_changes', { event: '*', schema: 'public', table: 'or_work_orders' }, () => loadTabCounts()).subscribe()
    const ch2 = supabase.channel('wms-tab-cnt-orders').on('postgres_changes', { event: '*', schema: 'public', table: 'wms_orders' }, () => loadTabCounts()).subscribe()
    const ch3 = supabase.channel('wms-tab-cnt-req').on('postgres_changes', { event: '*', schema: 'public', table: 'wms_requisitions' }, () => loadTabCounts()).subscribe()
    const ch4 = supabase.channel('wms-tab-cnt-notif').on('postgres_changes', { event: '*', schema: 'public', table: 'wms_notifications' }, () => loadTabCounts()).subscribe()
    const ch5 = supabase.channel('wms-tab-cnt-ororders').on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, () => loadTabCounts()).subscribe()
    return () => { [ch1, ch2, ch3, ch4, ch5].forEach((c) => supabase.removeChannel(c)) }
  }, [loadTabCounts])

  // Poll ทุก 15 วินาที
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') loadTabCounts()
    }, 15_000)
    return () => clearInterval(timer)
  }, [loadTabCounts])

  // ฟัง event จาก child sections เมื่อข้อมูลเปลี่ยน → อัปเดตตัวเลข badge ทันที
  useEffect(() => {
    const onDataChanged = () => loadTabCounts()
    window.addEventListener('wms-data-changed', onDataChanged)
    return () => window.removeEventListener('wms-data-changed', onDataChanged)
  }, [loadTabCounts])

  const menuItems = [
    { key: MENU_KEYS.NEW_ORDERS, label: 'ใบงานใหม่' },
    { key: MENU_KEYS.UPLOAD, label: 'รายการใบงาน' },
    { key: MENU_KEYS.REVIEW, label: 'ตรวจสินค้า' },
    { key: MENU_KEYS.KPI, label: 'KPI' },
    { key: MENU_KEYS.REQUISITION, label: 'รายการเบิก' },
    { key: MENU_KEYS.NOTIF, label: 'แจ้งเตือน' },
    ...(user?.role !== 'store' ? [{ key: MENU_KEYS.SETTINGS, label: 'ตั้งค่า' }] : []),
  ]

  return (
    <div className="w-full">
      {/* เมนูย่อย — สไตล์เดียวกับเมนูออเดอร์ */}
      <div className="sticky top-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6 px-6">
        <div className="w-full px-4 sm:px-6 lg:px-8 overflow-x-auto scrollbar-thin">
          <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3" aria-label="Tabs">
            {menuItems.map((item) => {
              const count = tabCounts[item.key] ?? 0
              const showBadge = COUNTED_KEYS.includes(item.key) && count > 0
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveMenu(item.key)}
                  className={`relative py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap flex-shrink-0 transition-colors ${
                    activeMenu === item.key
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-blue-600'
                  }`}
                >
                  {item.label}
                  {showBadge && (
                    <span className="ml-1.5 inline-flex items-center justify-center min-w-[1.3rem] h-5 px-1.5 rounded-full text-xs font-bold bg-red-500 text-white">
                      {count > 99 ? '99+' : count}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>
        </div>
      </div>

      <div className="pt-4">
        {activeMenu === MENU_KEYS.UPLOAD && <UploadSection />}
        {activeMenu === MENU_KEYS.NEW_ORDERS && <NewOrdersSection />}
        {activeMenu === MENU_KEYS.REVIEW && <ReviewSection />}
        {activeMenu === MENU_KEYS.KPI && <KPISection />}
        {activeMenu === MENU_KEYS.REQUISITION && <RequisitionDashboard />}
        {activeMenu === MENU_KEYS.NOTIF && <NotificationSection />}
        {activeMenu === MENU_KEYS.SETTINGS && user?.role !== 'store' && <SettingsSection />}
      </div>
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
