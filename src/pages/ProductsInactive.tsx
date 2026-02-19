import { useState, useEffect, useRef, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { getPublicUrl } from '../lib/qcApi'
import { ProductType } from '../types'

const BUCKET_PRODUCT_IMAGES = 'product-images'
const SEARCH_DEBOUNCE_MS = 400
const PAGE_SIZE = 50

function getProductImageUrl(productCode: string | null | undefined, ext: string = '.jpg'): string {
  return getPublicUrl(BUCKET_PRODUCT_IMAGES, productCode, ext)
}

const DAYS_OPTIONS = [
  { value: 7, label: '7 วัน' },
  { value: 14, label: '14 วัน' },
  { value: 30, label: '30 วัน' },
  { value: 60, label: '60 วัน' },
  { value: 90, label: '90 วัน' },
]

const PRODUCT_TYPE_OPTIONS: { value: ProductType; label: string }[] = [
  { value: 'FG', label: 'FG - สินค้าสำเร็จรูป' },
  { value: 'RM', label: 'RM - วัตถุดิบ' },
]

interface InactiveProduct {
  id: string
  product_code: string
  product_name: string
  product_type: string
  product_category: string | null
  seller_name: string | null
  storage_location: string | null
  order_point: string | null
  rubber_code: string | null
  last_sold_at: string | null
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function daysFromDate(dateStr: string): number {
  const from = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.max(1, Math.ceil((now.getTime() - from.getTime()) / 86_400_000))
}

export default function ProductsInactive() {
  const [products, setProducts] = useState<InactiveProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedDays, setSelectedDays] = useState<number | null>(30)
  const [fromDate, setFromDate] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [productTypeFilter, setProductTypeFilter] = useState<'' | ProductType>('')
  const [categories, setCategories] = useState<string[]>([])
  const [page, setPage] = useState(1)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setAppliedSearch(searchInput.trim())
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [searchInput])

  useEffect(() => {
    setPage(1)
  }, [categoryFilter, productTypeFilter, appliedSearch])

  useEffect(() => {
    loadProducts()
  }, [selectedDays, fromDate])

  useEffect(() => {
    loadCategories()
  }, [])

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
      console.error('Error loading categories:', e)
    }
  }

  async function loadProducts() {
    setLoading(true)
    try {
      const params: Record<string, unknown> = {}
      if (fromDate) {
        params.p_from_date = fromDate
      } else {
        params.p_days = selectedDays ?? 30
      }
      const { data, error } = await supabase.rpc('get_inactive_products', params)
      if (error) throw error
      setProducts((data as InactiveProduct[]) || [])
    } catch (error: any) {
      console.error('Error loading inactive products:', error)
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() => {
    let list = products
    if (appliedSearch) {
      const s = appliedSearch.toLowerCase()
      list = list.filter(
        (p) =>
          p.product_code.toLowerCase().includes(s) ||
          p.product_name.toLowerCase().includes(s)
      )
    }
    if (productTypeFilter) {
      list = list.filter((p) => p.product_type === productTypeFilter)
    }
    if (categoryFilter) {
      list = list.filter((p) => p.product_category === categoryFilter)
    }
    return list
  }, [products, appliedSearch, productTypeFilter, categoryFilter])

  const totalCount = filtered.length
  const totalPages = Math.ceil(totalCount / PAGE_SIZE)
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  function formatDate(dateStr: string | null) {
    if (!dateStr) return 'ไม่เคยขาย'
    const d = new Date(dateStr)
    return d.toLocaleDateString('th-TH', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  function downloadExcel() {
    const headers = [
      'รหัสสินค้า',
      'ชื่อสินค้า',
      'ประเภท',
      'หมวดหมู่',
      'ชื่อผู้ขาย',
      'จุดจัดเก็บ',
      'รหัสหน้ายาง',
      'จุดสั่งซื้อ',
      'ขายครั้งสุดท้าย',
    ]
    const rows = filtered.map((p) => [
      p.product_code,
      p.product_name,
      p.product_type,
      p.product_category || '',
      p.seller_name || '',
      p.storage_location || '',
      p.rubber_code || '',
      p.order_point || '',
      p.last_sold_at ? formatDate(p.last_sold_at) : 'ไม่เคยขาย',
    ])
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
    XLSX.utils.book_append_sheet(wb, ws, 'สินค้าไม่เคลื่อนไหว')
    const suffix = fromDate ? `ตั้งแต่${fromDate}` : `${selectedDays ?? 30}วัน`
    XLSX.writeFile(wb, `สินค้าไม่เคลื่อนไหว_${suffix}.xlsx`)
  }

  return (
    <div className="space-y-6 mt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-600">ช่วงเวลา:</span>
            <div className="flex gap-1">
              {DAYS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => { setSelectedDays(opt.value); setFromDate(''); setPage(1) }}
                  className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                    !fromDate && selectedDays === opt.value
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-600">หรือเลือกวันที่:</span>
            <input
              type="date"
              value={fromDate}
              max={toDateStr(new Date())}
              onChange={(e) => {
                const val = e.target.value
                setFromDate(val)
                if (val) setSelectedDays(null)
                setPage(1)
              }}
              className={`px-3 py-1.5 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
                fromDate ? 'border-blue-500 bg-blue-50 font-semibold text-blue-700' : 'border-gray-300 bg-white text-gray-700'
              }`}
            />
            {fromDate && (
              <button
                type="button"
                onClick={() => { setFromDate(''); setSelectedDays(30); setPage(1) }}
                className="px-2 py-1 text-xs text-gray-500 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                title="ล้างวันที่"
              >
                ล้าง
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={downloadExcel}
          disabled={filtered.length === 0}
          className="px-3 py-2 rounded-xl bg-green-600 text-white hover:bg-green-700 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          ดาวน์โหลด Excel
        </button>
      </div>

      <div className="bg-surface-50 p-6 rounded-2xl shadow-soft border border-surface-200">
        <div className="flex flex-wrap gap-4 mb-4">
          <div className="flex-1 min-w-[200px]">
            <label htmlFor="inactive-search" className="sr-only">ค้นหาสินค้า</label>
            <input
              id="inactive-search"
              type="text"
              autoComplete="off"
              placeholder="ค้นหารหัสสินค้าหรือชื่อสินค้า..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-surface-50 text-base"
            />
          </div>
          <div className="w-full sm:w-auto sm:min-w-[150px]">
            <label htmlFor="inactive-type" className="sr-only">ประเภทสินค้า</label>
            <select
              id="inactive-type"
              value={productTypeFilter}
              onChange={(e) => setProductTypeFilter(e.target.value as '' | ProductType)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-surface-50 text-base"
            >
              <option value="">ทุกประเภท</option>
              {PRODUCT_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="w-full sm:w-auto sm:min-w-[180px]">
            <label htmlFor="inactive-category" className="sr-only">หมวดหมู่</label>
            <select
              id="inactive-category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-surface-50 text-base"
            >
              <option value="">ทุกหมวดหมู่</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center justify-between mb-3">
          <p className="text-sm text-gray-500">
            พบ <span className="font-bold text-gray-800">{totalCount.toLocaleString()}</span> รายการ
            {appliedSearch || categoryFilter || productTypeFilter ? ' (ตามตัวกรอง)' : ''}
            {' — '}สินค้าที่ไม่มีคำสั่งซื้อ
            {fromDate
              ? ` ตั้งแต่ ${new Date(fromDate).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' })} ถึงปัจจุบัน (${daysFromDate(fromDate)} วัน)`
              : ` ใน ${selectedDays ?? 30} วันที่ผ่านมา`}
          </p>
        </div>

        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          </div>
        ) : paged.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            ไม่พบสินค้าที่ไม่เคลื่อนไหว
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="px-2 py-2 text-left font-semibold rounded-tl-xl">รูป</th>
                  <th className="px-2 py-2 text-left font-semibold">รหัสสินค้า</th>
                  <th className="px-2 py-2 text-left font-semibold">ชื่อสินค้า</th>
                  <th className="px-2 py-2 text-center font-semibold">ประเภท</th>
                  <th className="px-2 py-2 text-left font-semibold">ชื่อผู้ขาย</th>
                  <th className="px-2 py-2 text-left font-semibold">จุดจัดเก็บ</th>
                  <th className="px-2 py-2 text-left font-semibold">รหัสหน้ายาง</th>
                  <th className="px-2 py-2 text-left font-semibold">หมวดหมู่</th>
                  <th className="px-2 py-2 text-center font-semibold">จุดสั่งซื้อ</th>
                  <th className="px-2 py-2 text-center font-semibold rounded-tr-xl">ขายครั้งสุดท้าย</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((product, idx) => (
                  <tr
                    key={product.id}
                    className={`border-t border-surface-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}
                  >
                    <td className="px-2 py-1.5">
                      <ProductImage code={product.product_code} name={product.product_name} />
                    </td>
                    <td className="px-2 py-1.5 font-semibold text-surface-900">{product.product_code}</td>
                    <td className="px-2 py-1.5 text-surface-800">{product.product_name}</td>
                    <td className="px-2 py-1.5 text-center">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                          product.product_type === 'RM'
                            ? 'bg-orange-100 text-orange-700'
                            : 'bg-green-100 text-green-700'
                        }`}
                      >
                        {product.product_type}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-surface-700">{product.seller_name || '-'}</td>
                    <td className="px-2 py-1.5 text-surface-700">{product.storage_location || '-'}</td>
                    <td className="px-2 py-1.5 text-surface-700">{product.rubber_code || '-'}</td>
                    <td className="px-2 py-1.5 text-surface-700">{product.product_category || '-'}</td>
                    <td className="px-2 py-1.5 text-center text-surface-700">{product.order_point || '-'}</td>
                    <td className="px-2 py-1.5 text-center">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          product.last_sold_at
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-red-100 text-red-600'
                        }`}
                      >
                        {formatDate(product.last_sold_at)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t text-sm text-gray-600">
            <span>
              แสดง {Math.min((page - 1) * PAGE_SIZE + 1, totalCount)}–{Math.min(page * PAGE_SIZE, totalCount)} จาก {totalCount} รายการ
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage(1)}
                disabled={page <= 1}
                className="px-2.5 py-1 border rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                «
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-2.5 py-1 border rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ‹ ก่อนหน้า
              </button>
              <span className="px-3 py-1 font-medium">
                หน้า {page} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-2.5 py-1 border rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ถัดไป ›
              </button>
              <button
                type="button"
                onClick={() => setPage(totalPages)}
                disabled={page >= totalPages}
                className="px-2.5 py-1 border rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                »
              </button>
            </div>
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
      <div className="w-20 h-20 bg-surface-200 rounded-xl flex items-center justify-center text-surface-400 text-xs">
        ไม่มีรูป
      </div>
    )
  }
  return (
    <a
      href={displayUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-20 h-20 rounded-xl overflow-hidden hover:ring-2 hover:ring-primary-200 focus:outline-none focus:ring-2 focus:ring-primary-200"
      title="คลิกเพื่อเปิดรูปในแท็บใหม่"
    >
      <img
        src={displayUrl}
        alt={name}
        className="w-20 h-20 object-cover"
        onError={() => setFailed(true)}
      />
    </a>
  )
}
