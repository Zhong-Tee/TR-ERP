import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthContext } from '../contexts/AuthContext'
import { isRoleInAllowedList } from '../config/accessPolicy'
import * as XLSX from 'xlsx'
import Modal from '../components/ui/Modal'

interface SalesRow {
  product_id: string
  product_code: string
  product_name: string
  product_type: string
  total_qty: number
  total_amount: number
  order_count: number
}

const CARD_CONFIG: {
  type: string
  label: string
  color: string
  headerBg: string
  badgeBg: string
}[] = [
  {
    type: 'PP',
    label: 'PP - สินค้าแปรรูป',
    color: 'border-purple-300',
    headerBg: 'bg-purple-600',
    badgeBg: 'bg-purple-100 text-purple-700',
  },
  {
    type: 'FG',
    label: 'FG - สินค้าสำเร็จรูป',
    color: 'border-blue-300',
    headerBg: 'bg-blue-600',
    badgeBg: 'bg-blue-100 text-blue-700',
  },
  {
    type: 'RM',
    label: 'RM - วัตถุดิบ',
    color: 'border-green-300',
    headerBg: 'bg-green-600',
    badgeBg: 'bg-green-100 text-green-700',
  },
]

const fmt = (n: number) =>
  n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtInt = (n: number) => n.toLocaleString('th-TH')

function toLocalDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface SalesBillRow {
  order_id: string
  bill_no: string
  entry_date: string
  order_status: string
  total_qty: number
  total_amount: number
}

function formatDateInputDisplay(value: string) {
  const [year, month, day] = value.split('-')
  return year && month && day ? `${day}/${month}/${year}` : ''
}

