import { useState } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import ApprovalList from './ApprovalList'
import { useWmsModal } from '../useWmsModal'

export default function ManagerLayout() {
  const { user, signOut } = useAuthContext()
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
      <header className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/90 sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <div className="flex flex-col">
            <span className="text-sm text-gray-500 font-bold uppercase">ผู้จัดการ</span>
            <span className="text-lg font-black text-blue-400 leading-tight">{user?.username || user?.email || '---'}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          disabled={loggingOut}
          className="bg-red-600 hover:bg-red-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg disabled:opacity-50"
        >
          {loggingOut ? 'กำลังออก...' : 'ออกจากระบบ'}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <ApprovalList />
      </div>
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
