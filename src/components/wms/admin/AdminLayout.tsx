import { useState, useEffect, useCallback, useMemo } from 'react'
import { useMenuAccess } from '../../../contexts/MenuAccessContext'
import { useAuthContext } from '../../../contexts/AuthContext'
import { countReadScope, createRefreshBatch, operationalCountCache } from '../../../lib/readRefresh'
import { supabase } from '../../../lib/supabase'
import UploadSection from './UploadSection'
import ReviewSection from './ReviewSection'
import KPISection from './KPISection'
import RequisitionDashboard from './RequisitionDashboard'
import ReturnRequisitionDashboard from './ReturnRequisitionDashboard'
import BorrowRequisitionDashboard from './BorrowRequisitionDashboard'
import NotificationSection from './NotificationSection'
import StockAnomalySection from './StockAnomalySection'
import SettingsSection from './SettingsSection'
import { useWmsModal } from '../useWmsModal'
import NewOrdersSection from './NewOrdersSection'
import { WMS_MENU_KEYS, WMS_COUNTED_KEYS, loadWmsTabCounts } from '../wmsUtils'

export default function AdminLayout() {
  const { hasAccess, menuAccessLoading, isWmsStoreBackup } = useMenuAccess()
  const { user } = useAuthContext()
  const scope = user ? countReadScope(user, isWmsStoreBackup) : ''
  const [activeMenu, setActiveMenu] = useState<string>('')
  const { MessageModal, ConfirmModal } = useWmsModal({ showCancelButton: false })
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({})

  const reader = useMemo(() => {
    const batch = createRefreshBatch<'wms'>({
      delayMs: 500,
      isVisible: () => document.visibilityState === 'visible',
      load: async () => {
        if (!scope) return
        const { counts, total } = await loadWmsTabCounts(scope)
        if (!batch.isActive()) return
        setTabCounts(counts)
        window.dispatchEvent(new CustomEvent('wms-counts-updated', { detail: { total, counts } }))
      },
      onError: error => console.error('Error loading WMS tab counts:', error),
    })
    return { request: () => batch.request(['wms']),
      activate: () => { batch.resume() },
      dispose: () => { batch.dispose() } }
  }, [scope])
  useEffect(() => { reader.activate(); return () => reader.dispose() }, [reader])
  const loadTabCounts = useCallback(() => {
    if (!menuAccessLoading) reader.request()
  }, [reader, menuAccessLoading])
  const debouncedLoadTabCounts = useCallback(() => {
    operationalCountCache.invalidate(`wms:${scope}`)
    loadTabCounts()
  }, [scope, loadTabCounts])

  // Realtime: รวม channel เดียว + debounce เพื่อลด API calls
  useEffect(() => {
    loadTabCounts()
    const channel = supabase
      .channel('wms-tab-counts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_work_orders' }, () => debouncedLoadTabCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_orders' }, () => debouncedLoadTabCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_requisitions' }, () => debouncedLoadTabCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_notifications' }, () => debouncedLoadTabCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_return_requisitions' }, () => debouncedLoadTabCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_borrow_requisitions' }, () => debouncedLoadTabCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, () => debouncedLoadTabCounts())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [loadTabCounts, debouncedLoadTabCounts])

  // ฟัง event จาก child sections เมื่อข้อมูลเปลี่ยน → อัปเดตตัวเลข badge ทันที
  useEffect(() => {
    const onDataChanged = () => debouncedLoadTabCounts()
    window.addEventListener('wms-data-changed', onDataChanged)
    return () => window.removeEventListener('wms-data-changed', onDataChanged)
  }, [debouncedLoadTabCounts])

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') loadTabCounts() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [loadTabCounts])

  const menuItems = [
    { key: WMS_MENU_KEYS.NEW_ORDERS, label: 'ใบงานใหม่' },
    { key: WMS_MENU_KEYS.UPLOAD, label: 'รายการใบงาน' },
    { key: WMS_MENU_KEYS.REVIEW, label: 'ตรวจสินค้า' },
    { key: WMS_MENU_KEYS.KPI, label: 'KPI' },
    { key: WMS_MENU_KEYS.REQUISITION, label: 'รายการเบิก' },
    { key: WMS_MENU_KEYS.RETURN_REQUISITION, label: 'รายการคืน' },
    { key: WMS_MENU_KEYS.BORROW_REQUISITION, label: 'รายการยืม' },
    { key: WMS_MENU_KEYS.NOTIF, label: 'แจ้งเตือน' },
    { key: WMS_MENU_KEYS.STOCK_ANOMALY, label: 'สต๊อคผิดปกติ' },
    { key: WMS_MENU_KEYS.SETTINGS, label: 'ตั้งค่า' },
  ].filter((item) => hasAccess(item.key))

  useEffect(() => {
    if (!menuAccessLoading && menuItems.length > 0 && !menuItems.some((m) => m.key === activeMenu)) {
      setActiveMenu(menuItems[0].key)
    }
  }, [menuAccessLoading, menuItems, activeMenu])

  return (
    <div className="w-full">
      {/* เมนูย่อย — สไตล์เดียวกับเมนูออเดอร์ */}
      <div className="sticky top-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6">
        <div className="w-full overflow-x-auto px-2 scrollbar-thin sm:px-4 md:px-6 lg:px-8">
          <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3" aria-label="Tabs">
            {menuItems.map((item) => {
              const count = tabCounts[item.key] ?? 0
              const showBadge = (WMS_COUNTED_KEYS as readonly string[]).includes(item.key) && count > 0
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
                    <span title={item.key === WMS_MENU_KEYS.BORROW_REQUISITION ? 'จำนวนใบยืมเลยกำหนด' : undefined} className="ml-1.5 inline-flex items-center justify-center min-w-[1.3rem] h-5 px-1.5 rounded-full text-xs font-bold bg-red-500 text-white">
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
        {activeMenu === WMS_MENU_KEYS.RETURN_REQUISITION && <ReturnRequisitionDashboard />}
        {activeMenu === WMS_MENU_KEYS.BORROW_REQUISITION && <BorrowRequisitionDashboard />}
        {activeMenu === WMS_MENU_KEYS.NOTIF && <NotificationSection />}
        {activeMenu === WMS_MENU_KEYS.STOCK_ANOMALY && <StockAnomalySection />}
        {activeMenu === WMS_MENU_KEYS.SETTINGS && <SettingsSection />}
      </div>
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
