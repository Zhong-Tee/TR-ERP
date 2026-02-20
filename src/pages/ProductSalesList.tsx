import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase'

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

export default function ProductSalesList() {
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

  const toggleCard = (type: string) =>
    setCollapsed((prev) => ({ ...prev, [type]: !prev[type] }))

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase.rpc('rpc_product_sales_summary', {
        p_from_date: dateFrom,
        p_to_date: dateTo,
      })
      if (error) throw error
      setRows((data as SalesRow[]) || [])
      setLoaded(true)
    } catch (err: any) {
      console.error(err)
      alert('โหลดข้อมูลไม่สำเร็จ: ' + err.message)
    } finally {
      setLoading(false)
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

  return (
    <div className="space-y-4 mt-4 pb-8">
      {/* ── Filter Bar ── */}
      <div className="bg-white p-4 rounded-lg shadow flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-sm font-semibold text-gray-600 mb-1">
            วันที่เริ่มต้น
          </label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-gray-600 mb-1">
            วันที่สิ้นสุด
          </label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
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
        <div className="bg-white p-4 rounded-lg shadow grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
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
          <div>
            <div className="text-xs text-gray-500">มูลค่ารวม</div>
            <div className="text-lg font-bold text-gray-800">{fmt(summary.totalAmount)} ฿</div>
          </div>
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
                  <span className="bg-white/20 rounded-full px-3 py-0.5">
                    {fmt(cardAmt)} ฿
                  </span>
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
                          <th className="px-4 py-2 text-right">มูลค่า (฿)</th>
                          <th className="px-4 py-2 text-right">ออเดอร์</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((r, i) => (
                          <tr
                            key={r.product_id}
                            className="border-t hover:bg-gray-50 transition"
                          >
                            <td className="px-4 py-2 text-center text-gray-400">{i + 1}</td>
                            <td className="px-4 py-2 font-mono text-xs">
                              {r.product_code || '-'}
                            </td>
                            <td className="px-4 py-2">{r.product_name}</td>
                            <td className="px-4 py-2 text-right font-semibold">
                              {fmtInt(Number(r.total_qty))}
                            </td>
                            <td className="px-4 py-2 text-right">
                              {fmt(Number(r.total_amount))}
                            </td>
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
