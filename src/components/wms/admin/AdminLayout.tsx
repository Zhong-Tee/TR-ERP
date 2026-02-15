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
import { WMS_MENU_KEYS, WMS_COUNTED_KEYS, loadWmsTabCounts } from '../wmsUtils'

export default function AdminLayout() {
  const { user } = useAuthContext()
  const [activeMenu, setActiveMenu] = useState(WMS_MENU_KEYS.NEW_ORDERS)
  const { MessageModal, ConfirmModal } = useWmsModal()
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({})

  const loadTabCounts = useCallback(async () => {
    try {
      const { counts, total } = await loadWmsTabCounts()
      setTabCounts(counts)
      // แจ้ง sidebar ให้อัปเดตตัวเลข
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
    { key: WMS_MENU_KEYS.NEW_ORDERS, label: 'ใบงานใหม่' },
    { key: WMS_MENU_KEYS.UPLOAD, label: 'รายการใบงาน' },
    { key: WMS_MENU_KEYS.REVIEW, label: 'ตรวจสินค้า' },
    { key: WMS_MENU_KEYS.KPI, label: 'KPI' },
    { key: WMS_MENU_KEYS.REQUISITION, label: 'รายการเบิก' },
    { key: WMS_MENU_KEYS.NOTIF, label: 'แจ้งเตือน' },
    ...(user?.role !== 'store' ? [{ key: WMS_MENU_KEYS.SETTINGS, label: 'ตั้งค่า' }] : []),
  ]

  return (
    <div className="w-full">
      {/* เมนูย่อย — สไตล์เดียวกับเมนูออเดอร์ */}
      <div className="sticky top-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6 px-6">
        <div className="w-full px-4 sm:px-6 lg:px-8 overflow-x-auto scrollbar-thin">
          <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3" aria-label="Tabs">
            {menuItems.map((item) => {
              const count = tabCounts[item.key] ?? 0
              const showBadge = WMS_COUNTED_KEYS.includes(item.key) && count > 0
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
        {activeMenu === WMS_MENU_KEYS.UPLOAD && <UploadSection />}
        {activeMenu === WMS_MENU_KEYS.NEW_ORDERS && <NewOrdersSection />}
        {activeMenu === WMS_MENU_KEYS.REVIEW && <ReviewSection />}
        {activeMenu === WMS_MENU_KEYS.KPI && <KPISection />}
        {activeMenu === WMS_MENU_KEYS.REQUISITION && <RequisitionDashboard />}
        {activeMenu === WMS_MENU_KEYS.NOTIF && <NotificationSection />}
        {activeMenu === WMS_MENU_KEYS.SETTINGS && user?.role !== 'store' && <SettingsSection />}
      </div>
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
