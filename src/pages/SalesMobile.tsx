import { Navigate, useNavigate } from 'react-router-dom'
import { useAuthContext } from '../contexts/AuthContext'
import { getActiveMobileMode } from '../lib/mobileMode'
import PreBillWorkspace from '../components/order/PreBillWorkspace'
import './SalesMobile.css'

export default function SalesMobile() {
  const { user } = useAuthContext()
  const navigate = useNavigate()
  if (getActiveMobileMode(user) !== 'sales_mb') return <Navigate to="/mode" replace />

  return <div className="sales-mobile min-h-screen bg-slate-50 text-slate-800">
    <header className="sticky top-0 z-30 border-b border-indigo-100 bg-white/95 px-4 py-3 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
        <div><h1 className="text-xl font-extrabold text-indigo-700">Sales</h1><p className="text-xs text-slate-500">QT / PC · {user?.username || user?.email}</p></div>
        <button type="button" onClick={() => navigate('/mode')} className="rounded-xl border border-indigo-200 px-4 py-2 text-sm font-bold text-indigo-700">เปลี่ยนโหมด</button>
      </div>
    </header>
    <main className="mx-auto max-w-3xl p-3 sm:p-5">
      <PreBillWorkspace mobile pendingCounts={{ quotation: 0, production_confirmation: 0 }}
        onOpenBill={() => {}} onViewConvertedOrder={() => {}} onReviewDiscounts={() => {}} />
    </main>
  </div>
}