function formatThaiDate(value: string) {
  if (!value) return '-'
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return value
  return new Date(year, month - 1, day).toLocaleDateString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

function FixedFormatDateInput({ value, onChange, ariaLabel }: {
  value: string
  onChange: (value: string) => void
  ariaLabel: string
}) {
  const nativeInputRef = useRef<HTMLInputElement>(null)

  const openPicker = () => {
    const input = nativeInputRef.current
    if (!input) return
    if (typeof input.showPicker === 'function') input.showPicker()
    else input.click()
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={openPicker}
        className="flex min-w-[136px] items-center justify-between gap-3 rounded-lg border bg-white px-3 py-2 text-sm text-gray-800 hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200"
        aria-label={`${ariaLabel}: ${formatDateInputDisplay(value)}`}
      >
        <span className="tabular-nums">{formatDateInputDisplay(value)}</span>
        <svg className="h-4 w-4 shrink-0 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3M5 11h14M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
        </svg>
      </button>
      <input
        ref={nativeInputRef}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="pointer-events-none absolute bottom-0 right-0 h-px w-px opacity-0"
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  )
}

export default function ProductSalesList() {
  const { user } = useAuthContext()
  const canViewSalesValue = !isRoleInAllowedList(user?.role, ['store'])
  const now = new Date()
  const [dateFrom, setDateFrom] = useState(() =>
    toLocalDate(new Date(now.getFullYear(), now.getMonth(), 1)),
  )
  const [dateTo, setDateTo] = useState(() => toLocalDate(now))
  const [rows, setRows] = useState<SalesRow[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [selectedProduct, setSelectedProduct] = useState<SalesRow | null>(null)
  const [billRows, setBillRows] = useState<SalesBillRow[]>([])
  const [billLoading, setBillLoading] = useState(false)
  const [billError, setBillError] = useState('')

  const toggleCard = (type: string) =>
    setCollapsed((prev) => ({ ...prev, [type]: !prev[type] }))

  const fetchData = useCallback(async () => {
    setLoading(true)
    setSelectedProduct(null)
    try {
      const { data, error } = await supabase.rpc('rpc_product_sales_summary', {
        p_from_date: dateFrom,
        p_to_date: dateTo,
      })
      if (error) throw error
      setRows((data as SalesRow[]) || [])
      setLoaded(true)
    } catch (err: unknown) {
      console.error(err)
      const message = err instanceof Error ? err.message : String(err)
      alert('โหลดข้อมูลไม่สำเร็จ: ' + message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  const openBillDetails = useCallback(async (product: SalesRow) => {
    setSelectedProduct(product)
    setBillRows([])
    setBillError('')
    setBillLoading(true)
    try {
      const { data, error } = await supabase.rpc('rpc_product_sales_bills', {
        p_product_id: product.product_id,
        p_from_date: dateFrom,
        p_to_date: dateTo,
      })
      if (error) throw error
      setBillRows((data as SalesBillRow[]) || [])
    } catch (err: unknown) {
      console.error(err)
      setBillError(err instanceof Error ? err.message : 'ไม่สามารถโหลดรายการเลขบิลได้')
    } finally {
      setBillLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => {
    fetchData()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.toLowerCase()
    return rows.filter(
      (r) =>
        r.product_code?.toLowerCase().includes(q) ||
        r.product_name?.toLowerCase().includes(q),
    )
  }, [rows, search])

  const grouped = useMemo(() => {
    const map: Record<string, SalesRow[]> = { PP: [], FG: [], RM: [] }
    for (const r of filtered) {
      const key = r.product_type || 'FG'
      if (map[key]) map[key].push(r)
    }
    return map
  }, [filtered])

  const summary = useMemo(() => {
    let totalQty = 0
    let totalAmount = 0
    let totalOrders = 0
    for (const r of filtered) {
      totalQty += Number(r.total_qty)
      totalAmount += Number(r.total_amount)
      totalOrders += Number(r.order_count)
    }
    return { count: filtered.length, totalQty, totalAmount, totalOrders }
  }, [filtered])

  const handleDownloadExcel = useCallback(() => {
    const sheetRows = filtered.map((r, idx) => {
      const row = {
        '#': idx + 1,
        'รหัสสินค้า': r.product_code,
        'ชื่อสินค้า': r.product_name,
        'ประเภท': r.product_type || 'FG',
        'จำนวนขาย': Number(r.total_qty),
        'ออเดอร์': Number(r.order_count),
      }
      return canViewSalesValue
        ? { ...row, 'มูลค่า (฿)': Number(r.total_amount) }
        : row
    })
    const ws = XLSX.utils.json_to_sheet(sheetRows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'รายการขายสินค้า')
    XLSX.writeFile(wb, `รายการขายสินค้า_${dateFrom}_${dateTo}.xlsx`)
  }, [filtered, dateFrom, dateTo, canViewSalesValue])

  return (
    <div className="space-y-4 mt-4 pb-8">
      {/* ── Filter Bar ── */}
      <div className="bg-white p-4 rounded-lg shadow flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-sm font-semibold text-gray-600 mb-1">
            วันที่เริ่มต้น
          </label>
          <FixedFormatDateInput
            value={dateFrom}
            onChange={setDateFrom}
            ariaLabel="วันที่เริ่มต้น"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-gray-600 mb-1">
            วันที่สิ้นสุด
          </label>
          <FixedFormatDateInput
            value={dateTo}
            onChange={setDateTo}
            ariaLabel="วันที่สิ้นสุด"
          />
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg text-sm font-semibold transition disabled:opacity-50"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <i className="fas fa-spinner fa-spin" /> กำลังโหลด...
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <i className="fas fa-search" /> ค้นหา
            </span>
          )}
        </button>

        {loaded && (
          <button
            type="button"
            onClick={handleDownloadExcel}
            className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-semibold transition flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            ดาวน์โหลด Excel
          </button>
        )}

        {loaded && (
          <div className="ml-auto">
            <input
              type="text"
              placeholder="ค้นหาสินค้า..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm w-56"
            />
          </div>
        )}
      </div>

      {/* ── Summary ── */}
      {loaded && (
        <div className={`bg-white p-4 rounded-lg shadow grid grid-cols-2 ${canViewSalesValue ? 'sm:grid-cols-4' : 'sm:grid-cols-3'} gap-4 text-center`}>
          <div>
            <div className="text-xs text-gray-500">จำนวนสินค้า</div>
            <div className="text-lg font-bold text-gray-800">
              {fmtInt(summary.count)} <span className="text-sm font-normal">รายการ</span>
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500">ยอดขายรวม (ชิ้น)</div>
            <div className="text-lg font-bold text-gray-800">{fmtInt(summary.totalQty)}</div>
          </div>
          {canViewSalesValue && (
            <div>
              <div className="text-xs text-gray-500">มูลค่ารวม</div>
              <div className="text-lg font-bold text-gray-800">{fmt(summary.totalAmount)} ฿</div>
            </div>
          )}
          <div>
            <div className="text-xs text-gray-500">จำนวนออเดอร์ (ไม่ซ้ำ)</div>
            <div className="text-lg font-bold text-gray-800">{fmtInt(summary.totalOrders)}</div>
          </div>
        </div>
      )}

      {/* ── Cards ── */}
      {loaded &&
        CARD_CONFIG.map((cfg) => {
          const items = grouped[cfg.type] || []
          const cardQty = items.reduce((s, r) => s + Number(r.total_qty), 0)
          const cardAmt = items.reduce((s, r) => s + Number(r.total_amount), 0)

          return (
            <div
              key={cfg.type}
              className={`bg-white rounded-lg shadow border-t-4 ${cfg.color} overflow-hidden`}
            >
              {/* Card Header (clickable to collapse/expand) */}
              <button
                type="button"
                onClick={() => toggleCard(cfg.type)}
                className={`${cfg.headerBg} text-white px-5 py-3 flex items-center justify-between w-full text-left cursor-pointer hover:brightness-110 transition`}
              >
                <h2 className="text-base font-bold flex items-center gap-2">
                  <i
                    className={`fas fa-chevron-right text-xs transition-transform duration-200 ${
                      collapsed[cfg.type] ? '' : 'rotate-90'
                    }`}
                  />
                  {cfg.label}
                </h2>
                <div className="flex items-center gap-4 text-sm">
                  <span className="bg-white/20 rounded-full px-3 py-0.5">
                    {fmtInt(items.length)} รายการ
                  </span>
                  <span className="bg-white/20 rounded-full px-3 py-0.5">
                    {fmtInt(cardQty)} ชิ้น
                  </span>
                  {canViewSalesValue && (
                    <span className="bg-white/20 rounded-full px-3 py-0.5">
                      {fmt(cardAmt)} ฿
                    </span>
                  )}
                </div>
              </button>

              {/* Table (collapsible) */}
              {!collapsed[cfg.type] && (
                items.length === 0 ? (
                  <div className="px-5 py-8 text-center text-gray-400 text-sm">
                    ไม่มีข้อมูลในช่วงเวลาที่เลือก
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 text-gray-600 text-xs uppercase">
                          <th className="px-4 py-2 text-center w-12">#</th>
                          <th className="px-4 py-2 text-left">รหัสสินค้า</th>
                          <th className="px-4 py-2 text-left">ชื่อสินค้า</th>
                          <th className="px-4 py-2 text-right">จำนวนขาย</th>
                          {canViewSalesValue && <th className="px-4 py-2 text-right">มูลค่า (฿)</th>}
                          <th className="px-4 py-2 text-right">ออเดอร์</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((r, i) => (
                          <tr
                            key={r.product_id}
                            role="button"
                            tabIndex={0}
                            onClick={() => openBillDetails(r)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                openBillDetails(r)
                              }
                            }}
                            className="group border-t cursor-pointer hover:bg-blue-50 transition focus:bg-blue-50 focus:outline-none"
                            aria-label={`ดูรายการเลขบิลของ ${r.product_name}`}
                          >
                            <td className="px-4 py-2 text-center text-gray-400">{i + 1}</td>
                            <td className="px-4 py-2 font-mono text-xs">
                              {r.product_code || '-'}
                            </td>
                            <td className="px-4 py-2">
                              <span className="font-medium text-gray-800 group-hover:text-blue-700 group-hover:underline">
                                {r.product_name}
                              </span>
                              <span className="ml-2 text-xs text-gray-300 group-hover:text-blue-500" aria-hidden="true">›</span>
                            </td>
                            <td className="px-4 py-2 text-right font-semibold">
                              {fmtInt(Number(r.total_qty))}
                            </td>
                            {canViewSalesValue && (
                              <td className="px-4 py-2 text-right">
                                {fmt(Number(r.total_amount))}
                              </td>
                            )}
                            <td className="px-4 py-2 text-right text-gray-500">
                              {fmtInt(Number(r.order_count))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}
            </div>
          )
        })}

      <Modal
        open={!!selectedProduct}
        onClose={() => setSelectedProduct(null)}
        closeOnBackdropClick
        contentClassName="max-w-4xl"
        ariaLabelledby="product-sales-bills-title"
      >
        {selectedProduct && (
          <div>
            <div className="border-b border-gray-200 bg-white px-6 py-5 pr-14">
              <h2 id="product-sales-bills-title" className="text-lg font-bold text-gray-900">
                รายการเลขบิล
              </h2>
              <div className="mt-1 text-sm text-gray-600">
                <span className="font-mono text-xs text-blue-700">{selectedProduct.product_code || '-'}</span>
                <span className="mx-2 text-gray-300">|</span>
                <span className="font-medium">{selectedProduct.product_name}</span>
              </div>
              <div className="mt-2 text-xs text-gray-500">
                ช่วงวันที่ {formatThaiDate(dateFrom)} – {formatThaiDate(dateTo)}
              </div>
            </div>

            <div className="p-6">
              {billLoading ? (
                <div className="py-12 text-center text-gray-400">
                  <i className="fas fa-spinner fa-spin mb-2 text-2xl" />
                  <div className="text-sm">กำลังโหลดรายการเลขบิล...</div>
                </div>
              ) : billError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  โหลดรายการเลขบิลไม่สำเร็จ: {billError}
                </div>
              ) : billRows.length === 0 ? (
                <div className="py-10 text-center text-sm text-gray-400">ไม่พบรายการเลขบิล</div>
              ) : (
                <>
                  <div className={`mb-4 grid gap-3 ${canViewSalesValue ? 'grid-cols-3' : 'grid-cols-2'}`}>
                    <div className="rounded-lg bg-blue-50 px-4 py-3 text-center">
                      <div className="text-xs text-blue-600">จำนวนบิล</div>
                      <div className="mt-1 text-lg font-bold text-blue-900">{fmtInt(billRows.length)}</div>
                    </div>
                    <div className="rounded-lg bg-emerald-50 px-4 py-3 text-center">
                      <div className="text-xs text-emerald-600">จำนวนขาย</div>
                      <div className="mt-1 text-lg font-bold text-emerald-900">
                        {fmtInt(billRows.reduce((sum, bill) => sum + Number(bill.total_qty), 0))}
                      </div>
                    </div>
                    {canViewSalesValue && (
                      <div className="rounded-lg bg-amber-50 px-4 py-3 text-center">
                        <div className="text-xs text-amber-600">มูลค่ารวม</div>
                        <div className="mt-1 text-lg font-bold text-amber-900">
                          {fmt(billRows.reduce((sum, bill) => sum + Number(bill.total_amount), 0))} ฿
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-xs text-gray-600">
                        <tr>
                          <th className="px-4 py-2.5 text-center">#</th>
                          <th className="px-4 py-2.5 text-left">เลขบิล</th>
                          <th className="px-4 py-2.5 text-left">วันที่</th>
                          <th className="px-4 py-2.5 text-left">สถานะ</th>
                          <th className="px-4 py-2.5 text-right">จำนวน</th>
                          {canViewSalesValue && <th className="px-4 py-2.5 text-right">มูลค่า (฿)</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {billRows.map((bill, index) => (
                          <tr key={bill.order_id} className="hover:bg-gray-50">
                            <td className="px-4 py-2.5 text-center text-gray-400">{index + 1}</td>
                            <td className="px-4 py-2.5 font-semibold text-blue-700 select-all">{bill.bill_no}</td>
                            <td className="px-4 py-2.5 whitespace-nowrap text-gray-600">{formatThaiDate(bill.entry_date)}</td>
                            <td className="px-4 py-2.5 text-gray-600">{bill.order_status || '-'}</td>
                            <td className="px-4 py-2.5 text-right font-semibold">{fmtInt(Number(bill.total_qty))}</td>
                            {canViewSalesValue && (
                              <td className="px-4 py-2.5 text-right">{fmt(Number(bill.total_amount))}</td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* ── Loading state ── */}
      {loading && (
        <div className="text-center py-12 text-gray-400">
          <i className="fas fa-spinner fa-spin text-2xl mb-2" />
          <div className="text-sm">กำลังโหลดข้อมูล...</div>
        </div>
      )}

      {/* ── Empty initial state ── */}
      {!loaded && !loading && (
        <div className="text-center py-12 text-gray-400">
          <i className="fas fa-chart-bar text-4xl mb-3" />
          <div className="text-sm">เลือกช่วงวันที่แล้วกด "ค้นหา" เพื่อดูรายงาน</div>
        </div>
      )}
    </div>
  )
}
