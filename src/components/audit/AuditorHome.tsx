import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthContext } from '../../contexts/AuthContext'
import { fetchAuditorAssignedAudits } from '../../lib/auditApi'
import type { InventoryAudit } from '../../types'

export default function AuditorHome() {
  const { user, signOut } = useAuthContext()
  const navigate = useNavigate()
  const [audits, setAudits] = useState<InventoryAudit[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user?.id) return
    fetchAuditorAssignedAudits(user.id)
      .then(setAudits)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [user?.id])

  async function handleLogout() {
    await signOut()
    navigate('/')
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-blue-600 to-blue-800">
      {/* Header */}
      <div className="px-5 pt-10 pb-6">
        <div className="max-w-lg mx-auto flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Audit</h1>
            <p className="text-blue-200 text-sm mt-0.5">
              สวัสดี {user?.username || 'Auditor'}
            </p>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-red-500 hover:bg-red-600 text-white rounded-xl text-sm font-medium transition-colors active:scale-95"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            ออกจากระบบ
          </button>
        </div>
      </div>

      {/* Content Card */}
      <div className="flex-1 flex flex-col px-4">
        <div className="max-w-lg mx-auto w-full bg-white rounded-t-3xl shadow-xl flex-1 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-gray-800">รายการที่ได้รับมอบหมาย</h2>
            <span className="text-xs font-semibold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full">
              {audits.length} รายการ
            </span>
          </div>

          {loading ? (
            <div className="flex justify-center py-16">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500" />
            </div>
          ) : audits.length === 0 ? (
            <div className="text-center py-16">
              <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-10 h-10 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
              </div>
              <div className="text-gray-400 font-medium">ไม่มี Audit ที่รอตรวจนับ</div>
              <div className="text-xs text-gray-300 mt-1">รอการมอบหมายจากแอดมิน</div>
            </div>
          ) : (
            <div className="space-y-3">
              {audits.map((audit) => (
                <button
                  key={audit.id}
                  onClick={() => navigate(`/warehouse/audit/${audit.id}/count`)}
                  className="w-full bg-gradient-to-r from-blue-50 to-indigo-50 rounded-2xl border border-blue-100 p-4 text-left active:scale-[0.98] transition-all hover:shadow-md hover:border-blue-300"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-gray-900">{audit.audit_no}</div>
                      <div className="text-xs text-gray-500 mt-1">
                        {new Date(audit.created_at).toLocaleDateString('th-TH', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </div>
                      {audit.note && (
                        <div className="text-xs text-blue-500 mt-1 truncate">{audit.note}</div>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1.5 ml-3">
                      <span className="inline-flex px-3 py-1 rounded-full text-xs font-bold bg-blue-600 text-white shadow-sm">
                        กำลังนับ
                      </span>
                      <span className="text-sm font-semibold text-gray-700">
                        {audit.total_items || 0} รายการ
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
