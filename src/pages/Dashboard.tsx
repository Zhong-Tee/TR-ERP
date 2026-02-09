import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  FiPackage,
  FiCheckCircle,
  FiTruck,
  FiDollarSign,
  FiAlertCircle,
  FiShoppingBag,
  FiArchive,
  FiBarChart2,
} from 'react-icons/fi'

interface OrderRow {
  id: string
  bill_no: string
  status: string
  total_amount: number
  channel_code: string
  customer_name: string
  created_at: string
  work_order_name?: string | null
}

interface IssueRow {
  id: string
  status: string
}

const STATUS_COLORS: Record<string, string> = {
  'รอลงข้อมูล': 'bg-yellow-100 text-yellow-700',
  'รอตรวจคำสั่งซื้อ': 'bg-orange-100 text-orange-700',
  'ลงข้อมูลเสร็จสิ้น': 'bg-blue-100 text-blue-700',
  'ตรวจสอบแล้ว': 'bg-indigo-100 text-indigo-700',
  'รอคอนเฟิร์ม': 'bg-purple-100 text-purple-700',
  'คอนเฟิร์มแล้ว': 'bg-cyan-100 text-cyan-700',
  'ใบสั่งงาน': 'bg-teal-100 text-teal-700',
  'ใบงานกำลังผลิต': 'bg-amber-100 text-amber-700',
  'จัดส่งแล้ว': 'bg-green-100 text-green-700',
  'ยกเลิก': 'bg-red-100 text-red-700',
}

