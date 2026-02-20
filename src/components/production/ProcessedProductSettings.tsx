import { useEffect, useState, useCallback } from 'react'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  fetchPPProducts,
  fetchFgRmProducts,
  fetchRecipe,
  saveRecipe,
} from '../../lib/productionApi'
import type { Product } from '../../types'
import ProductImageHover from '../ui/ProductImageHover'

interface IncludeRow {
  key: string
  product_id: string
  product_code: string
  product_name: string
  qty: number
  landed_cost: number
}

interface RemoveRow {
  key: string
  product_id: string
  product_code: string
  product_name: string
  qty: number
  unit_cost: number
}

interface PPProduct extends Product {
  on_hand: number
}

export default function ProcessedProductSettings() {
  const { user } = useAuthContext()
  const [ppProducts, setPpProducts] = useState<PPProduct[]>([])
  const [fgRmProducts, setFgRmProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState<PPProduct | null>(null)

  // Recipe editing
  const [includes, setIncludes] = useState<IncludeRow[]>([])
  const [removes, setRemoves] = useState<RemoveRow[]>([])
  const [saving, setSaving] = useState(false)
  const [searchPP, setSearchPP] = useState('')

  // Notification
  const [notify, setNotify] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [pp, fgrm] = await Promise.all([fetchPPProducts(), fetchFgRmProducts()])
      setPpProducts(pp as PPProduct[])
      setFgRmProducts(fgrm)
    } catch (err) {
      console.error('loadData error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const filteredPP = ppProducts.filter(
    (p) =>
      p.product_code.toLowerCase().includes(searchPP.toLowerCase()) ||
      p.product_name.toLowerCase().includes(searchPP.toLowerCase())
  )

  // Load recipe when product selected
  const selectProduct = async (product: PPProduct) => {
    setSelectedProduct(product)
    setIncludes([])
    setRemoves([])
    try {
      const data = await fetchRecipe(product.id)
      if (data) {
        setIncludes(
          data.includes.map((inc) => ({
            key: crypto.randomUUID(),
            product_id: inc.product_id,
            product_code: inc.product?.product_code || '',
            product_name: inc.product?.product_name || '',
            qty: inc.qty,
            landed_cost: inc.product?.landed_cost ?? 0,
          }))
        )
        setRemoves(
          data.removes.map((rem) => ({
            key: crypto.randomUUID(),
            product_id: rem.product_id,
            product_code: rem.product?.product_code || '',
            product_name: rem.product?.product_name || '',
            qty: rem.qty,
            unit_cost: rem.unit_cost,
          }))
        )
      }
    } catch (err) {
      console.error('fetchRecipe error:', err)
    }
  }

  // Include card helpers
  const addIncludeItem = (productId: string) => {
    const product = fgRmProducts.find((p) => p.id === productId)
    if (!product) return
    if (includes.some((r) => r.product_id === productId)) return
    setIncludes((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        product_id: product.id,
        product_code: product.product_code,
        product_name: product.product_name,
        qty: 1,
        landed_cost: product.landed_cost ?? 0,
      },
    ])
  }

  const updateIncludeQty = (key: string, qty: number) => {
    setIncludes((prev) => prev.map((r) => (r.key === key ? { ...r, qty } : r)))
  }

  const removeIncludeItem = (key: string) => {
    setIncludes((prev) => prev.filter((r) => r.key !== key))
  }

  // Remove card helpers
  const addRemoveItem = (productId: string) => {
    const product = fgRmProducts.find((p) => p.id === productId)
    if (!product) return
    if (removes.some((r) => r.product_id === productId)) return
    setRemoves((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        product_id: product.id,
        product_code: product.product_code,
        product_name: product.product_name,
        qty: 1,
        unit_cost: 0,
      },
    ])
  }

  const updateRemove = (key: string, field: 'qty' | 'unit_cost', value: number) => {
    setRemoves((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)))
  }

  const removeRemoveItem = (key: string) => {
    setRemoves((prev) => prev.filter((r) => r.key !== key))
  }

  // Cost calculation
  const totalIncludeCost = includes.reduce((sum, r) => sum + r.qty * r.landed_cost, 0)
  const totalRemoveCost = removes.reduce((sum, r) => sum + r.qty * r.unit_cost, 0)
  const ppCost = totalIncludeCost - totalRemoveCost

  // Save
  const handleSave = async () => {
    if (!selectedProduct || !user) return
    setSaving(true)
    try {
      await saveRecipe(
        selectedProduct.id,
        user.id,
        includes.map((r) => ({ product_id: r.product_id, qty: r.qty })),
        removes.map((r) => ({ product_id: r.product_id, qty: r.qty, unit_cost: r.unit_cost }))
      )
      setNotify({ type: 'success', message: 'บันทึกสูตรแปรรูปเรียบร้อย' })
      setTimeout(() => setNotify(null), 3000)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาด'
      setNotify({ type: 'error', message: msg })
      setTimeout(() => setNotify(null), 5000)
    } finally {
      setSaving(false)
    }
  }

  // ═══════════════════════════════════════════════════════════

  return (
    <div className="flex gap-6">
      {/* Left: PP product list */}
      <div className="w-96 shrink-0 bg-white rounded-lg shadow p-5 space-y-4 max-h-[calc(100vh-14rem)] overflow-y-auto">
        <h3 className="text-base font-bold text-gray-700">รายการสินค้า PP</h3>
        <input
          type="text"
          value={searchPP}
          onChange={(e) => setSearchPP(e.target.value)}
          placeholder="ค้นหา..."
          className="w-full px-4 py-2.5 border rounded-lg text-base focus:ring-2 focus:ring-blue-500 focus:outline-none"
        />
        {loading ? (
          <div className="text-center py-8 text-gray-400 text-base">กำลังโหลด...</div>
        ) : filteredPP.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-base">ไม่พบสินค้า PP</div>
        ) : (
          <div className="space-y-1.5">
            {filteredPP.map((p) => (
              <button
                key={p.id}
                onClick={() => selectProduct(p)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-base transition ${
                  selectedProduct?.id === p.id
                    ? 'bg-blue-50 border border-blue-300 text-blue-700'
                    : 'hover:bg-gray-50 border border-transparent'
                }`}
              >
                <ProductImageHover productCode={p.product_code} productName={p.product_name} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm truncate">{p.product_code}</div>
                  <div className="text-sm text-gray-600 truncate">{p.product_name}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Right: Recipe editor */}
      <div className="flex-1 space-y-5">
        {!selectedProduct ? (
          <div className="bg-white rounded-lg shadow p-12 text-center text-gray-400 text-base">
            <i className="fas fa-arrow-left mr-2 text-lg"></i>
            เลือกสินค้า PP จากรายการด้านซ้ายเพื่อตั้งค่าสูตรแปรรูป
          </div>
        ) : (
          <>
            {/* Product header */}
            <div className="bg-white rounded-lg shadow p-5 flex items-center gap-5">
              <ProductImageHover productCode={selectedProduct.product_code} productName={selectedProduct.product_name} size="md" />
              <div>
                <div className="text-lg font-bold text-gray-800">{selectedProduct.product_name}</div>
                <div className="text-base text-gray-500 font-mono">{selectedProduct.product_code}</div>
                <div className="text-sm text-gray-400 mt-1">ประเภท: PP (Processed Product)</div>
              </div>
            </div>

            {/* Notification */}
            {notify && (
              <div className={`px-5 py-3 rounded-lg text-base font-semibold ${
                notify.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
              }`}>
                <i className={`fas ${notify.type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'} mr-2 text-lg`}></i>
                {notify.message}
              </div>
            )}

            {/* Include Card */}
            <div className="bg-white rounded-lg shadow">
              <div className="px-5 py-4 bg-emerald-50 border-b border-emerald-200 rounded-t-lg">
                <h4 className="text-base font-bold text-emerald-700">
                  <i className="fas fa-plus-circle mr-2 text-lg"></i>
                  Include — ส่วนประกอบที่รวมเข้า (ตัดออกจากสต๊อค)
                </h4>
                <p className="text-sm text-emerald-600 mt-1">สินค้า FG/RM ที่ใช้ในการแปรรูป — ต้นทุนดึงจาก Landed Cost ของสินค้า</p>
              </div>
              <div className="p-5 space-y-4">
                <ProductSelector
                  products={fgRmProducts}
                  excludeIds={includes.map((r) => r.product_id)}
                  onSelect={addIncludeItem}
                  placeholder="เพิ่มสินค้า FG/RM เข้า Include..."
                />

                {includes.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-base">
                      <thead>
                        <tr className="bg-emerald-600 text-white">
                          <th className="px-4 py-3 text-left rounded-tl-lg">รูป</th>
                          <th className="px-4 py-3 text-left">รหัส</th>
                          <th className="px-4 py-3 text-left">ชื่อสินค้า</th>
                          <th className="px-4 py-3 text-right">จำนวน</th>
                          <th className="px-4 py-3 text-right">ต้นทุน/หน่วย</th>
                          <th className="px-4 py-3 text-right">รวม</th>
                          <th className="px-4 py-3 text-center rounded-tr-lg">ลบ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {includes.map((r, i) => (
                          <tr key={r.key} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                            <td className="px-4 py-3">
                              <ProductImageHover productCode={r.product_code} productName={r.product_name} size="sm" />
                            </td>
                            <td className="px-4 py-3 font-mono text-sm">{r.product_code}</td>
                            <td className="px-4 py-3">{r.product_name}</td>
                            <td className="px-4 py-3 text-right">
                              <input
                                type="number"
                                min={1}
                                value={r.qty}
                                onChange={(e) => updateIncludeQty(r.key, Number(e.target.value) || 1)}
                                className="w-24 px-3 py-1.5 border rounded text-right text-base focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                              />
                            </td>
                            <td className="px-4 py-3 text-right text-gray-500">{r.landed_cost.toFixed(2)}</td>
                            <td className="px-4 py-3 text-right font-semibold">{(r.qty * r.landed_cost).toFixed(2)}</td>
                            <td className="px-4 py-3 text-center">
                              <button onClick={() => removeIncludeItem(r.key)} className="text-red-400 hover:text-red-600 text-lg">
                                <i className="fas fa-trash"></i>
                              </button>
                            </td>
                          </tr>
                        ))}
                        <tr className="bg-emerald-50 font-bold">
                          <td colSpan={5} className="px-4 py-3 text-right text-emerald-700">รวมต้นทุน Include</td>
                          <td className="px-4 py-3 text-right text-emerald-700">{totalIncludeCost.toFixed(2)}</td>
                          <td></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* Remove Card */}
            <div className="bg-white rounded-lg shadow">
              <div className="px-5 py-4 bg-orange-50 border-b border-orange-200 rounded-t-lg">
                <h4 className="text-base font-bold text-orange-700">
                  <i className="fas fa-minus-circle mr-2 text-lg"></i>
                  Remove — สินค้าที่แยกออก (รับเข้าสต๊อค)
                </h4>
                <p className="text-sm text-orange-600 mt-1">สินค้า FG/RM ที่แยกออกจากการแปรรูป — กรอกจำนวนและต้นทุนเอง → รับเข้าสต๊อคพร้อมสร้าง Lot</p>
              </div>
              <div className="p-5 space-y-4">
                <ProductSelector
                  products={fgRmProducts}
                  excludeIds={removes.map((r) => r.product_id)}
                  onSelect={addRemoveItem}
                  placeholder="เพิ่มสินค้า FG/RM เข้า Remove..."
                />

                {removes.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-base">
                      <thead>
                        <tr className="bg-orange-500 text-white">
                          <th className="px-4 py-3 text-left rounded-tl-lg">รูป</th>
                          <th className="px-4 py-3 text-left">รหัส</th>
                          <th className="px-4 py-3 text-left">ชื่อสินค้า</th>
                          <th className="px-4 py-3 text-right">จำนวน</th>
                          <th className="px-4 py-3 text-right">ต้นทุน/หน่วย</th>
                          <th className="px-4 py-3 text-right">รวม</th>
                          <th className="px-4 py-3 text-center rounded-tr-lg">ลบ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {removes.map((r, i) => (
                          <tr key={r.key} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                            <td className="px-4 py-3">
                              <ProductImageHover productCode={r.product_code} productName={r.product_name} size="sm" />
                            </td>
                            <td className="px-4 py-3 font-mono text-sm">{r.product_code}</td>
                            <td className="px-4 py-3">{r.product_name}</td>
                            <td className="px-4 py-3 text-right">
                              <input
                                type="number"
                                min={1}
                                value={r.qty}
                                onChange={(e) => updateRemove(r.key, 'qty', Number(e.target.value) || 1)}
                                className="w-24 px-3 py-1.5 border rounded text-right text-base focus:ring-2 focus:ring-orange-500 focus:outline-none"
                              />
                            </td>
                            <td className="px-4 py-3 text-right">
                              <input
                                type="number"
                                min={0}
                                step={0.01}
                                value={r.unit_cost}
                                onChange={(e) => updateRemove(r.key, 'unit_cost', Number(e.target.value) || 0)}
                                className="w-28 px-3 py-1.5 border rounded text-right text-base focus:ring-2 focus:ring-orange-500 focus:outline-none"
                              />
                            </td>
                            <td className="px-4 py-3 text-right font-semibold">{(r.qty * r.unit_cost).toFixed(2)}</td>
                            <td className="px-4 py-3 text-center">
                              <button onClick={() => removeRemoveItem(r.key)} className="text-red-400 hover:text-red-600 text-lg">
                                <i className="fas fa-trash"></i>
                              </button>
                            </td>
                          </tr>
                        ))}
                        <tr className="bg-orange-50 font-bold">
                          <td colSpan={5} className="px-4 py-3 text-right text-orange-700">รวมต้นทุน Remove</td>
                          <td className="px-4 py-3 text-right text-orange-700">{totalRemoveCost.toFixed(2)}</td>
                          <td></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* Cost Summary */}
            <div className="bg-white rounded-lg shadow p-6">
              <div className="flex items-center justify-between">
                <div className="space-y-2 text-base">
                  <div className="flex gap-8">
                    <span className="text-gray-500">ต้นทุน Include:</span>
                    <span className="font-semibold text-emerald-700">{totalIncludeCost.toFixed(2)} บาท</span>
                  </div>
                  <div className="flex gap-8">
                    <span className="text-gray-500">ต้นทุน Remove:</span>
                    <span className="font-semibold text-orange-600">-{totalRemoveCost.toFixed(2)} บาท</span>
                  </div>
                  <div className="flex gap-8 border-t pt-2">
                    <span className="text-gray-700 font-bold">ต้นทุน PP ต่อชิ้น:</span>
                    <span className={`font-bold text-xl ${ppCost >= 0 ? 'text-blue-700' : 'text-red-600'}`}>
                      {ppCost.toFixed(2)} บาท
                    </span>
                  </div>
                </div>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-7 py-3 bg-blue-600 text-white rounded-lg text-base font-semibold hover:bg-blue-700 transition disabled:opacity-50"
                >
                  {saving ? (
                    <><i className="fas fa-spinner fa-spin mr-2 text-lg"></i>กำลังบันทึก...</>
                  ) : (
                    <><i className="fas fa-save mr-2 text-lg"></i>บันทึกสูตร</>
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// Product Selector (search & add FG/RM)
// ═══════════════════════════════════════════════════════════

function ProductSelector({
  products,
  excludeIds,
  onSelect,
  placeholder,
}: {
  products: Product[]
  excludeIds: string[]
  onSelect: (id: string) => void
  placeholder: string
}) {
  const [search, setSearch] = useState('')
  const [isOpen, setIsOpen] = useState(false)

  const filtered = products
    .filter((p) => !excludeIds.includes(p.id))
    .filter(
      (p) =>
        p.product_code.toLowerCase().includes(search.toLowerCase()) ||
        p.product_name.toLowerCase().includes(search.toLowerCase())
    )
    .slice(0, 20)

  return (
    <div className="relative">
      <input
        type="text"
        value={search}
        onChange={(e) => { setSearch(e.target.value); setIsOpen(true) }}
        onFocus={() => setIsOpen(true)}
        placeholder={placeholder}
        className="w-full px-4 py-2.5 border rounded-lg text-base focus:ring-2 focus:ring-blue-500 focus:outline-none"
      />
      {isOpen && search && filtered.length > 0 && (
        <div className="absolute z-40 mt-1 w-full bg-white border rounded-lg shadow-lg max-h-72 overflow-y-auto">
          {filtered.map((p) => (
            <button
              key={p.id}
              onClick={() => { onSelect(p.id); setSearch(''); setIsOpen(false) }}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-blue-50 text-left text-base border-b last:border-b-0"
            >
              <ProductImageHover productCode={p.product_code} productName={p.product_name} size="sm" />
              <div className="min-w-0 flex-1">
                <span className="font-mono text-sm text-gray-500">{p.product_code}</span>
                <span className="ml-2">{p.product_name}</span>
                <span className="ml-2 text-sm text-gray-400">({p.product_type})</span>
              </div>
            </button>
          ))}
        </div>
      )}
      {isOpen && search && filtered.length === 0 && (
        <div className="absolute z-40 mt-1 w-full bg-white border rounded-lg shadow-lg p-4 text-base text-gray-400 text-center">
          ไม่พบสินค้า
        </div>
      )}
    </div>
  )
}
