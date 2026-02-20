import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getPublicUrl } from '../lib/qcApi'
import { useAuthContext } from '../contexts/AuthContext'
import { Product, ProductType, StockBalance } from '../types'
import LotCostPopover from '../components/ui/LotCostPopover'

const BUCKET_PRODUCT_IMAGES = 'product-images'

function getProductImageUrl(productCode: string | null | undefined, ext: string = '.jpg'): string {
  return getPublicUrl(BUCKET_PRODUCT_IMAGES, productCode, ext)
}

function toNumber(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

function defaultSalesFromDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toISOString().slice(0, 10)
}

export default function Warehouse() {
  const { user } = useAuthContext()
  const canSeeCost = user?.role === 'superadmin'

  const [products, setProducts] = useState<Product[]>([])
  const [balances, setBalances] = useState<Record<string, StockBalance>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [sellerFilter, setSellerFilter] = useState('')
  const [productTypeFilter, setProductTypeFilter] = useState<'' | ProductType>('')
  const [onlyBelowOrderPoint, setOnlyBelowOrderPoint] = useState(false)
  const [categories, setCategories] = useState<string[]>([])
  const [sellers, setSellers] = useState<string[]>([])
  const [salesFromDate, setSalesFromDate] = useState(defaultSalesFromDate)
  const [salesMap, setSalesMap] = useState<Record<string, number>>({})
  const [salesLoading, setSalesLoading] = useState(false)

  useEffect(() => {
    loadProducts()
    loadBalances()
    loadCategories()
    loadSellers()
  }, [])

  useEffect(() => {
    loadSalesData()
  }, [salesFromDate])

  async function loadProducts() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('pr_products')
        .select('id, product_code, product_name, product_category, product_type, order_point, seller_name, landed_cost')
        .eq('is_active', true)
        .order('product_code', { ascending: true })
      if (error) throw error
      setProducts((data || []) as Product[])
    } catch (e) {
      console.error('Load products failed:', e)
    } finally {
      setLoading(false)
    }
  }

  async function loadBalances() {
    try {
      const { data, error } = await supabase
        .from('inv_stock_balances')
        .select('id, product_id, on_hand, reserved, safety_stock, created_at, updated_at')
      if (error) throw error
      const map: Record<string, StockBalance> = {}
      ;(data || []).forEach((row) => {
        map[row.product_id] = row as StockBalance
      })
      setBalances(map)
    } catch (e) {
      console.error('Load stock balances failed:', e)
    }
  }

  async function loadCategories() {
    try {
      const { data, error } = await supabase
        .from('pr_products')
        .select('product_category')
        .eq('is_active', true)
        .not('product_category', 'is', null)
      if (error) throw error
      const list = (data || [])
        .map((r: { product_category: string | null }) => r.product_category)
        .filter(Boolean) as string[]
      setCategories([...new Set(list)].sort())
    } catch (e) {
      console.error('Load categories failed:', e)
    }
  }

  async function loadSellers() {
    try {
      const { data, error } = await supabase
        .from('pr_sellers')
        .select('name')
        .eq('is_active', true)
        .order('name')
      if (error) throw error
      setSellers((data || []).map((r: { name: string }) => r.name))
    } catch (e) {
      console.error('Load sellers failed:', e)
    }
  }

  async function loadSalesData() {
    setSalesLoading(true)
    try {
      const { data, error } = await supabase.rpc('calc_avg_daily_sales', {
        p_from_date: salesFromDate,
      })
      if (error) throw error
      const map: Record<string, number> = {}
      ;(data || []).forEach((row: { product_id: string; total_sold: number }) => {
        map[row.product_id] = Number(row.total_sold)
      })
      setSalesMap(map)
    } catch (e) {
      console.error('Load sales data failed:', e)
    } finally {
      setSalesLoading(false)
    }
  }

  function calcDaysRemaining(productId: string, onHand: number): number | null {
    const totalSold = salesMap[productId]
    if (!totalSold || totalSold <= 0) return null
    const from = new Date(salesFromDate)
    const today = new Date()
    const diffMs = today.getTime() - from.getTime()
    const diffDays = Math.max(diffMs / (1000 * 60 * 60 * 24), 1)
    const avgPerDay = totalSold / diffDays
    if (avgPerDay <= 0) return null
    return Math.round(onHand / avgPerDay)
  }

  // คำนวณจำนวนสินค้าที่ต่ำกว่าจุดสั่งซื้อ (ใช้ทั้งแสดงปุ่มและส่งไป Sidebar)
  const belowOrderPointCount = useMemo(() => {
    return products.filter((p) => {
      const balance = balances[p.id]
      const onHand = Number(balance?.on_hand || 0)
      const orderPoint = toNumber(p.order_point)
      return orderPoint !== null && orderPoint > 0 && onHand < orderPoint
    }).length
  }, [products, balances])

  // ส่งจำนวนไป Sidebar ทุกครั้งที่เปลี่ยน
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('warehouse-below-order-point', { detail: { count: belowOrderPointCount } })
    )
  }, [belowOrderPointCount])

  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase()
    return products.filter((p) => {
      const matchTerm =
        !term ||
        p.product_code.toLowerCase().includes(term) ||
        p.product_name.toLowerCase().includes(term)
      const matchCategory = !categoryFilter || (p.product_category || '') === categoryFilter
      const matchSeller = !sellerFilter || (p.seller_name || '') === sellerFilter
      const matchProductType = !productTypeFilter || p.product_type === productTypeFilter

      // ตัวกรองถึงจุดสั่งซื้อ
      let matchOrderPoint = true
      if (onlyBelowOrderPoint) {
        const balance = balances[p.id]
        const onHand = Number(balance?.on_hand || 0)
        const orderPoint = toNumber(p.order_point)
        matchOrderPoint = orderPoint !== null && orderPoint > 0 && onHand < orderPoint
      }

      return matchTerm && matchCategory && matchSeller && matchProductType && matchOrderPoint
    })
  }, [products, search, categoryFilter, sellerFilter, productTypeFilter, onlyBelowOrderPoint, balances])

  return (
    <div className="space-y-6 mt-4">
      <div className="bg-white p-6 rounded-lg shadow">
        <div className="flex flex-wrap gap-4 mb-4 items-center">
          <div className="flex-1 min-w-[200px]">
            <label htmlFor="warehouse-search" className="sr-only">ค้นหาสินค้า</label>
            <input
              id="warehouse-search"
              type="text"
              autoComplete="off"
              placeholder="ค้นหารหัสสินค้าหรือชื่อสินค้า..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-surface-50 text-base"
            />
          </div>
          <div className="w-full sm:w-auto sm:min-w-[150px]">
            <label htmlFor="warehouse-product-type" className="sr-only">ประเภทสินค้า</label>
            <select
              id="warehouse-product-type"
              value={productTypeFilter}
              onChange={(e) => setProductTypeFilter(e.target.value as '' | ProductType)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white text-base"
            >
              <option value="">ทุกประเภท</option>
              <option value="FG">FG - สินค้าสำเร็จรูป</option>
              <option value="RM">RM - วัตถุดิบ</option>
              <option value="PP">PP - สินค้าแปรรูป</option>
            </select>
          </div>
          <div className="w-full sm:w-auto sm:min-w-[180px]">
            <label htmlFor="warehouse-category" className="sr-only">หมวดหมู่</label>
            <select
              id="warehouse-category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white text-base"
            >
              <option value="">หมวดหมู่ทั้งหมด</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="w-full sm:w-auto sm:min-w-[180px]">
            <label htmlFor="warehouse-seller" className="sr-only">ผู้ขาย</label>
            <select
              id="warehouse-seller"
              value={sellerFilter}
              onChange={(e) => setSellerFilter(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white text-base"
            >
              <option value="">ผู้ขายทั้งหมด</option>
              {sellers.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => setOnlyBelowOrderPoint((v) => !v)}
            className={`px-4 py-2.5 rounded-xl font-semibold text-sm border transition-colors whitespace-nowrap ${
              onlyBelowOrderPoint
                ? 'bg-orange-500 text-white border-orange-500 hover:bg-orange-600'
                : 'bg-white text-orange-600 border-orange-300 hover:bg-orange-50'
            }`}
          >
            ถึงจุดสั่งซื้อ {belowOrderPointCount > 0 && (
              <span className={`ml-1.5 inline-flex items-center justify-center min-w-[1.4rem] h-5 px-1.5 rounded-full text-xs font-bold ${
                onlyBelowOrderPoint ? 'bg-white text-orange-600' : 'bg-orange-500 text-white'
              }`}>
                {belowOrderPointCount}
              </span>
            )}
          </button>
          <div className="flex items-center gap-2">
            <label htmlFor="sales-from-date" className="text-sm text-gray-600 whitespace-nowrap">
              คำนวณยอดขายตั้งแต่
            </label>
            <input
              id="sales-from-date"
              type="date"
              value={salesFromDate}
              onChange={(e) => setSalesFromDate(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white text-sm"
            />
            {salesLoading && (
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-500"></div>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="text-center py-12 text-gray-500">ไม่พบข้อมูลสินค้า</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-3 text-left font-semibold rounded-tl-xl">รูป</th>
                  <th className="p-3 text-left font-semibold">รหัสสินค้า</th>
                  <th className="p-3 text-center font-semibold">ประเภท</th>
                  <th className="p-3 text-left font-semibold">หมวดหมู่</th>
                  <th className="p-3 text-left font-semibold">ชื่อสินค้า</th>
                  <th className="p-3 text-left font-semibold">ผู้ขาย</th>
                  <th className="p-3 text-center font-semibold">จุดสั่งซื้อ</th>
                  <th className="p-3 text-center font-semibold">จำนวนคงเหลือ</th>
                  <th className="p-3 text-center font-semibold">Safety stock</th>
                  <th className="p-3 text-center font-semibold">รวมในคลัง</th>
                  <th className={`p-3 text-center font-semibold ${!canSeeCost ? 'rounded-tr-xl' : ''}`}>วันขายคงเหลือ</th>
                  {canSeeCost && <th className="p-3 text-right font-semibold rounded-tr-xl">ต้นทุนสินค้า</th>}
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((product, idx) => {
                  const balance = balances[product.id]
                  const onHand = Number(balance?.on_hand || 0)
                  const safetyStock = balance?.safety_stock != null ? Number(balance.safety_stock) : null
                  const orderPoint = toNumber(product.order_point)
                  const isLow =
                    orderPoint !== null && orderPoint > 0 && onHand < orderPoint
                  return (
                    <tr key={product.id} className={`border-t border-surface-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                      <td className="p-3">
                        <ProductImage code={product.product_code} name={product.product_name} />
                      </td>
                      <td className="p-3 font-medium">{product.product_code}</td>
                      <td className="p-3 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${
                          product.product_type === 'RM'
                            ? 'bg-amber-100 text-amber-700'
                            : product.product_type === 'PP'
                              ? 'bg-purple-100 text-purple-700'
                              : 'bg-emerald-100 text-emerald-700'
                        }`}>
                          {product.product_type || 'FG'}
                        </span>
                      </td>
                      <td className="p-3">{product.product_category || '-'}</td>
                      <td className="p-3">{product.product_name}</td>
                      <td className="p-3 text-sm">{product.seller_name || '-'}</td>
                      <td className="p-3 text-center">{product.order_point || '-'}</td>
                      <td className={`p-3 text-center ${isLow ? 'bg-orange-50 text-orange-700 font-semibold' : ''}`}>
                        {onHand.toLocaleString()}
                      </td>
                      <td className="p-3 text-center">{safetyStock !== null ? safetyStock.toLocaleString() : '-'}</td>
                      <td className="p-3 text-center font-medium text-gray-700">
                        {(onHand + (safetyStock ?? 0)).toLocaleString()}
                      </td>
                      <td className="p-3 text-center">
                        {(() => {
                          const days = calcDaysRemaining(product.id, onHand)
                          if (days === null) return <span className="text-gray-400">-</span>
                          const color =
                            days <= 7
                              ? 'text-red-600 font-bold'
                              : days <= 14
                                ? 'text-orange-600 font-semibold'
                                : days <= 30
                                  ? 'text-yellow-600 font-medium'
                                  : 'text-green-600'
                          return <span className={color}>{days} วัน</span>
                        })()}
                      </td>
                      {canSeeCost && (
                        <td className="p-3 text-right font-medium">
                          {product.landed_cost != null && Number(product.landed_cost) > 0 ? (
                            <LotCostPopover productId={product.id} landedCost={Number(product.landed_cost)}>
                              {Number(product.landed_cost).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ฿
                            </LotCostPopover>
                          ) : '-'}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function ProductImage({ code, name }: { code: string; name: string }) {
  const [failed, setFailed] = useState(false)
  const url = code ? getProductImageUrl(code) : ''
  const displayUrl = url && !failed ? url : ''
  if (!displayUrl) {
    return (
      <div className="w-16 h-16 bg-gray-200 rounded flex items-center justify-center text-gray-400 text-xs">
        ไม่มีรูป
      </div>
    )
  }
  return (
    <a
      href={displayUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-16 h-16 rounded overflow-hidden hover:ring-2 hover:ring-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
      title="คลิกเพื่อเปิดรูปในแท็บใหม่"
    >
      <img
        src={displayUrl}
        alt={name}
        className="w-16 h-16 object-cover"
        onError={() => setFailed(true)}
      />
    </a>
  )
}
