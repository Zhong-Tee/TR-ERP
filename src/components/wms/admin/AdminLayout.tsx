import { useState } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
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

export default function AdminLayout() {
  const { user } = useAuthContext()
  const [activeMenu, setActiveMenu] = useState(MENU_KEYS.NEW_ORDERS)
  const { MessageModal, ConfirmModal } = useWmsModal()

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
            {menuItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveMenu(item.key)}
                className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap flex-shrink-0 transition-colors ${
                  activeMenu === item.key
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-blue-600'
                }`}
              >
                {item.label}
              </button>
            ))}
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
