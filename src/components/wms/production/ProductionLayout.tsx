import { useState } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import CreateRequisition from './CreateRequisition'
import RequisitionList from './RequisitionList'
import ProductionWorkQueue from './ProductionWorkQueue'
import ProductionReturn from './ProductionReturn'
import ProductionParcelReturn from './ProductionParcelReturn'
import { useWmsModal } from '../useWmsModal'

type ViewKey = 'menu' | 'queue' | 'withdraw' | 'return' | 'parcel-return'
type WithdrawTab = 'create' | 'list'

const MENU_ITEMS: { key: ViewKey; label: string; icon: string; desc: string; color: string }[] = [
  { key: 'queue', label: 'บันทึกคิวงาน', icon: 'fas fa-clipboard-list', desc: 'ลงเวลาเริ่ม/เสร็จขั้นตอนการผลิต', color: 'from-blue-600 to-blue-800' },
  { key: 'withdraw', label: 'เบิกของ', icon: 'fas fa-dolly', desc: 'สร้างใบเบิกสินค้า/วัตถุดิบ', color: 'from-emerald-600 to-emerald-800' },
  { key: 'return', label: 'คืนของ', icon: 'fas fa-undo-alt', desc: 'คืนสินค้า/วัตถุดิบเข้าคลัง', color: 'from-orange-600 to-orange-800' },
  { key: 'parcel-return', label: 'รับสินค้าตีกลับ', icon: 'fas fa-barcode', desc: 'สแกนเลขพัสดุรับคืนจากลูกค้า', color: 'from-purple-600 to-purple-800' },
]

export default function ProductionLayout() {
  const { user, signOut } = useAuthContext()
  const [activeView, setActiveView] = useState<ViewKey>('menu')
  const [withdrawTab, setWithdrawTab] = useState<WithdrawTab>('create')
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

  const activeLabel = MENU_ITEMS.find((m) => m.key === activeView)?.label || ''

  return (
    <div className="min-h-screen w-full bg-slate-900 text-white flex flex-col overflow-hidden rounded-none">
      {/* Header */}
      <header className="p-3 border-b border-slate-800 flex justify-between items-center gap-2 bg-slate-900/90 sticky top-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          {activeView !== 'menu' && (
            <button
              type="button"
              onClick={() => setActiveView('menu')}
              className="shrink-0 w-9 h-9 rounded-xl bg-slate-700 text-white flex items-center justify-center hover:bg-slate-600 active:bg-slate-500"
            >
              <i className="fas fa-arrow-left text-sm" />
            </button>
          )}
          <div className="flex flex-col min-w-0">
            <span className="text-xs text-gray-500 font-bold uppercase truncate">
              {activeView === 'menu' ? 'ฝ่ายผลิต' : activeLabel}
            </span>
            <span className="text-sm font-black text-blue-400 leading-tight truncate">
              {user?.username || user?.email || '---'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {activeView === 'withdraw' && (
            <>
              <button
                onClick={() => setWithdrawTab('create')}
                className={`px-3 py-1.5 rounded-xl font-bold text-xs transition-all ${
                  withdrawTab === 'create' ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-700 text-gray-300'
                }`}
              >
                <i className="fas fa-plus-circle mr-1" />
                <span className="hidden sm:inline">สร้างใบเบิก</span>
                <span className="sm:hidden">สร้าง</span>
              </button>
              <button
                onClick={() => setWithdrawTab('list')}
                className={`px-3 py-1.5 rounded-xl font-bold text-xs transition-all ${
                  withdrawTab === 'list' ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-700 text-gray-300'
                }`}
              >
                <i className="fas fa-list mr-1" />
                <span className="hidden sm:inline">รายการใบเบิก</span>
                <span className="sm:hidden">รายการ</span>
              </button>
            </>
          )}
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

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeView === 'menu' && (
          <div className="p-4 space-y-3">
            <div className="text-center py-4">
              <div className="text-2xl font-black text-white">ฝ่ายผลิต</div>
              <div className="text-sm text-gray-400 mt-1">เลือกเมนูที่ต้องการ</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {MENU_ITEMS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveView(item.key)}
                  className={`rounded-2xl bg-gradient-to-br ${item.color} p-4 text-left transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg`}
                >
                  <i className={`${item.icon} text-2xl text-white/80 mb-3 block`} />
                  <div className="font-bold text-base text-white leading-tight">{item.label}</div>
                  <div className="text-[10px] text-white/60 mt-1 leading-tight">{item.desc}</div>
                </button>
              ))}
            </div>
          </div>
        )}
        {activeView === 'queue' && <ProductionWorkQueue />}
        {activeView === 'withdraw' && (
          <>
            {withdrawTab === 'create' && <CreateRequisition />}
            {withdrawTab === 'list' && <RequisitionList />}
          </>
        )}
        {activeView === 'return' && <ProductionReturn />}
        {activeView === 'parcel-return' && <ProductionParcelReturn />}
      </div>
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
