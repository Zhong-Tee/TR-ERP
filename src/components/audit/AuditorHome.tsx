import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthContext } from '../../contexts/AuthContext'
import { fetchAuditorAssignedAudits } from '../../lib/auditApi'
import ProductionParcelReturn from '../wms/production/ProductionParcelReturn'
import type { InventoryAudit } from '../../types'

type ViewKey = 'menu' | 'audit' | 'parcel-return'

const MENU_ITEMS: { key: ViewKey; label: string; icon: string; desc: string; color: string }[] = [
  { key: 'audit', label: 'Audit', icon: 'fas fa-clipboard-check', desc: 'ตรวจนับสินค้าที่ได้รับมอบหมาย', color: 'from-blue-600 to-blue-800' },
  { key: 'parcel-return', label: 'รับสินค้าตีกลับ', icon: 'fas fa-barcode', desc: 'สแกนเลขพัสดุรับคืนจากลูกค้า', color: 'from-purple-600 to-purple-800' },
]

export default function AuditorHome() {
  const { user, signOut } = useAuthContext()
  const navigate = useNavigate()
  const [activeView, setActiveView] = useState<ViewKey>('menu')
  const [audits, setAudits] = useState<InventoryAudit[]>([])
  const [loading, setLoading] = useState(true)
  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    if (!user?.id) return
    fetchAuditorAssignedAudits(user.id)
      .then(setAudits)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [user?.id])

  async function handleLogout() {
    setLoggingOut(true)
    try {
      await signOut()
      navigate('/')
    } finally {
      setLoggingOut(false)
    }
  }

  const activeLabel = MENU_ITEMS.find((m) => m.key === activeView)?.label || ''

  if (activeView === 'menu') {
    return (
      <div className="min-h-screen w-full bg-slate-900 text-white flex flex-col overflow-hidden rounded-none">
        <header className="p-3 border-b border-slate-800 flex justify-between items-center bg-slate-900/90 sticky top-0 z-20">
          <div className="flex flex-col min-w-0">
            <span className="text-xs text-gray-500 font-bold uppercase truncate">Auditor</span>
            <span className="text-sm font-black text-blue-400 leading-tight truncate">
              {user?.username || user?.email || '---'}
            </span>
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

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="text-center py-4">
            <div className="text-2xl font-black text-white">Auditor</div>
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
      </div>
    )
  }

  if (activeView === 'parcel-return') {
    return (
      <div className="min-h-screen w-full bg-slate-900 text-white flex flex-col overflow-hidden rounded-none">
        <header className="p-3 border-b border-slate-800 flex justify-between items-center bg-slate-900/90 sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setActiveView('menu')}
              className="shrink-0 w-9 h-9 rounded-xl bg-slate-700 text-white flex items-center justify-center hover:bg-slate-600 active:bg-slate-500"
            >
              <i className="fas fa-arrow-left text-sm" />
            </button>
            <div className="flex flex-col min-w-0">
              <span className="text-xs text-gray-500 font-bold uppercase truncate">{activeLabel}</span>
              <span className="text-sm font-black text-blue-400 leading-tight truncate">
                {user?.username || user?.email || '---'}
              </span>
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
          <ProductionParcelReturn />
        </div>
      </div>
    )
  }

  // activeView === 'audit' — original Audit list
  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-blue-600 to-blue-800">
      <div className="px-5 pt-6 pb-4">
        <div className="max-w-lg mx-auto flex items-start justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setActiveView('menu')}
              className="shrink-0 w-9 h-9 rounded-xl bg-white/20 text-white flex items-center justify-center hover:bg-white/30 active:bg-white/10"
            >
              <i className="fas fa-arrow-left text-sm" />
            </button>
            <div>
              <h1 className="text-2xl font-bold text-white">Audit</h1>
              <p className="text-blue-200 text-sm mt-0.5">
                สวัสดี {user?.username || 'Auditor'}
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-red-500 hover:bg-red-600 text-white rounded-xl text-sm font-medium transition-colors active:scale-95 disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            {loggingOut ? 'กำลังออก...' : 'ออกจากระบบ'}
          </button>
        </div>
      </div>

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
