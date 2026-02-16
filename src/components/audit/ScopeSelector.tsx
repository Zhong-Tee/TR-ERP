import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { getPublicUrl } from '../../lib/qcApi'
import { fetchDistinctCategories, fetchDistinctLocations } from '../../lib/auditApi'
import type { AuditType } from '../../types'

interface ProductOption {
  id: string
  product_code: string
  product_name: string
  product_category: string | null
  storage_location: string | null
}

interface ScopeSelectorProps {
  auditType: AuditType
  onTypeChange: (type: AuditType) => void
  selectedCategories: string[]
  onCategoriesChange: (categories: string[]) => void
  selectedLocations: string[]
  onLocationsChange: (locations: string[]) => void
  locationSearch: string
  onLocationSearchChange: (search: string) => void
  selectedProductIds: string[]
  onProductIdsChange: (ids: string[]) => void
}

const AUDIT_TYPES: { value: AuditType; label: string; desc: string }[] = [
  { value: 'full', label: 'ตรวจนับทั้งหมด', desc: 'สินค้า active ทุกรายการ' },
  { value: 'category', label: 'ตามหมวดหมู่', desc: 'เลือกหมวดหมู่สินค้า' },
  { value: 'location', label: 'ตามจุดจัดเก็บ', desc: 'เลือกจุดจัดเก็บ ค้นหาได้' },
  { value: 'custom', label: 'กำหนดเอง', desc: 'เลือกสินค้าทีละรายการ' },
]