function formatCurrency(n: number) {
  return '฿' + n.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

export default function Dashboard() {
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [products, setProducts] = useState<{ id: string; product_category: string | null }[]>([])
  const [issues, setIssues] = useState<IssueRow[]>([])
  const [orderItems, setOrderItems] = useState<{ product_name: string; quantity: number }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [ordersRes, productsRes, issuesRes, itemsRes] = await Promise.all([
        supabase
          .from('or_orders')
          .select('id, bill_no, status, total_amount, channel_code, customer_name, created_at, work_order_name')
          .order('created_at', { ascending: false })
          .limit(1000),
        supabase
          .from('pr_products')
          .select('id, product_category')
          .eq('is_active', true),
        supabase
          .from('or_issues')
          .select('id, status'),
        supabase
          .from('or_order_items')
          .select('product_name, quantity'),
      ])
      if (ordersRes.data) setOrders(ordersRes.data as OrderRow[])
      if (productsRes.data) setProducts(productsRes.data)
      if (issuesRes.data) setIssues(issuesRes.data as IssueRow[])
      if (itemsRes.data) setOrderItems(itemsRes.data as { product_name: string; quantity: number }[])
    } catch (e) {
      console.error('Dashboard load failed:', e)
    } finally {
      setLoading(false)
    }
  }

  const today = new Date().toISOString().slice(0, 10)

  const stats = useMemo(() => {
    const totalOrders = orders.length
    const todayOrders = orders.filter((o) => o.created_at?.slice(0, 10) === today).length
    const totalRevenue = orders
      .filter((o) => o.status !== 'ยกเลิก')
      .reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0)
    const todayRevenue = orders
      .filter((o) => o.created_at?.slice(0, 10) === today && o.status !== 'ยกเลิก')
      .reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0)
    const shipped = orders.filter((o) => o.status === 'จัดส่งแล้ว').length
    const pending = orders.filter((o) =>
      ['รอลงข้อมูล', 'รอตรวจคำสั่งซื้อ', 'ลงข้อมูลเสร็จสิ้น'].includes(o.status)
    ).length
    const production = orders.filter((o) =>
      ['ใบสั่งงาน', 'ใบงานกำลังผลิต'].includes(o.status)
    ).length
    const cancelled = orders.filter((o) => o.status === 'ยกเลิก').length
    const totalProducts = products.length
    const openIssues = issues.filter((i) => i.status === 'On').length
    return { totalOrders, todayOrders, totalRevenue, todayRevenue, shipped, pending, production, cancelled, totalProducts, openIssues }
  }, [orders, products, issues, today])

  const statusBreakdown = useMemo(() => {
    const map: Record<string, number> = {}
    orders.forEach((o) => {
      map[o.status] = (map[o.status] || 0) + 1
    })
    return Object.entries(map).sort((a, b) => b[1] - a[1])
  }, [orders])

  const channelBreakdown = useMemo(() => {
    const map: Record<string, { count: number; revenue: number }> = {}
    orders.filter((o) => o.status !== 'ยกเลิก').forEach((o) => {
      const ch = o.channel_code || 'N/A'
      if (!map[ch]) map[ch] = { count: 0, revenue: 0 }
      map[ch].count += 1
      map[ch].revenue += Number(o.total_amount) || 0
    })
    return Object.entries(map).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 8)
  }, [orders])

  const topRevenueOrders = useMemo(() =>
    [...orders]
      .filter((o) => o.status !== 'ยกเลิก' && Number(o.total_amount) > 0)
      .sort((a, b) => Number(b.total_amount) - Number(a.total_amount))
      .slice(0, 10),
    [orders]
  )

  const categoryBreakdown = useMemo(() => {
    const map: Record<string, number> = {}
    products.forEach((p) => {
      const cat = p.product_category || 'ไม่ระบุ'
      map[cat] = (map[cat] || 0) + 1
    })
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 6)
  }, [products])

  const totalCategoryProducts = useMemo(
    () => categoryBreakdown.reduce((sum, [, count]) => sum + count, 0),
    [categoryBreakdown]
  )

  const topSellingProducts = useMemo(() => {
    const map: Record<string, number> = {}
    orderItems.forEach((item) => {
      const name = item.product_name || 'ไม่ระบุ'
      map[name] = (map[name] || 0) + (Number(item.quantity) || 0)
    })
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 10)
  }, [orderItems])

  const CATEGORY_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#6366F1', '#14B8A6']

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  return (
    <div className="space-y-6 pt-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-gray-200 p-5 flex items-center gap-4 shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-blue-100 flex items-center justify-center text-blue-600">
            <FiPackage className="w-6 h-6" />
          </div>
          <div>
            <div className="text-sm text-gray-500 font-medium">ออเดอร์ทั้งหมด</div>
            <div className="text-2xl font-black text-gray-900">{stats.totalOrders.toLocaleString()}</div>
            <div className="text-xs text-blue-600 font-semibold">+{stats.todayOrders} วันนี้</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-5 flex items-center gap-4 shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-green-100 flex items-center justify-center text-green-600">
            <FiDollarSign className="w-6 h-6" />
          </div>
          <div>
            <div className="text-sm text-gray-500 font-medium">ยอดขายรวม</div>
            <div className="text-2xl font-black text-gray-900">{formatCurrency(stats.totalRevenue)}</div>
            <div className="text-xs text-green-600 font-semibold">+{formatCurrency(stats.todayRevenue)} วันนี้</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-5 flex items-center gap-4 shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-emerald-100 flex items-center justify-center text-emerald-600">
            <FiTruck className="w-6 h-6" />
          </div>
          <div>
            <div className="text-sm text-gray-500 font-medium">จัดส่งแล้ว</div>
            <div className="text-2xl font-black text-gray-900">{stats.shipped.toLocaleString()}</div>
            <div className="text-xs text-emerald-600 font-semibold">{stats.totalOrders > 0 ? ((stats.shipped / stats.totalOrders) * 100).toFixed(1) : 0}%</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-5 flex items-center gap-4 shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-amber-100 flex items-center justify-center text-amber-600">
            <FiAlertCircle className="w-6 h-6" />
          </div>
          <div>
            <div className="text-sm text-gray-500 font-medium">รอดำเนินการ</div>
            <div className="text-2xl font-black text-gray-900">{stats.pending.toLocaleString()}</div>
            <div className="text-xs text-amber-600 font-semibold">{stats.openIssues} Issue เปิดอยู่</div>
          </div>
        </div>
      </div>

      {/* Second row cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-gray-200 p-5 flex items-center gap-4 shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-indigo-100 flex items-center justify-center text-indigo-600">
            <FiCheckCircle className="w-6 h-6" />
          </div>
          <div>
            <div className="text-sm text-gray-500 font-medium">กำลังผลิต</div>
            <div className="text-2xl font-black text-gray-900">{stats.production.toLocaleString()}</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-5 flex items-center gap-4 shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-red-100 flex items-center justify-center text-red-600">
            <FiShoppingBag className="w-6 h-6" />
          </div>
          <div>
            <div className="text-sm text-gray-500 font-medium">ยกเลิก</div>
            <div className="text-2xl font-black text-gray-900">{stats.cancelled.toLocaleString()}</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-5 flex items-center gap-4 shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-purple-100 flex items-center justify-center text-purple-600">
            <FiArchive className="w-6 h-6" />
          </div>
          <div>
            <div className="text-sm text-gray-500 font-medium">สินค้าในระบบ</div>
            <div className="text-2xl font-black text-gray-900">{stats.totalProducts.toLocaleString()}</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-5 flex items-center gap-4 shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-teal-100 flex items-center justify-center text-teal-600">
            <FiBarChart2 className="w-6 h-6" />
          </div>
          <div>
            <div className="text-sm text-gray-500 font-medium">ยอดเฉลี่ย/บิล</div>
            <div className="text-2xl font-black text-gray-900">
              {stats.totalOrders > 0 ? formatCurrency(Math.round(stats.totalRevenue / (stats.totalOrders - stats.cancelled || 1))) : '฿0'}
            </div>
          </div>
        </div>
      </div>

      {/* Middle section: Status breakdown + Channel sales */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Status Breakdown */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-4">สถานะออเดอร์</h3>
          <div className="space-y-3">
            {statusBreakdown.map(([status, count]) => {
              const pct = stats.totalOrders > 0 ? (count / stats.totalOrders) * 100 : 0
              return (
                <div key={status}>
                  <div className="flex items-center justify-between mb-1">
                    <span className={`px-2.5 py-1 rounded-lg text-xs font-bold ${STATUS_COLORS[status] || 'bg-gray-100 text-gray-700'}`}>
                      {status}
                    </span>
                    <span className="text-sm font-semibold text-gray-700">{count.toLocaleString()}</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-2">
                    <div
                      className="h-2 rounded-full bg-blue-500 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Channel Sales */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-4">ยอดขายตามช่องทาง</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-3 text-left font-semibold rounded-tl-xl">ช่องทาง</th>
                  <th className="p-3 text-center font-semibold">จำนวนบิล</th>
                  <th className="p-3 text-right font-semibold rounded-tr-xl">ยอดขาย</th>
                </tr>
              </thead>
              <tbody>
                {channelBreakdown.map(([ch, data], idx) => (
                  <tr key={ch} className={`border-b border-gray-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="p-3 font-semibold text-gray-900">{ch}</td>
                    <td className="p-3 text-center text-gray-700">{data.count.toLocaleString()}</td>
                    <td className="p-3 text-right font-bold text-green-600">{formatCurrency(data.revenue)}</td>
                  </tr>
                ))}
                {channelBreakdown.length === 0 && (
                  <tr>
                    <td colSpan={3} className="p-6 text-center text-gray-400">ไม่มีข้อมูล</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Bottom section: Product categories + Recent orders */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Product Categories */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-4">หมวดหมู่สินค้า</h3>
          <div className="flex items-center gap-6">
            {/* Simple donut representation */}
            <div className="relative w-32 h-32 flex-shrink-0">
              <svg viewBox="0 0 36 36" className="w-32 h-32 -rotate-90">
                {(() => {
                  let offset = 0
                  return categoryBreakdown.map(([cat, count], i) => {
                    const pct = totalCategoryProducts > 0 ? (count / totalCategoryProducts) * 100 : 0
                    const dashArray = `${pct} ${100 - pct}`
                    const el = (
                      <circle
                        key={cat}
                        cx="18"
                        cy="18"
                        r="15.915"
                        fill="none"
                        stroke={CATEGORY_COLORS[i % CATEGORY_COLORS.length]}
                        strokeWidth="3.5"
                        strokeDasharray={dashArray}
                        strokeDashoffset={`-${offset}`}
                      />
                    )
                    offset += pct
                    return el
                  })
                })()}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <div className="text-xs text-gray-500">รวม</div>
                <div className="text-xl font-black text-gray-900">{totalCategoryProducts}</div>
              </div>
            </div>
            <div className="flex-1 space-y-2">
              {categoryBreakdown.map(([cat, count], i) => (
                <div key={cat} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} />
                    <span className="text-sm text-gray-700 truncate max-w-[120px]">{cat}</span>
                  </div>
                  <span className="text-sm font-bold text-gray-900">{count} <span className="text-gray-500 font-medium">รายการ</span></span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Top Revenue Orders */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-4">อันดับออเดอร์ยอดขายสูงสุด</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-2.5 text-center font-semibold rounded-tl-xl w-12">#</th>
                  <th className="p-2.5 text-left font-semibold">ลูกค้า</th>
                  <th className="p-2.5 text-left font-semibold">ช่องทาง</th>
                  <th className="p-2.5 text-right font-semibold">ยอด</th>
                  <th className="p-2.5 text-center font-semibold rounded-tr-xl">สถานะ</th>
                </tr>
              </thead>
              <tbody>
                {topRevenueOrders.map((o, idx) => (
                  <tr key={o.id} className={`border-b border-gray-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="p-2.5 text-center">
                      {idx < 3 ? (
                        <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold text-white ${
                          idx === 0 ? 'bg-yellow-500' : idx === 1 ? 'bg-gray-400' : 'bg-amber-700'
                        }`}>
                          {idx + 1}
                        </span>
                      ) : (
                        <span className="text-gray-500 font-semibold">{idx + 1}</span>
                      )}
                    </td>
                    <td className="p-2.5">
                      <div className="font-medium text-gray-900 truncate max-w-[140px]">{o.customer_name || '-'}</div>
                      <div className="text-xs text-gray-400">{o.bill_no}</div>
                    </td>
                    <td className="p-2.5 text-gray-600 font-medium">{o.channel_code}</td>
                    <td className="p-2.5 text-right font-bold text-green-600">{formatCurrency(Number(o.total_amount) || 0)}</td>
                    <td className="p-2.5 text-center">
                      <span className={`inline-flex px-2 py-1 rounded-lg text-[11px] font-bold ${STATUS_COLORS[o.status] || 'bg-gray-100 text-gray-700'}`}>
                        {o.status}
                      </span>
                    </td>
                  </tr>
                ))}
                {topRevenueOrders.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-6 text-center text-gray-400">ไม่มีข้อมูล</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Top Selling Products */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
        <h3 className="text-lg font-bold text-gray-900 mb-4">สินค้าขายดี</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-blue-600 text-white">
                <th className="p-3 text-center font-semibold rounded-tl-xl w-16">ลำดับ</th>
                <th className="p-3 text-left font-semibold">ชื่อสินค้า</th>
                <th className="p-3 text-center font-semibold w-32">จำนวนขาย</th>
                <th className="p-3 text-left font-semibold rounded-tr-xl">สัดส่วน</th>
              </tr>
            </thead>
            <tbody>
              {topSellingProducts.map(([name, qty], idx) => {
                const maxQty = topSellingProducts[0]?.[1] || 1
                const pct = (qty / maxQty) * 100
                return (
                  <tr key={name} className={`border-b border-gray-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="p-3 text-center">
                      {idx < 3 ? (
                        <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold text-white ${
                          idx === 0 ? 'bg-yellow-500' : idx === 1 ? 'bg-gray-400' : 'bg-amber-700'
                        }`}>
                          {idx + 1}
                        </span>
                      ) : (
                        <span className="text-gray-500 font-semibold">{idx + 1}</span>
                      )}
                    </td>
                    <td className="p-3 font-semibold text-gray-900">{name}</td>
                    <td className="p-3 text-center font-bold text-blue-700">{qty.toLocaleString()}</td>
                    <td className="p-3">
                      <div className="w-full bg-gray-100 rounded-full h-2.5">
                        <div
                          className="h-2.5 rounded-full bg-blue-500 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                )
              })}
              {topSellingProducts.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-gray-400">ไม่มีข้อมูล</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
