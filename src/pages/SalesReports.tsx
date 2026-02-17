import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import * as XLSX from 'xlsx'
import { FiDownload, FiSearch, FiChevronUp, FiChevronDown } from 'react-icons/fi'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */
interface RawOrder {
  channel_code: string
  bill_no: string
  total_amount: number
  price: number
  shipping_cost: number
  discount: number
  entry_date: string
  admin_user: string
  status: string
  payment_method: string | null
  promotion: string | null
  customer_name: string
  or_order_items: RawItem[]
}

interface RawItem {
  product_name: string
  product_id: string | null
  product_type: string | null
  quantity: number
  unit_price: number
  is_free: boolean
}

interface ChannelRow {
  channel_code: string
  channel_name: string
}

type TabKey = 'overview' | 'channel' | 'product' | 'daily' | 'admin' | 'orders'

type PresetKey = 'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'lastMonth' | 'thisQuarter' | 'thisYear'

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
const fmt = (n: number) => n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtInt = (n: number) => n.toLocaleString('th-TH')
const fmtPct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(1) + '%'

function toLocalDate(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getPresetDates(key: PresetKey): [string, string] {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const today = toLocalDate(now)

  switch (key) {
    case 'today':
      return [today, today]
    case 'yesterday': {
      const d = new Date(now)
      d.setDate(d.getDate() - 1)
      const yd = toLocalDate(d)
      return [yd, yd]
    }
    case 'thisWeek': {
      const day = now.getDay()
      const diff = day === 0 ? 6 : day - 1
      const mon = new Date(now)
      mon.setDate(mon.getDate() - diff)
      return [toLocalDate(mon), today]
    }
    case 'thisMonth':
      return [`${y}-${String(m + 1).padStart(2, '0')}-01`, today]
    case 'lastMonth': {
      const pm = m === 0 ? 11 : m - 1
      const py = m === 0 ? y - 1 : y
      const lastDay = new Date(py, pm + 1, 0).getDate()
      return [
        `${py}-${String(pm + 1).padStart(2, '0')}-01`,
        `${py}-${String(pm + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
      ]
    }
    case 'thisQuarter': {
      const qStart = Math.floor(m / 3) * 3
      return [`${y}-${String(qStart + 1).padStart(2, '0')}-01`, today]
    }
    case 'thisYear':
      return [`${y}-01-01`, today]
  }
}

function getPreviousPeriod(from: string, to: string): [string, string] {
  const f = new Date(from + 'T00:00:00')
  const t = new Date(to + 'T00:00:00')
  const diff = t.getTime() - f.getTime()
  const prevTo = new Date(f.getTime() - 86400000)
  const prevFrom = new Date(prevTo.getTime() - diff)
  return [toLocalDate(prevFrom), toLocalDate(prevTo)]
}

/* ------------------------------------------------------------------ */
/*  Aggregation helpers                                                */
/* ------------------------------------------------------------------ */
function calcKPI(orders: RawOrder[]) {
  let totalRevenue = 0
  let totalShipping = 0
  let totalDiscount = 0
  let totalItems = 0

  orders.forEach((o) => {
    totalRevenue += Number(o.total_amount) || 0
    totalShipping += Number(o.shipping_cost) || 0
    totalDiscount += Number(o.discount) || 0
    o.or_order_items?.forEach((it) => {
      totalItems += Number(it.quantity) || 0
    })
  })

  return {
    totalRevenue,
    orderCount: orders.length,
    avgOrderValue: orders.length ? totalRevenue / orders.length : 0,
    totalItems,
    totalShipping,
    totalDiscount,
  }
}

function groupByChannel(orders: RawOrder[]) {
  const map: Record<string, { channel: string; orders: number; revenue: number; items: number; shipping: number }> = {}
  orders.forEach((o) => {
    const ch = o.channel_code || 'N/A'
    if (!map[ch]) map[ch] = { channel: ch, orders: 0, revenue: 0, items: 0, shipping: 0 }
    map[ch].orders += 1
    map[ch].revenue += Number(o.total_amount) || 0
    map[ch].shipping += Number(o.shipping_cost) || 0
    o.or_order_items?.forEach((it) => {
      map[ch].items += Number(it.quantity) || 0
    })
  })
  return Object.values(map).sort((a, b) => b.revenue - a.revenue)
}

function groupByProduct(orders: RawOrder[]) {
  const map: Record<string, { name: string; type: string; qty: number; revenue: number }> = {}
  orders.forEach((o) => {
    o.or_order_items?.forEach((it) => {
      const key = it.product_name || 'N/A'
      if (!map[key]) map[key] = { name: key, type: it.product_type || '-', qty: 0, revenue: 0 }
      const q = Number(it.quantity) || 0
      map[key].qty += q
      if (!it.is_free) {
        map[key].revenue += q * (Number(it.unit_price) || 0)
      }
    })
  })
  return Object.values(map).sort((a, b) => b.revenue - a.revenue)
}

function groupByDate(orders: RawOrder[]) {
  const map: Record<string, { date: string; orders: number; revenue: number; shipping: number; items: number }> = {}
  orders.forEach((o) => {
    const d = o.entry_date || 'N/A'
    if (!map[d]) map[d] = { date: d, orders: 0, revenue: 0, shipping: 0, items: 0 }
    map[d].orders += 1
    map[d].revenue += Number(o.total_amount) || 0
    map[d].shipping += Number(o.shipping_cost) || 0
    o.or_order_items?.forEach((it) => {
      map[d].items += Number(it.quantity) || 0
    })
  })
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date))
}

function groupByAdmin(orders: RawOrder[]) {
  const map: Record<string, { admin: string; orders: number; revenue: number; items: number }> = {}
  orders.forEach((o) => {
    const a = o.admin_user || 'N/A'
    if (!map[a]) map[a] = { admin: a, orders: 0, revenue: 0, items: 0 }
    map[a].orders += 1
    map[a].revenue += Number(o.total_amount) || 0
    o.or_order_items?.forEach((it) => {
      map[a].items += Number(it.quantity) || 0
    })
  })
  return Object.values(map).sort((a, b) => b.revenue - a.revenue)
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */
export default function SalesReports() {
  const today = toLocalDate(new Date())
  const monthStart = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`

  const [dateFrom, setDateFrom] = useState(monthStart)
  const [dateTo, setDateTo] = useState(today)
  const [channelFilter, setChannelFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('จัดส่งแล้ว')
  const [adminFilter, setAdminFilter] = useState('')
  const [activePreset, setActivePreset] = useState<PresetKey | null>('thisMonth')

  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [adminUsers, setAdminUsers] = useState<string[]>([])

  const [orders, setOrders] = useState<RawOrder[]>([])
  const [prevOrders, setPrevOrders] = useState<RawOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const [tab, setTab] = useState<TabKey>('overview')
  const [productSearch, setProductSearch] = useState('')
  const [productSortKey, setProductSortKey] = useState<'revenue' | 'qty' | 'name'>('revenue')
  const [productSortAsc, setProductSortAsc] = useState(false)
  const [orderPage, setOrderPage] = useState(0)
  const ORDER_PAGE_SIZE = 50

  // Load channels & admin users once
  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('channels').select('channel_code, channel_name').order('channel_code')
      if (data) setChannels(data)
    })()
    ;(async () => {
      const { data } = await supabase
        .from('or_orders')
        .select('admin_user')
      if (data) {
        const unique = [...new Set(data.map((d: any) => d.admin_user as string).filter(Boolean))].sort()
        setAdminUsers(unique)
      }
    })()
  }, [])

  // Auto-load on mount
  useEffect(() => {
    handleSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchOrders = useCallback(async (from: string, to: string, channel: string, status: string, admin: string) => {
    let q = supabase
      .from('or_orders')
      .select(
        `channel_code, bill_no, total_amount, price, shipping_cost, discount,
         entry_date, admin_user, status, payment_method, promotion, customer_name,
         or_order_items(product_name, product_id, product_type, quantity, unit_price, is_free)`
      )
      .gte('entry_date', from)
      .lte('entry_date', to)
      .order('entry_date', { ascending: false })

    if (status) q = q.eq('status', status)
    if (channel) q = q.eq('channel_code', channel)
    if (admin) q = q.eq('admin_user', admin)

    const { data, error } = await q
    if (error) throw error
    return (data || []) as RawOrder[]
  }, [])

  async function handleSearch() {
    setLoading(true)
    try {
      const [main, prev] = await Promise.all([
        fetchOrders(dateFrom, dateTo, channelFilter, statusFilter, adminFilter),
        (() => {
          const [pf, pt] = getPreviousPeriod(dateFrom, dateTo)
          return fetchOrders(pf, pt, channelFilter, statusFilter, adminFilter)
        })(),
      ])
      setOrders(main)
      setPrevOrders(prev)
      setLoaded(true)
      setOrderPage(0)
    } catch (err: any) {
      console.error(err)
      alert('โหลดข้อมูลไม่สำเร็จ: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  function applyPreset(key: PresetKey) {
    const [f, t] = getPresetDates(key)
    setDateFrom(f)
    setDateTo(t)
    setActivePreset(key)
  }

  const channelNameMap = useMemo(() => {
    const m: Record<string, string> = {}
    channels.forEach((c) => (m[c.channel_code] = c.channel_name))
    return m
  }, [channels])

  /* ---------- KPI ---------- */
  const kpi = useMemo(() => calcKPI(orders), [orders])
  const prevKpi = useMemo(() => calcKPI(prevOrders), [prevOrders])

  function delta(curr: number, prev: number) {
    if (prev === 0) return curr > 0 ? 100 : 0
    return ((curr - prev) / prev) * 100
  }

  /* ---------- Channel breakdown ---------- */
  const channelData = useMemo(() => groupByChannel(orders), [orders])

  /* ---------- Product breakdown ---------- */
  const productData = useMemo(() => {
    let list = groupByProduct(orders)
    if (productSearch) {
      const s = productSearch.toLowerCase()
      list = list.filter((p) => p.name.toLowerCase().includes(s))
    }
    list.sort((a, b) => {
      const dir = productSortAsc ? 1 : -1
      if (productSortKey === 'name') return a.name.localeCompare(b.name) * dir
      if (productSortKey === 'qty') return (a.qty - b.qty) * dir
      return (a.revenue - b.revenue) * dir
    })
    return list
  }, [orders, productSearch, productSortKey, productSortAsc])

  /* ---------- Daily trend ---------- */
  const dailyData = useMemo(() => groupByDate(orders), [orders])

  /* ---------- Admin breakdown ---------- */
  const adminData = useMemo(() => groupByAdmin(orders), [orders])

  /* ---------- Order list (paginated) ---------- */
  const orderList = useMemo(() => {
    return orders.map((o) => ({
      bill_no: o.bill_no,
      channel: o.channel_code,
      customer: o.customer_name,
      total: Number(o.total_amount) || 0,
      shipping: Number(o.shipping_cost) || 0,
      discount: Number(o.discount) || 0,
      status: o.status,
      date: o.entry_date,
      admin: o.admin_user,
      payment: o.payment_method || '-',
      items: (o.or_order_items || []).reduce((s, it) => s + (Number(it.quantity) || 0), 0),
    }))
  }, [orders])

  const pagedOrders = useMemo(() => {
    const start = orderPage * ORDER_PAGE_SIZE
    return orderList.slice(start, start + ORDER_PAGE_SIZE)
  }, [orderList, orderPage])

  const totalOrderPages = Math.ceil(orderList.length / ORDER_PAGE_SIZE)

  /* ---------- Excel Export ---------- */
  function exportExcel() {
    const wb = XLSX.utils.book_new()

    // Sheet 1: Summary
    const summaryRows = [
      ['รายงานยอดขาย', '', ''],
      ['ช่วงวันที่', `${dateFrom} ถึง ${dateTo}`, ''],
      ['ตัวกรองช่องทาง', channelFilter || 'ทั้งหมด', ''],
      ['ตัวกรองสถานะ', statusFilter || 'ทั้งหมด', ''],
      ['ตัวกรองแอดมิน', adminFilter || 'ทั้งหมด', ''],
      [],
      ['ตัวชี้วัด', 'ค่า'],
      ['ยอดขายรวม', kpi.totalRevenue],
      ['จำนวนบิล', kpi.orderCount],
      ['ยอดเฉลี่ยต่อบิล', kpi.avgOrderValue],
      ['จำนวนชิ้น', kpi.totalItems],
      ['ค่าส่งรวม', kpi.totalShipping],
      ['ส่วนลดรวม', kpi.totalDiscount],
    ]
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), 'สรุป')

    // Sheet 2: By Channel
    const chRows = [['ช่องทาง', 'ชื่อช่องทาง', 'จำนวนบิล', 'ยอดขาย', 'เฉลี่ยต่อบิล', 'จำนวนชิ้น', 'ค่าส่ง']]
    channelData.forEach((r) =>
      chRows.push([r.channel, channelNameMap[r.channel] || r.channel, r.orders as any, r.revenue as any, r.orders ? (r.revenue / r.orders) as any : 0, r.items as any, r.shipping as any])
    )
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(chRows), 'ตามช่องทาง')

    // Sheet 3: By Product
    const prRows = [['สินค้า', 'ประเภท', 'จำนวน', 'ยอดขาย', 'ราคาเฉลี่ยต่อชิ้น']]
    productData.forEach((r) =>
      prRows.push([r.name, r.type, r.qty as any, r.revenue as any, r.qty ? (r.revenue / r.qty) as any : 0])
    )
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(prRows), 'ตามสินค้า')

    // Sheet 4: Daily
    const dayRows = [['วันที่', 'จำนวนบิล', 'ยอดขาย', 'เฉลี่ยต่อบิล', 'ค่าส่ง', 'จำนวนชิ้น']]
    dailyData.forEach((r) =>
      dayRows.push([r.date, r.orders as any, r.revenue as any, r.orders ? (r.revenue / r.orders) as any : 0, r.shipping as any, r.items as any])
    )
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dayRows), 'รายวัน')

    // Sheet 5: By Admin
    const admRows = [['แอดมิน', 'จำนวนบิล', 'ยอดขาย', 'จำนวนชิ้น']]
    adminData.forEach((r) => admRows.push([r.admin, r.orders as any, r.revenue as any, r.items as any]))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(admRows), 'ตามแอดมิน')

    // Sheet 6: Order List
    const olRows = [['เลขบิล', 'ช่องทาง', 'ลูกค้า', 'ยอดรวม', 'ค่าส่ง', 'ส่วนลด', 'สถานะ', 'วันที่', 'แอดมิน', 'ชำระโดย', 'จำนวนชิ้น']]
    orderList.forEach((r) =>
      olRows.push([r.bill_no, r.channel, r.customer, r.total as any, r.shipping as any, r.discount as any, r.status, r.date, r.admin, r.payment, r.items as any])
    )
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(olRows), 'รายการบิล')

    XLSX.writeFile(wb, `รายงานยอดขาย_${dateFrom}_${dateTo}.xlsx`)
  }

  /* ---------- Product sort toggle ---------- */
  function toggleProductSort(key: 'revenue' | 'qty' | 'name') {
    if (productSortKey === key) {
      setProductSortAsc(!productSortAsc)
    } else {
      setProductSortKey(key)
      setProductSortAsc(key === 'name')
    }
  }

  const SortIcon = ({ col }: { col: string }) => {
    if (productSortKey !== col) return <span className="text-gray-300 ml-1 text-sm">⇅</span>
    return productSortAsc
      ? <FiChevronUp className="inline ml-1 w-3.5 h-3.5" />
      : <FiChevronDown className="inline ml-1 w-3.5 h-3.5" />
  }

  /* ------------------------------------------------------------------ */
  /*  Presets config                                                     */
  /* ------------------------------------------------------------------ */
  const presets: { key: PresetKey; label: string }[] = [
    { key: 'today', label: 'วันนี้' },
    { key: 'yesterday', label: 'เมื่อวาน' },
    { key: 'thisWeek', label: 'สัปดาห์นี้' },
    { key: 'thisMonth', label: 'เดือนนี้' },
    { key: 'lastMonth', label: 'เดือนก่อน' },
    { key: 'thisQuarter', label: 'ไตรมาสนี้' },
    { key: 'thisYear', label: 'ปีนี้' },
  ]

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'overview', label: 'ภาพรวม' },
    { key: 'channel', label: 'ตามช่องทาง' },
    { key: 'product', label: 'ตามสินค้า' },
    { key: 'daily', label: 'รายวัน' },
    { key: 'admin', label: 'ตามแอดมิน' },
    { key: 'orders', label: 'รายการบิล' },
  ]

  /* ------------------------------------------------------------------ */
  /*  Render                                                             */
  /* ------------------------------------------------------------------ */
  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* ===== Filter Bar ===== */}
      <div className="sticky top-0 z-20 bg-white border-b border-gray-200 shadow-sm -mx-6 px-6 py-4">
        {/* Quick presets */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {presets.map((p) => (
            <button
              key={p.key}
              onClick={() => applyPreset(p.key)}
              className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors ${
                activePreset === p.key
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Filters row */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2">
            <div>
              <label className="block text-sm text-gray-500 mb-0.5">จากวันที่</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setActivePreset(null) }}
                className="border border-gray-300 rounded-lg px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <span className="text-gray-400 mt-4">—</span>
            <div>
              <label className="block text-sm text-gray-500 mb-0.5">ถึงวันที่</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setActivePreset(null) }}
                className="border border-gray-300 rounded-lg px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-500 mb-0.5">ช่องทาง</label>
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-400 min-w-[120px]"
            >
              <option value="">ทั้งหมด</option>
              {channels.map((c) => (
                <option key={c.channel_code} value={c.channel_code}>
                  {c.channel_code} - {c.channel_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm text-gray-500 mb-0.5">สถานะ</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-400 min-w-[130px]"
            >
              <option value="">ทั้งหมด</option>
              <option value="จัดส่งแล้ว">จัดส่งแล้ว</option>
              <option value="เสร็จสิ้น">เสร็จสิ้น</option>
              <option value="ใบงานกำลังผลิต">ใบงานกำลังผลิต</option>
              <option value="ใบสั่งงาน">ใบสั่งงาน</option>
              <option value="คอนเฟิร์มแล้ว">คอนเฟิร์มแล้ว</option>
              <option value="ยกเลิก">ยกเลิก</option>
            </select>
          </div>

          <div>
            <label className="block text-sm text-gray-500 mb-0.5">แอดมิน</label>
            <select
              value={adminFilter}
              onChange={(e) => setAdminFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-400 min-w-[120px]"
            >
              <option value="">ทั้งหมด</option>
              {adminUsers.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>

          <button
            onClick={handleSearch}
            disabled={loading}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-base font-medium disabled:opacity-50 shadow-sm"
          >
            <FiSearch className="w-5 h-5" />
            ค้นหา
          </button>

          <button
            onClick={exportExcel}
            disabled={!loaded || orders.length === 0}
            className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-base font-medium disabled:opacity-50 shadow-sm"
          >
            <FiDownload className="w-5 h-5" />
            Export Excel
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex justify-center items-center py-16">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500" />
        </div>
      )}

      {/* Not loaded yet */}
      {!loading && !loaded && (
        <div className="text-center py-16 text-gray-400 text-lg">กดปุ่ม "ค้นหา" เพื่อโหลดข้อมูล</div>
      )}

      {/* Main content */}
      {!loading && loaded && (
        <div className="flex-1 overflow-y-auto pt-5 space-y-5 pb-8">
          {/* ===== KPI Cards ===== */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {([
              { label: 'ยอดขายรวม', value: kpi.totalRevenue, prev: prevKpi.totalRevenue, prefix: '฿', colorClass: 'text-emerald-600', isCurrency: true },
              { label: 'จำนวนบิล', value: kpi.orderCount, prev: prevKpi.orderCount, prefix: '', colorClass: 'text-blue-600', isCurrency: false },
              { label: 'เฉลี่ย/บิล', value: kpi.avgOrderValue, prev: prevKpi.avgOrderValue, prefix: '฿', colorClass: 'text-indigo-600', isCurrency: true },
              { label: 'จำนวนชิ้น', value: kpi.totalItems, prev: prevKpi.totalItems, prefix: '', colorClass: 'text-purple-600', isCurrency: false },
              { label: 'ค่าส่งรวม', value: kpi.totalShipping, prev: prevKpi.totalShipping, prefix: '฿', colorClass: 'text-amber-600', isCurrency: true },
              { label: 'ส่วนลดรวม', value: kpi.totalDiscount, prev: prevKpi.totalDiscount, prefix: '฿', colorClass: 'text-rose-600', isCurrency: true },
            ] as const).map((card) => {
              const d = delta(card.value, card.prev)
              return (
                <div
                  key={card.label}
                  className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 hover:shadow-md transition-shadow"
                >
                  <div className="text-sm text-gray-500 font-medium mb-1">{card.label}</div>
                  <div className={`text-2xl font-bold ${card.colorClass} truncate`}>
                    {card.prefix}{card.isCurrency ? fmt(card.value) : fmtInt(card.value)}
                  </div>
                  {prevOrders.length > 0 && (
                    <div className={`text-sm mt-1 font-medium ${d >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                      {d >= 0 ? '▲' : '▼'} {fmtPct(d)} vs ก่อนหน้า
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* ===== Sub-tabs ===== */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="border-b border-gray-200 overflow-x-auto scrollbar-thin">
              <nav className="flex min-w-max">
                {tabs.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setTab(t.key)}
                    className={`px-5 py-3 text-base font-semibold whitespace-nowrap border-b-2 transition-colors ${
                      tab === t.key
                        ? 'border-blue-500 text-blue-600'
                        : 'border-transparent text-gray-500 hover:text-blue-500'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </nav>
            </div>

            <div className="p-5">
              {orders.length === 0 ? (
                <div className="text-center py-16 text-gray-400">ไม่พบข้อมูลในช่วงเวลาที่เลือก</div>
              ) : (
                <>
                  {/* ---- Overview ---- */}
                  {tab === 'overview' && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      {/* Top 10 products */}
                      <div>
                        <h3 className="text-base font-bold text-gray-700 mb-3">Top 10 สินค้าขายดี</h3>
                        <div className="space-y-2">
                          {groupByProduct(orders).slice(0, 10).map((p, i) => {
                            const maxRev = groupByProduct(orders)[0]?.revenue || 1
                            return (
                              <div key={p.name} className="flex items-center gap-3">
                                <span className="w-6 text-right text-sm font-bold text-gray-400">{i + 1}</span>
                                <div className="flex-1 min-w-0">
                                  <div className="flex justify-between items-baseline mb-0.5">
                                    <span className="text-base font-medium truncate">{p.name}</span>
                                    <span className="text-sm font-semibold text-emerald-600 ml-2 whitespace-nowrap">฿{fmt(p.revenue)}</span>
                                  </div>
                                  <div className="w-full bg-gray-100 rounded-full h-2">
                                    <div
                                      className="bg-gradient-to-r from-blue-400 to-blue-600 h-2 rounded-full transition-all"
                                      style={{ width: `${(p.revenue / maxRev) * 100}%` }}
                                    />
                                  </div>
                                  <div className="text-sm text-gray-400 mt-0.5">{fmtInt(p.qty)} ชิ้น</div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>

                      {/* Top channels */}
                      <div>
                        <h3 className="text-base font-bold text-gray-700 mb-3">สัดส่วนยอดขายตามช่องทาง</h3>
                        <div className="space-y-2">
                          {channelData.slice(0, 8).map((c) => {
                            const maxRev = channelData[0]?.revenue || 1
                            const pct = kpi.totalRevenue > 0 ? (c.revenue / kpi.totalRevenue) * 100 : 0
                            return (
                              <div key={c.channel} className="flex items-center gap-3">
                                <span className="w-14 text-sm font-bold text-gray-600">{c.channel}</span>
                                <div className="flex-1 min-w-0">
                                  <div className="flex justify-between items-baseline mb-0.5">
                                    <span className="text-base text-gray-600">{channelNameMap[c.channel] || c.channel}</span>
                                    <span className="text-sm font-semibold text-emerald-600 ml-2 whitespace-nowrap">
                                      ฿{fmt(c.revenue)} ({pct.toFixed(1)}%)
                                    </span>
                                  </div>
                                  <div className="w-full bg-gray-100 rounded-full h-2">
                                    <div
                                      className="bg-gradient-to-r from-amber-400 to-orange-500 h-2 rounded-full transition-all"
                                      style={{ width: `${(c.revenue / maxRev) * 100}%` }}
                                    />
                                  </div>
                                  <div className="text-sm text-gray-400 mt-0.5">{fmtInt(c.orders)} บิล | {fmtInt(c.items)} ชิ้น</div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ---- By Channel ---- */}
                  {tab === 'channel' && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-base">
                        <thead>
                          <tr className="bg-gradient-to-r from-blue-600 to-blue-700 text-white">
                            <th className="p-3 text-left font-semibold rounded-tl-lg">#</th>
                            <th className="p-3 text-left font-semibold">ช่องทาง</th>
                            <th className="p-3 text-left font-semibold">ชื่อ</th>
                            <th className="p-3 text-right font-semibold">จำนวนบิล</th>
                            <th className="p-3 text-right font-semibold">ยอดขาย</th>
                            <th className="p-3 text-right font-semibold">เฉลี่ย/บิล</th>
                            <th className="p-3 text-right font-semibold">ชิ้น</th>
                            <th className="p-3 text-right font-semibold">ค่าส่ง</th>
                            <th className="p-3 text-right font-semibold rounded-tr-lg">สัดส่วน</th>
                          </tr>
                        </thead>
                        <tbody>
                          {channelData.map((r, i) => {
                            const pct = kpi.totalRevenue > 0 ? (r.revenue / kpi.totalRevenue) * 100 : 0
                            return (
                              <tr key={r.channel} className={`border-t border-gray-100 hover:bg-blue-50/50 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}>
                                <td className="p-3 text-gray-400 font-medium">{i + 1}</td>
                                <td className="p-3 font-bold">{r.channel}</td>
                                <td className="p-3 text-gray-600">{channelNameMap[r.channel] || '-'}</td>
                                <td className="p-3 text-right">{fmtInt(r.orders)}</td>
                                <td className="p-3 text-right font-semibold text-emerald-600">฿{fmt(r.revenue)}</td>
                                <td className="p-3 text-right">{r.orders ? '฿' + fmt(r.revenue / r.orders) : '-'}</td>
                                <td className="p-3 text-right">{fmtInt(r.items)}</td>
                                <td className="p-3 text-right">{fmt(r.shipping)}</td>
                                <td className="p-3 text-right">
                                  <div className="flex items-center justify-end gap-2">
                                    <div className="w-16 bg-gray-100 rounded-full h-2">
                                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${pct}%` }} />
                                    </div>
                                    <span className="text-sm text-gray-500 w-12 text-right">{pct.toFixed(1)}%</span>
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="bg-gray-100 font-bold border-t-2 border-gray-300">
                            <td className="p-3" colSpan={3}>รวมทั้งหมด</td>
                            <td className="p-3 text-right">{fmtInt(kpi.orderCount)}</td>
                            <td className="p-3 text-right text-emerald-600">฿{fmt(kpi.totalRevenue)}</td>
                            <td className="p-3 text-right">฿{fmt(kpi.avgOrderValue)}</td>
                            <td className="p-3 text-right">{fmtInt(kpi.totalItems)}</td>
                            <td className="p-3 text-right">{fmt(kpi.totalShipping)}</td>
                            <td className="p-3 text-right">100%</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}

                  {/* ---- By Product ---- */}
                  {tab === 'product' && (
                    <div>
                      <div className="mb-3">
                        <input
                          type="text"
                          placeholder="ค้นหาชื่อสินค้า..."
                          value={productSearch}
                          onChange={(e) => setProductSearch(e.target.value)}
                          className="border border-gray-300 rounded-lg px-3 py-2 text-base w-full max-w-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-base">
                          <thead>
                            <tr className="bg-gradient-to-r from-purple-600 to-purple-700 text-white">
                              <th className="p-3 text-left font-semibold rounded-tl-lg">#</th>
                              <th
                                className="p-3 text-left font-semibold cursor-pointer select-none hover:bg-purple-800/30"
                                onClick={() => toggleProductSort('name')}
                              >
                                สินค้า <SortIcon col="name" />
                              </th>
                              <th className="p-3 text-left font-semibold">ประเภท</th>
                              <th
                                className="p-3 text-right font-semibold cursor-pointer select-none hover:bg-purple-800/30"
                                onClick={() => toggleProductSort('qty')}
                              >
                                จำนวน <SortIcon col="qty" />
                              </th>
                              <th
                                className="p-3 text-right font-semibold cursor-pointer select-none hover:bg-purple-800/30"
                                onClick={() => toggleProductSort('revenue')}
                              >
                                ยอดขาย <SortIcon col="revenue" />
                              </th>
                              <th className="p-3 text-right font-semibold rounded-tr-lg">เฉลี่ย/ชิ้น</th>
                            </tr>
                          </thead>
                          <tbody>
                            {productData.map((r, i) => (
                              <tr key={r.name} className={`border-t border-gray-100 hover:bg-purple-50/50 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}>
                                <td className="p-3 text-gray-400 font-medium">{i + 1}</td>
                                <td className="p-3 font-medium">{r.name}</td>
                                <td className="p-3">
                                  <span className={`px-2 py-0.5 rounded-full text-sm font-bold ${r.type === 'FG' ? 'bg-blue-100 text-blue-700' : r.type === 'RM' ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-500'}`}>
                                    {r.type}
                                  </span>
                                </td>
                                <td className="p-3 text-right">{fmtInt(r.qty)}</td>
                                <td className="p-3 text-right font-semibold text-emerald-600">฿{fmt(r.revenue)}</td>
                                <td className="p-3 text-right text-gray-600">{r.qty ? '฿' + fmt(r.revenue / r.qty) : '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="bg-gray-100 font-bold border-t-2 border-gray-300">
                              <td className="p-3" colSpan={3}>รวม ({fmtInt(productData.length)} รายการ)</td>
                              <td className="p-3 text-right">{fmtInt(productData.reduce((s, r) => s + r.qty, 0))}</td>
                              <td className="p-3 text-right text-emerald-600">฿{fmt(productData.reduce((s, r) => s + r.revenue, 0))}</td>
                              <td className="p-3 text-right" />
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* ---- Daily Trend ---- */}
                  {tab === 'daily' && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-base">
                        <thead>
                          <tr className="bg-gradient-to-r from-teal-600 to-teal-700 text-white">
                            <th className="p-3 text-left font-semibold rounded-tl-lg">วันที่</th>
                            <th className="p-3 text-right font-semibold">จำนวนบิล</th>
                            <th className="p-3 text-right font-semibold">ยอดขาย</th>
                            <th className="p-3 text-right font-semibold">เฉลี่ย/บิล</th>
                            <th className="p-3 text-right font-semibold">ค่าส่ง</th>
                            <th className="p-3 text-right font-semibold">จำนวนชิ้น</th>
                            <th className="p-3 text-left font-semibold rounded-tr-lg">แนวโน้ม</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dailyData.map((r, i) => {
                            const maxRev = dailyData.reduce((m, d) => Math.max(m, d.revenue), 0) || 1
                            return (
                              <tr key={r.date} className={`border-t border-gray-100 hover:bg-teal-50/50 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}>
                                <td className="p-3 font-medium">{r.date}</td>
                                <td className="p-3 text-right">{fmtInt(r.orders)}</td>
                                <td className="p-3 text-right font-semibold text-emerald-600">฿{fmt(r.revenue)}</td>
                                <td className="p-3 text-right">{r.orders ? '฿' + fmt(r.revenue / r.orders) : '-'}</td>
                                <td className="p-3 text-right">{fmt(r.shipping)}</td>
                                <td className="p-3 text-right">{fmtInt(r.items)}</td>
                                <td className="p-3">
                                  <div className="w-24 bg-gray-100 rounded-full h-2.5">
                                    <div
                                      className="bg-gradient-to-r from-teal-400 to-emerald-500 h-2.5 rounded-full"
                                      style={{ width: `${(r.revenue / maxRev) * 100}%` }}
                                    />
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="bg-gray-100 font-bold border-t-2 border-gray-300">
                            <td className="p-3">รวม ({dailyData.length} วัน)</td>
                            <td className="p-3 text-right">{fmtInt(kpi.orderCount)}</td>
                            <td className="p-3 text-right text-emerald-600">฿{fmt(kpi.totalRevenue)}</td>
                            <td className="p-3 text-right">฿{fmt(kpi.avgOrderValue)}</td>
                            <td className="p-3 text-right">{fmt(kpi.totalShipping)}</td>
                            <td className="p-3 text-right">{fmtInt(kpi.totalItems)}</td>
                            <td className="p-3" />
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}

                  {/* ---- By Admin ---- */}
                  {tab === 'admin' && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-base">
                        <thead>
                          <tr className="bg-gradient-to-r from-indigo-600 to-indigo-700 text-white">
                            <th className="p-3 text-left font-semibold rounded-tl-lg">#</th>
                            <th className="p-3 text-left font-semibold">แอดมิน</th>
                            <th className="p-3 text-right font-semibold">จำนวนบิล</th>
                            <th className="p-3 text-right font-semibold">ยอดขาย</th>
                            <th className="p-3 text-right font-semibold">เฉลี่ย/บิล</th>
                            <th className="p-3 text-right font-semibold">จำนวนชิ้น</th>
                            <th className="p-3 text-right font-semibold rounded-tr-lg">สัดส่วน</th>
                          </tr>
                        </thead>
                        <tbody>
                          {adminData.map((r, i) => {
                            const pct = kpi.totalRevenue > 0 ? (r.revenue / kpi.totalRevenue) * 100 : 0
                            return (
                              <tr key={r.admin} className={`border-t border-gray-100 hover:bg-indigo-50/50 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}>
                                <td className="p-3 text-gray-400 font-medium">{i + 1}</td>
                                <td className="p-3 font-medium">{r.admin}</td>
                                <td className="p-3 text-right">{fmtInt(r.orders)}</td>
                                <td className="p-3 text-right font-semibold text-emerald-600">฿{fmt(r.revenue)}</td>
                                <td className="p-3 text-right">{r.orders ? '฿' + fmt(r.revenue / r.orders) : '-'}</td>
                                <td className="p-3 text-right">{fmtInt(r.items)}</td>
                                <td className="p-3 text-right">
                                  <div className="flex items-center justify-end gap-2">
                                    <div className="w-16 bg-gray-100 rounded-full h-2">
                                      <div className="bg-indigo-500 h-2 rounded-full" style={{ width: `${pct}%` }} />
                                    </div>
                                    <span className="text-sm text-gray-500 w-12 text-right">{pct.toFixed(1)}%</span>
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="bg-gray-100 font-bold border-t-2 border-gray-300">
                            <td className="p-3" colSpan={2}>รวม ({adminData.length} คน)</td>
                            <td className="p-3 text-right">{fmtInt(kpi.orderCount)}</td>
                            <td className="p-3 text-right text-emerald-600">฿{fmt(kpi.totalRevenue)}</td>
                            <td className="p-3 text-right">฿{fmt(kpi.avgOrderValue)}</td>
                            <td className="p-3 text-right">{fmtInt(kpi.totalItems)}</td>
                            <td className="p-3 text-right">100%</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}

                  {/* ---- Order List ---- */}
                  {tab === 'orders' && (
                    <div>
                      <div className="text-sm text-gray-500 mb-2">
                        แสดง {pagedOrders.length} จาก {fmtInt(orderList.length)} รายการ (หน้า {orderPage + 1}/{totalOrderPages || 1})
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-base">
                          <thead>
                            <tr className="bg-gradient-to-r from-gray-700 to-gray-800 text-white">
                              <th className="p-3 text-left font-semibold rounded-tl-lg">#</th>
                              <th className="p-3 text-left font-semibold">เลขบิล</th>
                              <th className="p-3 text-left font-semibold">ช่องทาง</th>
                              <th className="p-3 text-left font-semibold">ลูกค้า</th>
                              <th className="p-3 text-right font-semibold">ยอดรวม</th>
                              <th className="p-3 text-right font-semibold">ค่าส่ง</th>
                              <th className="p-3 text-right font-semibold">ส่วนลด</th>
                              <th className="p-3 text-center font-semibold">สถานะ</th>
                              <th className="p-3 text-left font-semibold">วันที่</th>
                              <th className="p-3 text-left font-semibold">แอดมิน</th>
                              <th className="p-3 text-right font-semibold rounded-tr-lg">ชิ้น</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pagedOrders.map((r, i) => (
                              <tr key={r.bill_no} className={`border-t border-gray-100 hover:bg-gray-50 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}>
                                <td className="p-3 text-gray-400 text-sm">{orderPage * ORDER_PAGE_SIZE + i + 1}</td>
                                <td className="p-3 font-medium text-blue-600">{r.bill_no}</td>
                                <td className="p-3">
                                  <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-sm font-semibold">{r.channel}</span>
                                </td>
                                <td className="p-3 truncate max-w-[160px]">{r.customer}</td>
                                <td className="p-3 text-right font-semibold text-emerald-600">฿{fmt(r.total)}</td>
                                <td className="p-3 text-right text-gray-500">{fmt(r.shipping)}</td>
                                <td className="p-3 text-right text-rose-500">{r.discount > 0 ? fmt(r.discount) : '-'}</td>
                                <td className="p-3 text-center">
                                  <span className={`px-2 py-0.5 rounded-full text-sm font-bold ${
                                    r.status === 'จัดส่งแล้ว' ? 'bg-emerald-100 text-emerald-700'
                                    : r.status === 'ยกเลิก' ? 'bg-red-100 text-red-700'
                                    : 'bg-gray-100 text-gray-700'
                                  }`}>
                                    {r.status}
                                  </span>
                                </td>
                                <td className="p-3 text-gray-600">{r.date}</td>
                                <td className="p-3 text-gray-600">{r.admin}</td>
                                <td className="p-3 text-right">{fmtInt(r.items)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Pagination */}
                      {totalOrderPages > 1 && (
                        <div className="flex items-center justify-center gap-2 mt-4">
                          <button
                            disabled={orderPage === 0}
                            onClick={() => setOrderPage((p) => Math.max(0, p - 1))}
                            className="px-3 py-1.5 rounded-lg border text-base font-medium disabled:opacity-40 hover:bg-gray-100 transition-colors"
                          >
                            ก่อนหน้า
                          </button>
                          {Array.from({ length: Math.min(totalOrderPages, 7) }, (_, i) => {
                            let page: number
                            if (totalOrderPages <= 7) {
                              page = i
                            } else if (orderPage < 3) {
                              page = i
                            } else if (orderPage > totalOrderPages - 4) {
                              page = totalOrderPages - 7 + i
                            } else {
                              page = orderPage - 3 + i
                            }
                            return (
                              <button
                                key={page}
                                onClick={() => setOrderPage(page)}
                                className={`w-8 h-8 rounded-lg text-base font-medium transition-colors ${
                                  orderPage === page
                                    ? 'bg-blue-600 text-white'
                                    : 'hover:bg-gray-100 text-gray-600'
                                }`}
                              >
                                {page + 1}
                              </button>
                            )
                          })}
                          <button
                            disabled={orderPage >= totalOrderPages - 1}
                            onClick={() => setOrderPage((p) => Math.min(totalOrderPages - 1, p + 1))}
                            className="px-3 py-1.5 rounded-lg border text-base font-medium disabled:opacity-40 hover:bg-gray-100 transition-colors"
                          >
                            ถัดไป
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
