import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getPublicUrl } from '../lib/qcApi'
import { Product, StockBalance } from '../types'

const BUCKET_PRODUCT_IMAGES = 'product-images'

function getProductImageUrl(productCode: string | null | undefined, ext: string = '.jpg'): string {
  return getPublicUrl(BUCKET_PRODUCT_IMAGES, productCode, ext)
}

function toNumber(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

export default function Warehouse() {
  const [products, setProducts] = useState<Product[]>([])
  const [balances, setBalances] = useState<Record<string, StockBalance>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [categories, setCategories] = useState<string[]>([])

  useEffect(() => {
    loadProducts()
    loadBalances()
    loadCategories()
  }, [])

  async function loadProducts() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('pr_products')
        .select('id, product_code, product_name, product_category, order_point')
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

  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase()
    return products.filter((p) => {
      const matchTerm =
        !term ||
        p.product_code.toLowerCase().includes(term) ||
        p.product_name.toLowerCase().includes(term)
      const matchCategory = !categoryFilter || (p.product_category || '') === categoryFilter
      return matchTerm && matchCategory
    })
  }, [products, search, categoryFilter])

  return (
    <div className="space-y-6 mt-4">
      <div className="bg-white p-6 rounded-lg shadow">
        <div className="flex flex-wrap gap-4 mb-4">
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
          <div className="w-full sm:w-auto sm:min-w-[180px]">
            <label htmlFor="warehouse-category" className="sr-only">หมวดหมู่</label>
            <select
              id="warehouse-category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white text-base"
            >
              <option value="">ทั้งหมด</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
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
                  <th className="p-3 text-left font-semibold">หมวดหมู่</th>
                  <th className="p-3 text-left font-semibold">ชื่อสินค้า</th>
                  <th className="p-3 text-center font-semibold">จุดสั่งซื้อ</th>
                  <th className="p-3 text-center font-semibold">จำนวนคงเหลือ</th>
                  <th className="p-3 text-center font-semibold rounded-tr-xl">Safety stock</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((product, idx) => {
                  const balance = balances[product.id]
                  const onHand = Number(balance?.on_hand || 0)
                  const safetyStock = balance?.safety_stock != null ? Number(balance.safety_stock) : null
                  const orderPoint = toNumber(product.order_point)
                  const isLow =
                    (orderPoint !== null && onHand < orderPoint) ||
                    (safetyStock !== null && onHand < safetyStock)
                  return (
                    <tr key={product.id} className={`border-t border-surface-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                      <td className="p-3">
                        <ProductImage code={product.product_code} name={product.product_name} />
                      </td>
                      <td className="p-3 font-medium">{product.product_code}</td>
                      <td className="p-3">{product.product_category || '-'}</td>
                      <td className="p-3">{product.product_name}</td>
                      <td className="p-3 text-center">{product.order_point || '-'}</td>
                      <td className={`p-3 text-center ${isLow ? 'bg-orange-50 text-orange-700 font-semibold' : ''}`}>
                        {onHand.toLocaleString()}
                      </td>
                      <td className="p-3 text-center">{safetyStock !== null ? safetyStock.toLocaleString() : '-'}</td>
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
