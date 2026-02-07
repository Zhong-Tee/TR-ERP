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
  const [activeMenu, setActiveMenu] = useState(MENU_KEYS.UPLOAD)
  const { MessageModal, ConfirmModal } = useWmsModal()

  return (
    <div className="flex min-h-[calc(100vh-6rem)] flex-col gap-4">
      <div className="bg-white rounded-2xl shadow-sm border px-4 py-3 flex flex-wrap gap-2 items-center">
        <button
          onClick={() => setActiveMenu(MENU_KEYS.NEW_ORDERS)}
          className={`px-4 py-2 rounded-lg text-sm font-bold transition ${
            activeMenu === MENU_KEYS.NEW_ORDERS ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          ใบงานใหม่
        </button>
        <button
          onClick={() => setActiveMenu(MENU_KEYS.UPLOAD)}
          className={`px-4 py-2 rounded-lg text-sm font-bold transition ${
            activeMenu === MENU_KEYS.UPLOAD ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          จัดสินค้า
        </button>
        <button
          onClick={() => setActiveMenu(MENU_KEYS.REVIEW)}
          className={`px-4 py-2 rounded-lg text-sm font-bold transition ${
            activeMenu === MENU_KEYS.REVIEW ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          ตรวจสินค้า
        </button>
        <button
          onClick={() => setActiveMenu(MENU_KEYS.KPI)}
          className={`px-4 py-2 rounded-lg text-sm font-bold transition ${
            activeMenu === MENU_KEYS.KPI ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          KPI
        </button>
        <button
          onClick={() => setActiveMenu(MENU_KEYS.REQUISITION)}
          className={`px-4 py-2 rounded-lg text-sm font-bold transition ${
            activeMenu === MENU_KEYS.REQUISITION ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          รายการเบิก
        </button>
        <button
          onClick={() => setActiveMenu(MENU_KEYS.NOTIF)}
          className={`px-4 py-2 rounded-lg text-sm font-bold transition ${
            activeMenu === MENU_KEYS.NOTIF ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          แจ้งเตือน
        </button>
        {user?.role !== 'store' && (
          <button
            onClick={() => setActiveMenu(MENU_KEYS.SETTINGS)}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition ${
              activeMenu === MENU_KEYS.SETTINGS ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            ตั้งค่า
          </button>
        )}
      </div>
      <main className="flex-1 overflow-y-auto p-6 bg-gray-50 rounded-2xl">
        {activeMenu === MENU_KEYS.UPLOAD && <UploadSection />}
        {activeMenu === MENU_KEYS.NEW_ORDERS && <NewOrdersSection />}
        {activeMenu === MENU_KEYS.REVIEW && <ReviewSection />}
        {activeMenu === MENU_KEYS.KPI && <KPISection />}
        {activeMenu === MENU_KEYS.REQUISITION && <RequisitionDashboard />}
        {activeMenu === MENU_KEYS.NOTIF && <NotificationSection />}
        {activeMenu === MENU_KEYS.SETTINGS && user?.role !== 'store' && <SettingsSection />}
      </main>
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
