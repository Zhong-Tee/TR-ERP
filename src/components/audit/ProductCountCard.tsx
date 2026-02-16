import { useState } from 'react'
import { getPublicUrl } from '../../lib/qcApi'
import type { InventoryAuditItem } from '../../types'

interface ProductCountCardProps {
  item: InventoryAuditItem
  onSave: (data: {
    countedQty: number
    locationMatch: boolean
    actualLocation?: string
    countedSafetyStock?: number
  }) => Promise<void>
  onCancel: () => void
  saving: boolean
}

export default function ProductCountCard({ item, onSave, onCancel, saving }: ProductCountCardProps) {
  const [countedQty, setCountedQty] = useState<string>(
    item.is_counted ? String(item.counted_qty ?? '') : ''
  )
  const [locationMatch, setLocationMatch] = useState<boolean | null>(
    item.location_match ?? null
  )
  const [actualLocation, setActualLocation] = useState(item.actual_location || '')
  const [countedSafetyStock, setCountedSafetyStock] = useState<string>(
    item.counted_safety_stock != null ? String(item.counted_safety_stock) : ''
  )

  const productCode = item.pr_products?.product_code || ''
  const productName = item.pr_products?.product_name || ''
  const imageUrl = getPublicUrl('product-images', productCode, '.jpg')
  const systemLocation = item.system_location || item.storage_location || '-'

  function canSave() {
    if (countedQty === '' || isNaN(Number(countedQty))) return false
    if (locationMatch === null) return false
    if (locationMatch === false && !actualLocation.trim()) return false
    return true
  }

  async function handleSave() {
    if (!canSave()) return
    await onSave({
      countedQty: Number(countedQty),
      locationMatch: locationMatch!,
      actualLocation: locationMatch === false ? actualLocation.trim() : undefined,
      countedSafetyStock: countedSafetyStock !== '' ? Number(countedSafetyStock) : undefined,
    })
  }

  return (
    <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
      {/* Product Image */}
      <div className="bg-gray-50 flex items-center justify-center p-4" style={{ minHeight: '200px' }}>
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={productCode}
            className="max-h-48 max-w-full object-contain rounded-lg"
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <div className="text-gray-300 text-6xl">&#128247;</div>
        )}
      </div>

      <div className="p-5 space-y-4">
        {/* Product Info */}
        <div>
          <div className="text-lg font-bold text-gray-900">{productCode}</div>
          <div className="text-sm text-gray-600 mt-0.5">{productName}</div>
          <div className="text-sm text-red-600 font-semibold mt-1">
            จุดเก็บ: {systemLocation}
          </div>
        </div>

        {/* Counted Qty - Blind Count */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">
            จำนวนที่นับได้ <span className="text-red-500">*</span>
          </label>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            value={countedQty}
            onChange={(e) => setCountedQty(e.target.value)}
            placeholder="กรอกจำนวน"
            className="w-full px-4 py-3.5 border-2 rounded-xl text-xl font-bold text-center focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
            autoFocus
          />
        </div>

        {/* Location Check */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            จุดจัดเก็บตรงหรือไม่? <span className="text-red-500">*</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => { setLocationMatch(true); setActualLocation('') }}
              className={`py-3 rounded-xl font-semibold text-sm border-2 transition-all ${
                locationMatch === true
                  ? 'border-green-500 bg-green-50 text-green-700'
                  : 'border-gray-200 text-gray-600 hover:border-gray-300'
              }`}
            >
              ตรง
            </button>
            <button
              type="button"
              onClick={() => setLocationMatch(false)}
              className={`py-3 rounded-xl font-semibold text-sm border-2 transition-all ${
                locationMatch === false
                  ? 'border-red-500 bg-red-50 text-red-700'
                  : 'border-gray-200 text-gray-600 hover:border-gray-300'
              }`}
            >
              ไม่ตรง
            </button>
          </div>
          {locationMatch === false && (
            <input
              type="text"
              value={actualLocation}
              onChange={(e) => setActualLocation(e.target.value)}
              placeholder="กรอกจุดเก็บจริงที่พบ"
              className="w-full px-4 py-3 border-2 rounded-xl text-sm mt-2 focus:border-red-500 focus:ring-2 focus:ring-red-200"
            />
          )}
        </div>

        {/* Safety Stock Check */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">
            Safety Stock ที่นับได้ <span className="text-gray-400 font-normal">(ถ้ามี)</span>
          </label>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            value={countedSafetyStock}
            onChange={(e) => setCountedSafetyStock(e.target.value)}
            placeholder="กรอกจำนวน Safety Stock"
            className="w-full px-4 py-3 border-2 rounded-xl text-center font-medium focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-3.5 border-2 rounded-xl font-semibold text-gray-600 hover:bg-gray-50 active:scale-95 transition-all"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !canSave()}
            className="flex-1 py-3.5 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 disabled:opacity-50 active:scale-95 transition-all"
          >
            {saving ? 'กำลังบันทึก...' : 'บันทึก'}
          </button>
        </div>
      </div>
    </div>
  )
}
