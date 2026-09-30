import { useEffect, useMemo, useState } from 'react'
import { fetchOutstandingProductionItems, type OutstandingProductionItem } from '../../lib/productionApi'
import ProductImageHover from '../ui/ProductImageHover'

interface PickerProduct {
  id: string
  product_code: string
  product_name: string
  on_hand: number
  min_stock: number | null
  max_stock: number | null
}

const isWarning = (p: PickerProduct) => p.min_stock != null && p.on_hand < p.min_stock
const formatQty = (qty: number) => qty.toLocaleString('en-US', { maximumFractionDigits: 2 })
const statusLabels: Record<string, string> = { pending: 'รออนุมัติ', approved: 'รอแปรรูป', processing: 'กำลังทำ' }

export default function PPProductPicker<T extends PickerProduct>({ products, loading, error, onRetry, recipeProductIds, selectedIds, maxCreatableQty, onAdd, editingOrderId }: {
  products: T[]
  loading: boolean
  error: boolean
  onRetry: () => void
  recipeProductIds: Set<string>
  selectedIds: Set<string>
  maxCreatableQty: (product: T) => number
  onAdd: (id: string) => Promise<void>
  editingOrderId: string | null
}) {
  const [warningOnly, setWarningOnly] = useState(true)
  const [search, setSearch] = useState('')
  const [addingIds, setAddingIds] = useState<Set<string>>(new Set())
  const [addError, setAddError] = useState('')
  const [outstanding, setOutstanding] = useState<OutstandingProductionItem[]>([])
  const [orderState, setOrderState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    setOrderState('loading')
    fetchOutstandingProductionItems().then((items) => {
      if (!cancelled) { setOutstanding(items); setOrderState('ready') }
    }).catch(() => { if (!cancelled) setOrderState('error') })
    return () => { cancelled = true }
  }, [retry])

  const outstandingMap = useMemo(() => {
    const map = new Map<string, OutstandingProductionItem[]>()
    outstanding.filter((item) => item.order.id !== editingOrderId).forEach((item) => {
      map.set(item.product_id, [...(map.get(item.product_id) ?? []), item])
    })
    return map
  }, [outstanding, editingOrderId])

  const warningCount = products.filter(isWarning).length
  const visibleProducts = useMemo(() => {
    const query = search.trim().toLowerCase()
    return products.filter((p) => (!warningOnly || isWarning(p)) &&
      (!query || p.product_code.toLowerCase().includes(query) || p.product_name.toLowerCase().includes(query)))
      .sort((a, b) => {
        const emptyFirst = Number(b.on_hand <= 0) - Number(a.on_hand <= 0)
        const warningFirst = Number(isWarning(b)) - Number(isWarning(a))
        const ratio = (p: T) => p.min_stock != null && p.min_stock > 0 ? p.on_hand / p.min_stock : Infinity
        return emptyFirst || warningFirst || (ratio(a) - ratio(b)) || a.product_code.localeCompare(b.product_code)
      })
  }, [products, search, warningOnly])

  const addProduct = async (id: string) => {
    setAddingIds((prev) => new Set(prev).add(id))
    setAddError('')
    try { await onAdd(id) }
    catch { setAddError('เพิ่มสินค้าไม่สำเร็จ กรุณาลองอีกครั้ง') }
    finally { setAddingIds((prev) => { const next = new Set(prev); next.delete(id); return next }) }
  }

  return (
    <section className="border border-gray-200 rounded-xl overflow-hidden" aria-label="เลือกสินค้า PP">
      <div className="p-4 space-y-3 bg-gray-50">
        <h3 className="text-lg font-bold text-gray-800">เลือกสินค้า PP เข้าใบแปรรูป</h3>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={warningOnly} onClick={() => setWarningOnly(true)} className={`px-4 py-2 rounded-lg border font-semibold ${warningOnly ? 'bg-amber-100 border-amber-400 text-amber-800' : 'bg-white border-gray-200 text-gray-600'}`}>
            <i className="fas fa-exclamation-triangle mr-2" aria-hidden="true" />ถึงจุดเตือนผลิต ({warningCount})
          </button>
          <button type="button" aria-pressed={!warningOnly} onClick={() => setWarningOnly(false)} className={`px-4 py-2 rounded-lg border font-semibold ${!warningOnly ? 'bg-indigo-100 border-indigo-400 text-indigo-700' : 'bg-white border-gray-200 text-gray-600'}`}>ทั้งหมด ({products.length})</button>
        </div>
        <input aria-label="ค้นหาสินค้า PP" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาด้วยรหัสหรือชื่อสินค้า..." className="w-full px-4 py-2.5 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none" />
        {orderState === 'error' && <p role="alert" className="text-sm text-amber-700">โหลดใบผลิตค้างไม่สำเร็จ <button type="button" className="underline font-semibold" onClick={() => setRetry((v) => v + 1)}>ลองใหม่</button></p>}
        {addError && <p role="alert" className="text-sm text-red-600">{addError}</p>}
      </div>
      {loading ? <p role="status" className="p-8 text-center text-gray-500">กำลังโหลดสินค้า...</p> : error ? (
        <p role="alert" className="p-8 text-center text-red-600">โหลดสินค้าไม่สำเร็จ <button type="button" onClick={onRetry} className="underline">ลองใหม่</button></p>
      ) : visibleProducts.length === 0 ? (
        <div className="p-8 text-center text-gray-500">
          {search ? 'ไม่พบสินค้าที่ตรงกับคำค้นในรายการนี้' : warningOnly ? 'ไม่มีสินค้าถึงจุดเตือนผลิต' : 'ยังไม่มีสินค้า PP'}
          {warningOnly && <button type="button" className="block mx-auto mt-2 text-blue-600 font-semibold" onClick={() => setWarningOnly(false)}>ดูสินค้าทั้งหมด</button>}
        </div>
      ) : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-indigo-600 text-white">
              <tr><th className="px-4 py-3 text-left">สินค้า</th><th className="px-4 py-3 text-right whitespace-nowrap">คงเหลือ</th><th className="px-4 py-3 text-right whitespace-nowrap">จุดเตือนผลิต</th><th className="px-4 py-3 text-right whitespace-nowrap">ผลิตสูงสุด</th><th className="px-4 py-3 text-right whitespace-nowrap">แปรรูปได้</th><th className="px-4 py-3 text-left min-w-44">ใบผลิตค้าง</th><th className="px-4 py-3"><span className="sr-only">เพิ่มสินค้า</span></th></tr>
            </thead>
            <tbody>
              {visibleProducts.map((p) => {
                const selected = selectedIds.has(p.id)
                const adding = addingIds.has(p.id)
                const maxQty = maxCreatableQty(p)
                const unavailable = !recipeProductIds.has(p.id) || maxQty <= 0
                const pending = outstandingMap.get(p.id) ?? []
                return (
                  <tr key={p.id} className={`border-b border-gray-100 ${isWarning(p) ? 'bg-amber-50' : 'bg-white'}`}>
                    <td className="px-4 py-3"><div className="flex items-center gap-3 min-w-60"><ProductImageHover productCode={p.product_code} productName={p.product_name} size="sm" /><div><div className="font-medium">{p.product_name}</div><div className="font-mono text-xs text-gray-500 mt-1">{p.product_code}</div>{p.on_hand <= 0 ? <span className="text-xs text-red-700 font-semibold">หมด</span> : isWarning(p) ? <span className="text-xs text-amber-700 font-semibold">ถึงจุดเตือนผลิต</span> : null}</div></div></td>
                    <td className={`px-4 py-3 text-right font-semibold ${p.on_hand <= 0 ? 'text-red-700' : ''}`}>{formatQty(p.on_hand)}</td>
                    <td className="px-4 py-3 text-right">{p.min_stock == null ? '—' : formatQty(p.min_stock)}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">{p.max_stock == null ? 'ไม่กำหนด' : formatQty(p.max_stock)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-indigo-600">{formatQty(maxQty)}</td>
                    <td className="px-4 py-3">{orderState !== 'ready' ? <span className="text-gray-500">{orderState === 'loading' ? 'กำลังโหลด...' : 'ตรวจสอบไม่ได้'}</span> : pending.length === 0 ? <span className="text-gray-400">ไม่มี</span> : <details><summary className="cursor-pointer text-blue-700 font-semibold">รอผลิต {formatQty(pending.reduce((total, item) => total + Number(item.qty), 0))} ({pending.length} ใบ)</summary><ul className="mt-2 space-y-1 text-xs text-gray-600">{pending.map((item, index) => <li key={`${item.order.id}-${index}`}><span className="font-mono">{item.order.doc_no}</span> · {statusLabels[item.order.status]} · {formatQty(Number(item.qty))}</li>)}</ul></details>}</td>
                    <td className="px-4 py-3 text-center"><button type="button" aria-label={`${selected ? 'เพิ่มแล้ว' : 'เพิ่ม'} ${p.product_name}`} disabled={selected || adding || unavailable} onClick={() => void addProduct(p.id)} className={`px-3 py-2 rounded-lg font-semibold whitespace-nowrap disabled:cursor-default ${selected ? 'bg-green-100 text-green-700' : unavailable ? 'bg-gray-100 text-gray-400' : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50'}`}>{selected ? '✓ เพิ่มแล้ว' : adding ? 'กำลังเพิ่ม...' : '+ เพิ่ม'}</button>{!selected && !recipeProductIds.has(p.id) && <p className="mt-1 text-xs text-gray-500 max-w-40">ยังไม่มีสูตรแปรรูป</p>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
