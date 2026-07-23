import { useNavigate } from 'react-router-dom'
import { useAuthContext } from '../contexts/AuthContext'
import {
  MOBILE_MODE_INFO,
  getSelectableMobileModes,
  setActiveMobileMode,
  setDesktopOverride,
  type MobileMode,
} from '../lib/mobileMode'
import { FiMonitor, FiLogOut, FiUser, FiChevronRight } from 'react-icons/fi'

const MODE_CARD_CLASS: Record<MobileMode, string> = {
  production_mb: 'from-blue-600 to-blue-800 border-blue-500',
  manager: 'from-violet-600 to-violet-800 border-violet-500',
  technician: 'from-blue-600 to-indigo-800 border-blue-500',
  picker: 'from-amber-500 to-orange-700 border-amber-400',
  auditor: 'from-cyan-600 to-teal-800 border-cyan-500',
}

/**
 * หน้าเลือกโหมดการใช้งาน — แสดงปุ่มเข้า role มือถือต่างๆ ที่ user นี้เปิดสิทธิ์ไว้
 * (us_users.mobile_access + employee_access) และปุ่มเข้าโหมด PC Desktop
 */
export default function ModeLauncher() {
  const { user, signOut } = useAuthContext()
  const navigate = useNavigate()

  if (!user) return null

  const modes = getSelectableMobileModes(user)

  const enterMode = (mode: MobileMode) => {
    setActiveMobileMode(user.role === mode ? null : mode)
    navigate(mode === 'technician' ? '/machinery' : MOBILE_MODE_INFO[mode].path)
  }

  const enterEmployee = () => {
    setActiveMobileMode(null)
    navigate('/employee')
  }

  const enterDesktop = () => {
    setDesktopOverride()
    navigate('/')
  }

  const showEmployee = user.employee_access === true || user.role === 'employee'

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-50 via-white to-emerald-50 text-slate-800 flex flex-col">
      <header className="flex items-center justify-between px-5 py-4 border-b border-slate-200/80 bg-white/80 backdrop-blur-sm shadow-sm">
        <div>
          <h1 className="text-lg font-black tracking-wide text-slate-800">TR-ERP</h1>
          <p className="text-xs text-slate-500">
            {user.username || user.email} <span className="text-emerald-600">({user.role})</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => signOut()}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-red-600 bg-red-50 border border-red-200 rounded-xl shadow-sm hover:bg-red-100 transition-colors"
        >
          <FiLogOut /> ออกจากระบบ
        </button>
      </header>

      <main className="flex-1 px-5 pb-8 max-w-md w-full mx-auto">
        <div className="mt-5 mb-4">
          <h2 className="text-xl font-bold text-slate-800">เลือกโหมดการใช้งาน</h2>
          <p className="text-xs text-slate-500 mt-1">เลือกพื้นที่ทำงานที่ต้องการเข้าสู่ระบบ</p>
        </div>

        <div className="space-y-3">
          {modes.map((mode) => {
            const info = MOBILE_MODE_INFO[mode]
            return (
              <button
                key={mode}
                type="button"
                onClick={() => enterMode(mode)}
                className={`w-full flex items-center gap-4 p-4 bg-gradient-to-br ${MODE_CARD_CLASS[mode]} rounded-2xl border shadow-sm hover:-translate-y-0.5 hover:shadow-md active:scale-[0.99] transition text-left`}
              >
                <span className="w-12 h-12 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center text-2xl shrink-0 shadow-sm" aria-hidden>{info.emoji}</span>
                <span className="flex-1 min-w-0">
                  <span className="block font-bold text-white">{info.label}</span>
                  <span className="block text-xs text-white/75 mt-0.5">{info.description}</span>
                </span>
                <FiChevronRight className="text-white/60 shrink-0" />
              </button>
            )
          })}

          {showEmployee && (
            <button
              type="button"
              onClick={enterEmployee}
              className="w-full flex items-center gap-4 p-4 bg-gradient-to-br from-emerald-500 to-emerald-700 rounded-2xl border border-emerald-400 shadow-sm hover:-translate-y-0.5 hover:shadow-md active:scale-[0.99] transition text-left"
            >
              <span className="w-12 h-12 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center text-white shrink-0 shadow-sm">
                <FiUser className="w-5 h-5" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block font-bold text-white">Employee Portal</span>
                <span className="block text-xs text-white/75 mt-0.5">ลงเวลา ขอลา เอกสารพนักงาน</span>
              </span>
              <FiChevronRight className="text-white/60 shrink-0" />
            </button>
          )}

          {modes.length === 0 && !showEmployee && (
            <div className="p-4 bg-white rounded-2xl shadow-sm text-sm text-gray-500 text-center">
              ยังไม่ได้เปิดสิทธิ์โหมดมือถือ — เปิดได้ที่ ตั้งค่า → จัดการสิทธิ์ผู้ใช้
            </div>
          )}
        </div>

        {user.role !== 'employee' && (
          <>
            <div className="flex items-center gap-3 my-5">
              <div className="flex-1 h-px bg-slate-200" />
              <span className="text-xs text-slate-400">หรือ</span>
              <div className="flex-1 h-px bg-slate-200" />
            </div>

            <button
              type="button"
              onClick={enterDesktop}
              className="w-full flex items-center justify-center gap-2 p-4 bg-slate-700 text-white rounded-2xl border border-slate-600 shadow-sm hover:bg-slate-800 hover:shadow-md transition font-bold"
            >
              <FiMonitor /> เข้าโหมด PC Desktop
            </button>
          </>
        )}
      </main>

      <footer className="pb-5 text-center text-xs text-slate-400">V.{__APP_VERSION__}</footer>
    </div>
  )
}
