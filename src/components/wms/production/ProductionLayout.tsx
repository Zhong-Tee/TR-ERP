import { useState } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import CreateRequisition from './CreateRequisition'
import RequisitionList from './RequisitionList'
import { useWmsModal } from '../useWmsModal'

const MENU_KEYS = {
  CREATE: 'create',
  LIST: 'list',
}

export default function ProductionLayout() {
  const { user, signOut } = useAuthContext()
  const [activeMenu, setActiveMenu] = useState(MENU_KEYS.CREATE)
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()
  const [loggingOut, setLoggingOut] = useState(false)

  const handleLogout = async () => {
    const ok = await showConfirm({ title: 'ออกจากระบบ', message: 'ยืนยันออกจากระบบ?' })
    if (!ok) return
    setLoggingOut(true)
    try {
      await signOut()
    } catch (error: any) {
      showMessage({ message: 'เกิดข้อผิดพลาด: ' + error.message })
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <div className="min-h-screen w-full bg-slate-900 text-white flex flex-col overflow-hidden rounded-none">
      <header className="p-3 border-b border-slate-800 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 bg-slate-900/90 sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <div className="flex flex-col">
            <span className="text-xs text-gray-500 font-bold uppercase">ฝ่ายผลิต</span>
            <span className="text-base font-black text-blue-400 leading-tight">{user?.username || user?.email || '---'}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setActiveMenu(MENU_KEYS.CREATE)}
            className={`px-3 py-1.5 rounded-xl font-bold text-xs transition-all ${
              activeMenu === MENU_KEYS.CREATE ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-700 text-gray-300'
            }`}
          >
            <i className="fas fa-plus-circle mr-1"></i>
            <span className="hidden sm:inline">สร้างใบเบิก</span>
            <span className="sm:hidden">สร้าง</span>
          </button>
          <button
            onClick={() => setActiveMenu(MENU_KEYS.LIST)}
            className={`px-3 py-1.5 rounded-xl font-bold text-xs transition-all ${
              activeMenu === MENU_KEYS.LIST ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-700 text-gray-300'
            }`}
          >
            <i className="fas fa-list mr-1"></i>
            <span className="hidden sm:inline">รายการใบเบิก</span>
            <span className="sm:hidden">รายการ</span>
          </button>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="bg-red-600 hover:bg-red-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            {loggingOut ? 'กำลังออก...' : 'ออกจากระบบ'}
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {activeMenu === MENU_KEYS.CREATE && <CreateRequisition />}
        {activeMenu === MENU_KEYS.LIST && <RequisitionList />}
      </div>
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
