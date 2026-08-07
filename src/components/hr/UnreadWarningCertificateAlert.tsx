import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { FiAlertTriangle, FiAward, FiArrowRight, FiX } from 'react-icons/fi'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  fetchCertificates,
  fetchEmployeeByUserId,
  fetchWarnings,
} from '../../lib/hrApi'
import { HR_DOCUMENT_ALERT_SHOWN_KEY, pickPendingHRDocuments, type PendingHRDocument } from '../../lib/hrDocumentAlert'

export default function UnreadWarningCertificateAlert() {
  const { user } = useAuthContext()
  const location = useLocation()
  const navigate = useNavigate()
  const [queue, setQueue] = useState<PendingHRDocument[]>([])
  const checkedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!user?.id) {
      checkedRef.current = null
      setQueue([])
      return
    }
    if (location.pathname === '/reset-password') return
    // แสดงหนึ่งครั้งต่อการ login; key นี้ถูกล้างตอน sign out แล้วจึงเตือนใหม่เมื่อ login ครั้งถัดไป
    const shownKey = user.id
    if (checkedRef.current === shownKey) return
    try {
      if (sessionStorage.getItem(HR_DOCUMENT_ALERT_SHOWN_KEY) === shownKey) {
        checkedRef.current = shownKey
        return
      }
    } catch { /* continue without storage */ }
    checkedRef.current = shownKey

    void (async () => {
      const employee = await fetchEmployeeByUserId(user.id)
      if (!employee || ['resigned', 'terminated'].includes(employee.employment_status)) return
      const [warnings, certificates] = await Promise.all([
        fetchWarnings({ employeeId: employee.id }),
        fetchCertificates({ employeeId: employee.id }),
      ])
      try { sessionStorage.setItem(HR_DOCUMENT_ALERT_SHOWN_KEY, shownKey) } catch { /* ignore */ }
      const pending = pickPendingHRDocuments(warnings, certificates)
      if (pending.length) setQueue(pending)
    })().catch((error) => {
      checkedRef.current = null
      console.error('Unable to load HR document alerts:', error)
    })
  }, [location.pathname, user?.id])

  const current = queue[0]
  if (!current) return null

  const isWarning = current.kind === 'warning'
  const warningCount = queue.filter((entry) => entry.kind === 'warning').length
  const certificateCount = queue.filter((entry) => entry.kind === 'certificate').length
  const close = () => setQueue([])
  const openDocuments = () => {
    close()
    navigate('/employee?tab=warnings-certs')
  }

  return (
    <div className="fixed inset-0 z-[105] bg-black/60 flex items-start justify-center px-4 pt-16 sm:pt-24">
      <div className="bg-white w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl">
        <div className={`flex items-center justify-between px-4 py-3 text-white ${isWarning ? 'bg-red-600' : 'bg-emerald-600'}`}>
          <h3 className="font-semibold flex items-center gap-2 min-w-0">
            {isWarning ? <FiAlertTriangle className="w-5 h-5" /> : <FiAward className="w-5 h-5" />}
            <span>มีเอกสารที่ยังไม่รับทราบ</span>
            <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs">{queue.length}</span>
          </h3>
          <button type="button" onClick={close} aria-label="ปิด" className="rounded-lg p-1 hover:bg-white/20"><FiX className="w-5 h-5" /></button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-sm text-gray-600">กรุณาเปิดหน้าเตือน/รับรองเพื่ออ่านรายละเอียดและกดรับทราบ</p>
          <div className="rounded-xl border border-gray-200 divide-y text-sm">
            {warningCount > 0 && <div className="flex justify-between px-3 py-2.5"><span>ใบเตือน</span><strong className="text-red-600">{warningCount}</strong></div>}
            {certificateCount > 0 && <div className="flex justify-between px-3 py-2.5"><span>ใบรับรอง</span><strong className="text-emerald-600">{certificateCount}</strong></div>}
          </div>
        </div>

        <div className="border-t border-gray-200 p-4 grid grid-cols-2 gap-3">
          <button type="button" onClick={close} className="py-3 bg-gray-200 text-gray-700 rounded-xl font-semibold">ไว้ทีหลัง</button>
          <button type="button" onClick={openDocuments} className="flex items-center justify-center gap-2 py-3 bg-emerald-600 text-white rounded-xl font-semibold">
            ไปที่เตือน/รับรอง <FiArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
