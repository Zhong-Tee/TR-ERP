import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthContext } from '../../../contexts/AuthContext'
import { useWmsModal } from '../useWmsModal'

/**
 * หน้า Home มือถือสำหรับช่างเทคนิค — เลือกเข้า Machinery (รูปแบบเดียวกับ Picker / ฝ่ายผลิต)
 */
export default function TechnicianHome() {
  const navigate = useNavigate()
  const { user, signOut } = useAuthContext()
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()
  const [loggingOut, setLoggingOut] = useState(false)

  const handleLogout = async () => {
    const ok = await showConfirm({ title: 'ออกจากระบบ', message: 'ยืนยันออกจากระบบ?' })
    if (!ok) return
    setLoggingOut(true)
    try {
      await signOut()
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      showMessage({ message: 'เกิดข้อผิดพลาด: ' + msg })
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <div className="min-h-screen w-full bg-slate-900 text-white flex flex-col overflow-hidden rounded-none">
      <header className="p-3 border-b border-slate-800 flex justify-between items-center gap-2 bg-slate-900/90 sticky top-0 z-20">
        <div className="flex flex-col min-w-0">
          <span className="text-xs text-gray-500 font-bold uppercase truncate">ช่างเทคนิค</span>
          <span className="text-sm font-black text-blue-400 leading-tight truncate">
            {user?.username || user?.email || '---'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void handleLogout()}
          disabled={loggingOut}
          className="shrink-0 bg-red-600 hover:bg-red-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg disabled:opacity-50"
        >
          {loggingOut ? 'กำลังออก...' : 'ออกจากระบบ'}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-3">
          <div className="text-center py-4">
            <div className="text-2xl font-black text-white">ช่างเทคนิค</div>
            <div className="text-sm text-gray-400 mt-1">เลือกเมนูที่ต้องการ</div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => navigate('/machinery')}
              className="col-span-2 rounded-2xl bg-gradient-to-br from-slate-600 to-slate-800 p-4 text-left transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg"
            >
              <i className="fas fa-print text-2xl text-white/80 mb-3 block" aria-hidden />
              <div className="font-bold text-base text-white leading-tight">Machinery</div>
              <div className="text-[10px] text-white/60 mt-1 leading-tight">มอนิเตอร์สถานะเครื่องจักร</div>
            </button>
          </div>
        </div>
      </div>
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