export default function ScopeSelector({
  auditType,
  onTypeChange,
  selectedCategories,
  onCategoriesChange,
  selectedLocations,
  onLocationsChange,
  locationSearch,
  onLocationSearchChange,
  selectedProductIds,
  onProductIdsChange,
}: ScopeSelectorProps) {
  const [categories, setCategories] = useState<string[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  // Custom product picker state
  const [products, setProducts] = useState<ProductOption[]>([])
  const [productSearch, setProductSearch] = useState('')
  const [productsLoading, setProductsLoading] = useState(false)
  const [productsLoaded, setProductsLoaded] = useState(false)

  useEffect(() => {
    setLoading(true)
    Promise.all([fetchDistinctCategories(), fetchDistinctLocations()])
      .then(([cats, locs]) => {
        setCategories(cats)
        setLocations(locs)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (auditType === 'custom' && !productsLoaded) {
      setProductsLoading(true)
      supabase
        .from('pr_products')
        .select('id, product_code, product_name, product_category, storage_location')
        .eq('is_active', true)
        .order('product_code', { ascending: true })
        .then(({ data, error }) => {
          if (!error && data) setProducts(data as ProductOption[])
          setProductsLoaded(true)
        })
        .catch(console.error)
        .finally(() => setProductsLoading(false))
    }
  }, [auditType, productsLoaded])

  const filteredLocations = locationSearch
    ? locations.filter((loc) => loc.toLowerCase().includes(locationSearch.toLowerCase()))
    : locations

  const filteredProducts = productSearch
    ? products.filter(
        (p) =>
          p.product_code.toLowerCase().includes(productSearch.toLowerCase()) ||
          p.product_name.toLowerCase().includes(productSearch.toLowerCase())
      )
    : products

  function toggleCategory(cat: string) {
    onCategoriesChange(
      selectedCategories.includes(cat)
        ? selectedCategories.filter((c) => c !== cat)
        : [...selectedCategories, cat]
    )
  }

  function toggleLocation(loc: string) {
    onLocationsChange(
      selectedLocations.includes(loc)
        ? selectedLocations.filter((l) => l !== loc)
        : [...selectedLocations, loc]
    )
  }

  function toggleProduct(id: string) {
    onProductIdsChange(
      selectedProductIds.includes(id)
        ? selectedProductIds.filter((p) => p !== id)
        : [...selectedProductIds, id]
    )
  }

  function selectAllFiltered() {
    const ids = filteredProducts.map((p) => p.id)
    const merged = [...new Set([...selectedProductIds, ...ids])]
    onProductIdsChange(merged)
  }

  function deselectAllFiltered() {
    const idsToRemove = new Set(filteredProducts.map((p) => p.id))
    onProductIdsChange(selectedProductIds.filter((id) => !idsToRemove.has(id)))
  }

  return (
    <div className="space-y-4">
      <label className="block text-sm font-semibold text-gray-700">ประเภท Audit</label>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {AUDIT_TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => onTypeChange(t.value)}
            className={`p-3 rounded-xl border-2 text-left transition-all ${
              auditType === t.value
                ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <div className="font-semibold text-sm">{t.label}</div>
            <div className="text-xs text-gray-500 mt-1">{t.desc}</div>
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex justify-center py-4">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500" />
        </div>
      )}

      {auditType === 'category' && !loading && (
        <div className="space-y-2">
          <label className="block text-sm font-semibold text-gray-700">
            เลือกหมวดหมู่ ({selectedCategories.length} เลือกแล้ว)
          </label>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-60 overflow-y-auto border rounded-lg p-3">
            {categories.length === 0 ? (
              <div className="col-span-full text-center text-gray-400 py-4">ไม่พบหมวดหมู่</div>
            ) : (
              categories.map((cat) => (
                <label
                  key={cat}
                  className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer text-sm transition-colors ${
                    selectedCategories.includes(cat) ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedCategories.includes(cat)}
                    onChange={() => toggleCategory(cat)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  {cat}
                </label>
              ))
            )}
          </div>
        </div>
      )}

      {auditType === 'location' && !loading && (
        <div className="space-y-2">
          <label className="block text-sm font-semibold text-gray-700">
            เลือกจุดจัดเก็บ ({selectedLocations.length} เลือกแล้ว)
          </label>
          <input
            type="text"
            value={locationSearch}
            onChange={(e) => onLocationSearchChange(e.target.value)}
            placeholder="ค้นหาจุดจัดเก็บ..."
            className="w-full px-3 py-2 border rounded-lg text-sm"
          />
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-60 overflow-y-auto border rounded-lg p-3">
            {filteredLocations.length === 0 ? (
              <div className="col-span-full text-center text-gray-400 py-4">ไม่พบจุดจัดเก็บ</div>
            ) : (
              filteredLocations.map((loc) => (
                <label
                  key={loc}
                  className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer text-sm transition-colors ${
                    selectedLocations.includes(loc) ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedLocations.includes(loc)}
                    onChange={() => toggleLocation(loc)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  {loc}
                </label>
              ))
            )}
          </div>
        </div>
      )}

      {auditType === 'custom' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-semibold text-gray-700">
              เลือกสินค้า ({selectedProductIds.length} เลือกแล้ว)
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={selectAllFiltered}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium"
              >
                เลือกทั้งหมด{productSearch ? ' (ที่กรอง)' : ''}
              </button>
              <span className="text-gray-300">|</span>
              <button
                type="button"
                onClick={deselectAllFiltered}
                className="text-xs text-red-500 hover:text-red-700 font-medium"
              >
                ยกเลิกทั้งหมด{productSearch ? ' (ที่กรอง)' : ''}
              </button>
            </div>
          </div>
          <input
            type="text"
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
            placeholder="ค้นหาด้วยรหัสหรือชื่อสินค้า..."
            className="w-full px-3 py-2 border rounded-lg text-sm"
          />

          {productsLoading ? (
            <div className="flex justify-center py-6">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500" />
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto border rounded-lg divide-y">
              {filteredProducts.length === 0 ? (
                <div className="text-center text-gray-400 py-6">ไม่พบสินค้า</div>
              ) : (
                filteredProducts.map((p) => {
                  const isSelected = selectedProductIds.includes(p.id)
                  const imageUrl = getPublicUrl('product-images', p.product_code, '.jpg')
                  return (
                    <label
                      key={p.id}
                      className={`flex items-center gap-3 p-2.5 cursor-pointer transition-colors ${
                        isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleProduct(p.id)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0"
                      />
                      <div className="w-10 h-10 rounded-lg bg-gray-100 overflow-hidden flex-shrink-0 flex items-center justify-center">
                        {imageUrl ? (
                          <img
                            src={imageUrl}
                            alt={p.product_code}
                            className="w-full h-full object-cover"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                          />
                        ) : (
                          <span className="text-gray-300 text-sm">&#128247;</span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm text-gray-900">{p.product_code}</div>
                        <div className="text-xs text-gray-500 truncate">{p.product_name}</div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-xs text-gray-400">{p.product_category || '-'}</div>
                        <div className="text-xs text-gray-400">{p.storage_location || '-'}</div>
                      </div>
                    </label>
                  )
                })
              )}
            </div>
          )}
        </div>
      )}

      {auditType === 'full' && !loading && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="text-sm text-amber-800 font-medium">
            ตรวจนับสินค้า active ทั้งหมดในระบบ
          </div>
          <div className="text-xs text-amber-600 mt-1">
            ระบบจะดึงสินค้าทุกรายการที่ active อยู่มาสร้างรายการตรวจนับ
          </div>
        </div>
      )}
    </div>
  )
}
