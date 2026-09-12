import { useEffect, useRef, useState } from 'react'
import { fetchProductLots, type StockLotRow } from '../../lib/inventory'

interface LotCostPopoverProps {
  productId: string
  landedCost: number | null
  children: React.ReactNode
}

export default function LotCostPopover({ productId, landedCost, children }: LotCostPopoverProps) {
  const [open, setOpen] = useState(false)
  const [lots, setLots] = useState<StockLotRow[]>([])
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    fetchProductLots(productId, 5)
      .then((data) => { if (!cancelled) setLots(data) })
      .catch(() => { if (!cancelled) setLots([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, productId])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  const regularLots = lots.filter((l) => !l.is_safety_stock)
  const safetyLots = lots.filter((l) => l.is_safety_stock)

  const avgRegular = regularLots.length
    ? regularLots.reduce((s, l) => s + l.qty_remaining * l.unit_cost, 0) / regularLots.reduce((s, l) => s + l.qty_remaining, 0)
    : null
  const avgSafety = safetyLots.length
    ? safetyLots.reduce((s, l) => s + l.qty_remaining * l.unit_cost, 0) / safetyLots.reduce((s, l) => s + l.qty_remaining, 0)
    : null

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer hover:text-blue-600 transition-colors"
        title="คลิกเพื่อดู Lot ล่าสุด"
      >
        {children}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-[380px] bg-white rounded-xl shadow-lg border border-gray-200 text-sm">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 rounded-t-xl">
            <div className="font-semibold text-gray-800">Lot ล่าสุด (คงเหลือ)</div>
            {landedCost != null && landedCost > 0 && (
              <div className="text-xs text-gray-500 mt-0.5">
                ต้นทุนเฉลี่ยรวม: {landedCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ฿
              </div>
            )}
          </div>

          <div className="max-h-64 overflow-y-auto">
            {loading ? (
              <div className="flex justify-center py-6">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
              </div>
            ) : lots.length === 0 ? (
              <div className="text-center py-6 text-gray-400">ไม่มี lot คงเหลือ</div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="text-gray-500 text-xs">
                    <th className="px-3 py-2 text-left font-medium">วันที่</th>
                    <th className="px-3 py-2 text-right font-medium">คงเหลือ</th>
                    <th className="px-3 py-2 text-right font-medium">ต้นทุน/ชิ้น</th>
                    <th className="px-3 py-2 text-center font-medium">ประเภท</th>
                  </tr>
                </thead>
                <tbody>
                  {lots.map((lot, idx) => (
                    <tr key={lot.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      <td className="px-3 py-1.5 text-gray-600">
                        {new Date(lot.created_at).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' })}
                      </td>
                      <td className="px-3 py-1.5 text-right font-medium">
                        {lot.qty_remaining.toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {lot.unit_cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ฿
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        {lot.is_safety_stock ? (
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-100 text-purple-700">safety</span>
                        ) : (
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-700">ปกติ</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {!loading && lots.length > 0 && (
            <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50 rounded-b-xl space-y-0.5">
              {avgRegular != null && (
                <div className="flex justify-between text-xs">
                  <span className="text-blue-700 font-medium">เฉลี่ย (ปกติ)</span>
                  <span className="font-semibold">{avgRegular.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ฿</span>
                </div>
              )}
              {avgSafety != null && (
                <div className="flex justify-between text-xs">
                  <span className="text-purple-700 font-medium">เฉลี่ย (safety)</span>
                  <span className="font-semibold">{avgSafety.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ฿</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
