import { useNavigate } from 'react-router-dom'
import { useAuthContext } from '../contexts/AuthContext'
import {
  MOBILE_MODE_INFO,
  getMobileAccess,
  setActiveMobileMode,
  setDesktopOverride,
  type MobileMode,
} from '../lib/mobileMode'
import { FiMonitor, FiLogOut, FiUser, FiChevronRight } from 'react-icons/fi'

/**
 * หน้าเลือกโหมดการใช้งาน — แสดงปุ่มเข้า role มือถือต่างๆ ที่ user นี้เปิดสิทธิ์ไว้
 * (us_users.mobile_access + employee_access) และปุ่มเข้าโหมด PC Desktop
 */
export default function ModeLauncher() {
  const { user, signOut } = useAuthContext()
  const navigate = useNavigate()

  if (!user) return null

  const modes = getMobileAccess(user)

  const enterMode = (mode: MobileMode) => {
    setActiveMobileMode(mode)
    navigate(MOBILE_MODE_INFO[mode].path)
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
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <header className="flex items-center justify-between px-5 py-4">
        <div>
          <h1 className="text-lg font-bold text-gray-800">TR-ERP</h1>
          <p className="text-xs text-gray-500">
            {user.username || user.email} <span className="text-gray-400">({user.role})</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => signOut()}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-600 bg-white rounded-xl shadow-sm hover:bg-red-50"
        >
          <FiLogOut /> ออกจากระบบ
        </button>
      </header>

      <main className="flex-1 px-5 pb-8 max-w-md w-full mx-auto">
        <h2 className="text-base font-semibold text-gray-700 mt-2 mb-3">เลือกโหมดการใช้งาน</h2>

        <div className="space-y-3">
          {modes.map((mode) => {
            const info = MOBILE_MODE_INFO[mode]
            return (
              <button
                key={mode}
                type="button"
                onClick={() => enterMode(mode)}
                className="w-full flex items-center gap-4 p-4 bg-white rounded-2xl shadow-sm hover:shadow-md hover:-translate-y-0.5 transition text-left"
              >
                <span className="text-3xl" aria-hidden>{info.emoji}</span>
                <span className="flex-1 min-w-0">
                  <span className="block font-bold text-gray-800">{info.label}</span>
                  <span className="block text-xs text-gray-500">{info.description}</span>
                </span>
                <FiChevronRight className="text-gray-300 shrink-0" />
              </button>
            )
          })}

          {showEmployee && (
            <button
              type="button"
              onClick={enterEmployee}
              className="w-full flex items-center gap-4 p-4 bg-white rounded-2xl shadow-sm hover:shadow-md hover:-translate-y-0.5 transition text-left"
            >
              <span className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 shrink-0">
                <FiUser className="w-5 h-5" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block font-bold text-gray-800">Employee Portal</span>
                <span className="block text-xs text-gray-500">ลงเวลา ขอลา เอกสารพนักงาน</span>
              </span>
              <FiChevronRight className="text-gray-300 shrink-0" />
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
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-xs text-gray-400">หรือ</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>

            <button
              type="button"
              onClick={enterDesktop}
              className="w-full flex items-center justify-center gap-2 p-4 bg-gray-800 text-white rounded-2xl shadow-sm hover:bg-gray-900 transition font-bold"
            >
              <FiMonitor /> เข้าโหมด PC Desktop
            </button>
          </>
        )}
      </main>

      <footer className="pb-5 text-center text-xs text-gray-400">V.{__APP_VERSION__}</footer>
    </div>
  )
}
