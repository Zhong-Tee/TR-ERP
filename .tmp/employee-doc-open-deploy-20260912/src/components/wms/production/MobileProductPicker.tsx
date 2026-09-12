import { useEffect, useMemo, useState } from 'react'
import { getProductImageUrl } from '../wmsUtils'

export interface MobilePickerProduct {
  product_code: string
  product_name: string
  storage_location?: string | null
}

interface MobileProductPickerProps {
  products: MobilePickerProduct[]
  query: string
  onQueryChange: (value: string) => void
  onSelect: (product: MobilePickerProduct) => void
  onOpenScanner: () => void
  loading?: boolean
  selectedCodes?: string[]
}

export default function MobileProductPicker({
  products,
  query,
  onQueryChange,
  onSelect,
  onOpenScanner,
  loading = false,
  selectedCodes = [],
}: MobileProductPickerProps) {
  const [open, setOpen] = useState(false)

  const filteredProducts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('th-TH')
    if (!normalized) return products
    return products.filter((product) =>
      `${product.product_code} ${product.product_name}`.toLocaleLowerCase('th-TH').includes(normalized),
    )
  }, [products, query])

  useEffect(() => {
    if (query.trim()) setOpen(true)
  }, [query])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [open])

  const chooseProduct = (product: MobilePickerProduct) => {
    onSelect(product)
    onQueryChange('')
    setOpen(false)
  }

  const openScanner = () => {
    setOpen(false)
    onOpenScanner()
  }

  return (
    <>
      <div className="flex gap-2">
        <input
          type="search"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            onQueryChange(event.target.value)
            setOpen(true)
          }}
          placeholder="ค้นหารหัสหรือชื่อสินค้า..."
          className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400"
        />
        <button type="button" onClick={openScanner} className="px-3 py-2 bg-green-600 text-white rounded-lg text-sm" aria-label="สแกนบาร์โค้ด">
          <i className="fas fa-barcode" aria-hidden />
        </button>
      </div>

      <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-left text-sm text-gray-900">
        <span className="min-w-0 flex-1 truncate">-- เลือกสินค้าจากรายการ ({products.length}) --</span>
        <i className="fas fa-chevron-right shrink-0 text-xs text-gray-400" />
      </button>

      {open && (
        <div className="fixed inset-0 z-[80] flex min-h-0 flex-col bg-gray-50 text-gray-900">
          <div className="shrink-0 border-b border-gray-200 bg-white p-3 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <button type="button" onClick={() => setOpen(false)} className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 text-gray-700" aria-label="ปิดรายการสินค้า">
                <i className="fas fa-arrow-left" aria-hidden />
              </button>
              <div className="min-w-0 flex-1">
                <div className="font-bold">เลือกสินค้า</div>
                <div className="text-xs text-gray-500">พบ {filteredProducts.length} จาก {products.length} รายการ</div>
              </div>
              <button type="button" onClick={openScanner} className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-600 text-white" aria-label="สแกนบาร์โค้ด">
                <i className="fas fa-barcode" aria-hidden />
              </button>
            </div>
            <div className="relative">
              <i className="fas fa-search pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400" aria-hidden />
              <input
                autoFocus
                type="search"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="พิมพ์รหัสหรือชื่อสินค้า"
                className="w-full rounded-xl border border-gray-300 bg-white py-3 pl-10 pr-10 text-base outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
              {query && <button type="button" onClick={() => onQueryChange('')} className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100" aria-label="ล้างคำค้นหา">×</button>}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {loading ? (
              <div className="py-16 text-center text-sm text-gray-500">กำลังโหลดสินค้า...</div>
            ) : filteredProducts.length === 0 ? (
              <div className="py-16 text-center"><div className="text-3xl text-gray-300">⌕</div><div className="mt-2 text-sm text-gray-500">ไม่พบสินค้าที่ค้นหา</div></div>
            ) : (
              <div className="space-y-2">
                {filteredProducts.map((product) => {
                  const selected = selectedCodes.includes(product.product_code)
                  return <button key={product.product_code} type="button" onClick={() => chooseProduct(product)} className="flex w-full items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 text-left shadow-sm active:bg-blue-50">
                    <img src={getProductImageUrl(product.product_code)} alt="" className="h-12 w-12 shrink-0 rounded-lg bg-gray-100 object-cover" onError={(event) => { (event.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-bold text-gray-900">{product.product_code}</div>
                      <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-gray-500">{product.product_name}</div>
                      {product.storage_location && <div className="mt-1 text-[10px] text-gray-400">ตำแหน่ง: {product.storage_location}</div>}
                    </div>
                    {selected && <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-bold text-emerald-700">เลือกแล้ว</span>}
                  </button>
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
