import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'

interface TrialSummary {
  beginning_inventory: number
  ending_inventory: number
  safety_stock_value: number
  purchases: number
  cogs: number
  returns: number
  waste: number
  adjustments: number
  gross_sales: number
  refunds_approved: number
  net_sales: number
  gross_profit: number
  gross_margin_pct: number
  movement_count: number
  product_count: number
}

interface ProductRow {
  product_id: string
  product_code: string
  product_name: string
  beginning_qty: number
  beginning_value: number
  ending_qty: number
  ending_value: number
  purchases_qty: number
  purchases_value: number
  cogs_qty: number
  cogs_value: number
  returns_qty: number
  returns_value: number
  waste_qty: number
  waste_value: number
  adjust_qty: number
  adjust_value: number
  safety_stock_qty: number
  safety_stock_value: number
}

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
]

function fmt(v: number): string {
  return v.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtPct(v: number): string {
  return `${v.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`
}

export default function TrialBalanceSection() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [summary, setSummary] = useState<TrialSummary | null>(null)
  const [products, setProducts] = useState<ProductRow[]>([])
  const [loading, setLoading] = useState(false)
  const [prodLoading, setProdLoading] = useState(false)
  const [showProducts, setShowProducts] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortCol, setSortCol] = useState<keyof ProductRow>('product_code')
  const [sortAsc, setSortAsc] = useState(true)

  const thaiYear = year + 543

  const yearOptions = useMemo(() => {
    const current = now.getFullYear()
    return Array.from({ length: 5 }, (_, i) => current - i)
  }, [])

  const loadSummary = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase.rpc('rpc_trial_balance_summary', {
        p_year: year,
        p_month: month,
      })
      if (err) throw err
      setSummary(data as TrialSummary)
    } catch (e: any) {
      setError(e.message)
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [year, month])

  const loadProducts = useCallback(async () => {
    setProdLoading(true)
    try {
      const { data, error: err } = await supabase.rpc('rpc_trial_balance_products', {
        p_year: year,
        p_month: month,
      })
      if (err) throw err
      setProducts((data as ProductRow[]) || [])
    } catch {
      setProducts([])
    } finally {
      setProdLoading(false)
    }
  }, [year, month])

  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  useEffect(() => {
    if (showProducts) loadProducts()
  }, [showProducts, loadProducts])

  const verified = useMemo(() => {
    if (!summary) return null
    const calc =
      summary.beginning_inventory +
      summary.purchases +
      summary.returns -
      summary.cogs -
      summary.waste +
      summary.adjustments
    const diff = Math.abs(calc - summary.ending_inventory)
    return { calc: Math.round(calc * 100) / 100, pass: diff < 0.02 }
  }, [summary])

  const sortedProducts = useMemo(() => {
    const arr = [...products]
    arr.sort((a, b) => {
      const av = a[sortCol]
      const bv = b[sortCol]
      if (typeof av === 'string' && typeof bv === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av)
      return sortAsc ? (Number(av) - Number(bv)) : (Number(bv) - Number(av))
    })
    return arr
  }, [products, sortCol, sortAsc])

  function toggleSort(col: keyof ProductRow) {
    if (sortCol === col) setSortAsc(!sortAsc)
    else { setSortCol(col); setSortAsc(true) }
  }

  const summaryCards = summary
    ? [
        { label: 'สินค้าคงเหลือต้นงวด', value: summary.beginning_inventory, color: 'bg-slate-50 border-slate-200 text-slate-700' },
        { label: 'ซื้อสินค้า (GR)', value: summary.purchases, color: 'bg-blue-50 border-blue-200 text-blue-700' },
        { label: 'ต้นทุนขาย (COGS)', value: summary.cogs, color: 'bg-amber-50 border-amber-200 text-amber-700' },
        { label: 'สินค้าคงเหลือปลายงวด', value: summary.ending_inventory, color: 'bg-emerald-50 border-emerald-200 text-emerald-700' },
        { label: 'Safety Stock (กักตุน)', value: summary.safety_stock_value, color: 'bg-purple-50 border-purple-200 text-purple-700' },
      ]
    : []

  const profitCards = summary
    ? [
        { label: 'ยอดขายรวม (รวม VAT)', value: summary.gross_sales, color: 'bg-cyan-50 border-cyan-200 text-cyan-700' },
        { label: 'คืนเงินอนุมัติ', value: summary.refunds_approved, color: 'bg-rose-50 border-rose-200 text-rose-700' },
        { label: 'ยอดขายสุทธิ', value: summary.net_sales, color: 'bg-teal-50 border-teal-200 text-teal-700' },
        { label: 'กำไรขั้นต้น', value: summary.gross_profit, color: summary.gross_profit >= 0 ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700' },
      ]
    : []

  const lineItems = summary
    ? [
        { label: 'สินค้าคงเหลือต้นงวด', value: summary.beginning_inventory, sign: '', bold: true },
        { label: 'ซื้อสินค้า (GR)', value: summary.purchases, sign: '+' },
        { label: 'คืนสินค้าเข้าสต๊อก', value: summary.returns, sign: '+' },
        { label: 'ต้นทุนขาย (COGS)', value: summary.cogs, sign: '−' },
        { label: 'ของเสีย/สินค้าเสียหาย', value: summary.waste, sign: '−' },
        { label: 'ปรับปรุง', value: summary.adjustments, sign: summary.adjustments >= 0 ? '+' : '' },
        { label: 'Safety Stock (สินค้ากักตุน)', value: summary.safety_stock_value, sign: '', bold: false, isSafety: true },
      ]
    : []

  return (
    <div className="space-y-6">
      {/* Month/Year selector */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="font-semibold text-gray-700">เลือกงวด:</label>
        <select
          value={month}
          onChange={(e) => setMonth(Number(e.target.value))}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
        >
          {THAI_MONTHS.map((m, i) => (
            <option key={i} value={i + 1}>{m}</option>
          ))}
        </select>
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
        >
          {yearOptions.map((y) => (
            <option key={y} value={y}>พ.ศ. {y + 543}</option>
          ))}
        </select>
        {summary && (
          <span className="text-sm text-gray-500 ml-2">
            {summary.movement_count} รายการเคลื่อนไหว | {summary.product_count} สินค้า
          </span>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          <i className="fas fa-exclamation-triangle mr-2" />{error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <i className="fas fa-spinner fa-spin text-2xl text-blue-500" />
        </div>
      ) : summary ? (
        <>
          {/* Inventory summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            {summaryCards.map((c) => (
              <div key={c.label} className={`rounded-xl border p-4 ${c.color}`}>
                <div className="text-xs font-medium opacity-75 mb-1">{c.label}</div>
                <div className="text-xl font-bold">{fmt(c.value)} <span className="text-sm font-normal">฿</span></div>
              </div>
            ))}
          </div>

          {/* Revenue & gross profit cards */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h3 className="text-base font-bold text-gray-800">สรุปรายได้และกำไรขั้นต้น</h3>
              <span className="text-xs text-gray-500">รับรู้รายได้ตามวันที่จัดส่ง (shipped_time)</span>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              {profitCards.map((c) => (
                <div key={c.label} className={`rounded-xl border p-4 ${c.color}`}>
                  <div className="text-xs font-medium opacity-75 mb-1">{c.label}</div>
                  <div className="text-xl font-bold">{fmt(c.value)} <span className="text-sm font-normal">฿</span></div>
                </div>
              ))}
              <div className={`rounded-xl border p-4 ${summary.gross_margin_pct >= 0 ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
                <div className="text-xs font-medium opacity-75 mb-1">อัตรากำไรขั้นต้น (GP%)</div>
                <div className="text-xl font-bold">{fmtPct(summary.gross_margin_pct)}</div>
              </div>
            </div>
            <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
              <span className="font-semibold text-gray-700">สูตรกำไรขั้นต้น:</span>{' '}
              <span className="text-gray-600">ยอดขายสุทธิ − ต้นทุนขาย (COGS)</span>{' '}
              <span className="font-mono font-semibold text-gray-900">
                = {fmt(summary.net_sales)} − {fmt(summary.cogs)} = {fmt(summary.gross_profit)} ฿
              </span>
            </div>
          </div>

          {/* Trial balance table */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60">
              <h3 className="text-lg font-bold text-gray-800">
                งบทดลองสินค้าคงเหลือ
              </h3>
              <p className="text-sm text-gray-500 mt-0.5">
                {THAI_MONTHS[month - 1]} พ.ศ. {thaiYear}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                ยอดขายสุทธิใช้ยอดรวม VAT และหักคืนเงินที่อนุมัติแล้ว
              </p>
            </div>
            <div className="divide-y divide-gray-100">
              {lineItems.map((item, i) => (
                <div
                  key={i}
                  className={`flex items-center justify-between px-6 py-3 ${
                    item.bold ? 'bg-gray-50 font-semibold' :
                    ('isSafety' in item && item.isSafety) ? 'bg-purple-50/60' :
                    'hover:bg-gray-50/50'
                  }`}
                >
                  <div className="flex items-center gap-2 text-gray-700">
                    {item.sign && (
                      <span className={`w-5 text-center font-bold ${item.sign === '−' ? 'text-red-500' : 'text-green-600'}`}>
                        {item.sign}
                      </span>
                    )}
                    {('isSafety' in item && item.isSafety) ? (
                      <span className="text-purple-700 flex items-center gap-1.5">
                        <i className="fas fa-shield-alt text-xs" />
                        {item.label}
                      </span>
                    ) : (
                      <span>{item.label}</span>
                    )}
                  </div>
                  <span className={`font-mono text-right ${
                    item.bold ? 'text-gray-900 text-lg' :
                    ('isSafety' in item && item.isSafety) ? 'text-purple-700 font-semibold' :
                    'text-gray-700'
                  }`}>
                    {fmt(item.value)} ฿
                  </span>
                </div>
              ))}

              {/* Ending line */}
              <div className="flex items-center justify-between px-6 py-4 bg-emerald-50 font-bold">
                <span className="text-emerald-800">สินค้าคงเหลือปลายงวด</span>
                <span className="text-emerald-800 font-mono text-lg">{fmt(summary.ending_inventory)} ฿</span>
              </div>
              {summary.safety_stock_value > 0 && (
                <div className="flex items-center justify-between px-6 py-3 bg-purple-50/40 border-t border-purple-100">
                  <span className="text-purple-800 font-semibold flex items-center gap-1.5">
                    <i className="fas fa-boxes text-xs" />
                    รวมทั้งหมด (คลัง + Safety Stock)
                  </span>
                  <span className="text-purple-900 font-mono text-lg font-bold">
                    {fmt(summary.ending_inventory + summary.safety_stock_value)} ฿
                  </span>
                </div>
              )}

              {/* Verification */}
              {verified && (
                <div className={`flex items-center justify-between px-6 py-3 text-sm ${verified.pass ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                  <div className="flex items-center gap-2">
                    <i className={`fas ${verified.pass ? 'fa-check-circle' : 'fa-times-circle'}`} />
                    <span>สูตรตรวจสอบ: ต้นงวด + ซื้อ + คืนเข้า − ต้นทุนขาย − ของเสีย ± ปรับปรุง</span>
                  </div>
                  <span className="font-mono font-semibold">
                    = {fmt(verified.calc)} ฿
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Product drill-down */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <button
              type="button"
              onClick={() => setShowProducts(!showProducts)}
              className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
            >
              <span className="font-semibold text-gray-800">
                <i className={`fas fa-chevron-${showProducts ? 'up' : 'down'} mr-2 text-sm text-gray-400`} />
                รายละเอียดรายสินค้า
              </span>
              {showProducts && products.length > 0 && (
                <span className="text-sm text-gray-500">{products.length} รายการ</span>
              )}
            </button>

            {showProducts && (
              <div className="border-t border-gray-100 overflow-x-auto">
                {prodLoading ? (
                  <div className="flex justify-center py-10">
                    <i className="fas fa-spinner fa-spin text-xl text-blue-500" />
                  </div>
                ) : products.length === 0 ? (
                  <div className="text-center text-gray-400 py-10">ไม่มีข้อมูล</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 text-gray-600 border-b border-gray-200">
                        {([
                          { key: 'product_code' as keyof ProductRow, label: 'รหัส', align: 'text-left' },
                          { key: 'product_name' as keyof ProductRow, label: 'สินค้า', align: 'text-left' },
                          { key: 'beginning_value' as keyof ProductRow, label: 'ต้นงวด', align: 'text-right' },
                          { key: 'purchases_value' as keyof ProductRow, label: 'ซื้อ', align: 'text-right' },
                          { key: 'cogs_value' as keyof ProductRow, label: 'ต้นทุนขาย', align: 'text-right' },
                          { key: 'returns_value' as keyof ProductRow, label: 'คืนเข้า', align: 'text-right' },
                          { key: 'waste_value' as keyof ProductRow, label: 'ของเสีย', align: 'text-right' },
                          { key: 'adjust_value' as keyof ProductRow, label: 'ปรับปรุง', align: 'text-right' },
                          { key: 'ending_value' as keyof ProductRow, label: 'ปลายงวด', align: 'text-right' },
                          { key: 'safety_stock_value' as keyof ProductRow, label: 'Safety Stock', align: 'text-right' },
                        ]).map((col) => (
                          <th
                            key={col.key}
                            className={`px-3 py-2.5 font-semibold cursor-pointer select-none whitespace-nowrap ${col.align}`}
                            onClick={() => toggleSort(col.key)}
                          >
                            {col.label}
                            {sortCol === col.key && (
                              <i className={`fas fa-sort-${sortAsc ? 'up' : 'down'} ml-1 text-xs text-blue-500`} />
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {sortedProducts.map((p) => (
                        <tr key={p.product_id} className="hover:bg-gray-50/50">
                          <td className="px-3 py-2 font-mono text-xs text-gray-600 whitespace-nowrap">{p.product_code}</td>
                          <td className="px-3 py-2 text-gray-800 max-w-[200px] truncate">{p.product_name}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmt(p.beginning_value)}</td>
                          <td className="px-3 py-2 text-right font-mono text-blue-600">{p.purchases_value > 0 ? fmt(p.purchases_value) : '-'}</td>
                          <td className="px-3 py-2 text-right font-mono text-amber-600">{p.cogs_value > 0 ? fmt(p.cogs_value) : '-'}</td>
                          <td className="px-3 py-2 text-right font-mono text-green-600">{p.returns_value > 0 ? fmt(p.returns_value) : '-'}</td>
                          <td className="px-3 py-2 text-right font-mono text-red-500">{p.waste_value > 0 ? fmt(p.waste_value) : '-'}</td>
                          <td className="px-3 py-2 text-right font-mono">{p.adjust_value !== 0 ? fmt(p.adjust_value) : '-'}</td>
                          <td className="px-3 py-2 text-right font-mono font-semibold text-emerald-700">{fmt(p.ending_value)}</td>
                          <td className="px-3 py-2 text-right font-mono text-purple-600">{p.safety_stock_value > 0 ? fmt(p.safety_stock_value) : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-gray-50 font-semibold border-t-2 border-gray-300">
                        <td className="px-3 py-2.5" colSpan={2}>รวมทั้งหมด</td>
                        <td className="px-3 py-2.5 text-right font-mono">{fmt(products.reduce((s, p) => s + p.beginning_value, 0))}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-blue-600">{fmt(products.reduce((s, p) => s + p.purchases_value, 0))}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-amber-600">{fmt(products.reduce((s, p) => s + p.cogs_value, 0))}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-green-600">{fmt(products.reduce((s, p) => s + p.returns_value, 0))}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-red-500">{fmt(products.reduce((s, p) => s + p.waste_value, 0))}</td>
                        <td className="px-3 py-2.5 text-right font-mono">{fmt(products.reduce((s, p) => s + p.adjust_value, 0))}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-emerald-700">{fmt(products.reduce((s, p) => s + p.ending_value, 0))}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-purple-600">{fmt(products.reduce((s, p) => s + p.safety_stock_value, 0))}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
