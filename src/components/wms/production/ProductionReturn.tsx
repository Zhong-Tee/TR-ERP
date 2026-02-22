import { useState, useEffect } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import BarcodeScanner from './BarcodeScanner'
import { getProductImageUrl } from '../wmsUtils'
import { useWmsModal } from '../useWmsModal'
import type { ProductType } from '../../../types'

interface ReturnItem {
  product_code: string
  product_name: string
  storage_location?: string
  qty: number
  topic: string
}

export default function ProductionReturn() {
  const { user } = useAuthContext()
  const [activeTab, setActiveTab] = useState<'create' | 'list'>('create')
  const [searchTerm, setSearchTerm] = useState('')
  const [products, setProducts] = useState<any[]>([])
  const [allProducts, setAllProducts] = useState<any[]>([])
  const [selectedItems, setSelectedItems] = useState<ReturnItem[]>([])
  const [returnNo, setReturnNo] = useState('')
  const [notes, setNotes] = useState('')
  const [requisitionTopics, setRequisitionTopics] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingAllProducts, setLoadingAllProducts] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [selectedProductCode, setSelectedProductCode] = useState('')
  const [productTypeFilter, setProductTypeFilter] = useState<ProductType>('FG')
  const [submitting, setSubmitting] = useState(false)
  const [returnList, setReturnList] = useState<any[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()

  useEffect(() => {
    generateReturnNo()
    loadAllProducts()
    loadTopics()
  }, [])

  useEffect(() => {
    loadAllProducts()
    setProducts([])
    setSearchTerm('')
    setSelectedProductCode('')
  }, [productTypeFilter])

  useEffect(() => {
    if (activeTab === 'list') loadReturnList()
  }, [activeTab])

  const generateReturnNo = async () => {
    const date = new Date()
    const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
    const prefix = `RET-${dateStr}-`

    const { data } = await supabase
      .from('wms_return_requisitions')
      .select('return_no')
      .like('return_no', `${prefix}%`)

    let maxNum = 0
    if (data) {
      for (const row of data) {
        const suffix = row.return_no.replace(prefix, '')
        if (/^\d{3}$/.test(suffix)) {
          const num = parseInt(suffix, 10)
          if (num > maxNum) maxNum = num
        }
      }
    }
    setReturnNo(`${prefix}${String(maxNum + 1).padStart(3, '0')}`)
  }

  const loadTopics = async () => {
    try {
      const { data } = await supabase.from('wms_requisition_topics').select('*').order('topic_name')
      setRequisitionTopics(data || [])
    } catch {}
  }

  const loadAllProducts = async () => {
    setLoadingAllProducts(true)
    try {
      const { data, error } = await supabase
        .from('pr_products')
        .select('product_code, product_name, storage_location')
        .eq('is_active', true)
        .eq('product_type', productTypeFilter)
        .order('product_name')
      if (error) throw error
      setAllProducts(data || [])
    } catch (e: any) {
      showMessage({ message: `โหลดสินค้าไม่สำเร็จ: ${e.message}` })
    } finally {
      setLoadingAllProducts(false)
    }
  }

  const loadReturnList = async () => {
    setLoadingList(true)
    try {
      const { data, error } = await supabase
        .from('wms_return_requisitions')
        .select('*')
        .eq('created_by', user?.id || '')
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) throw error
      setReturnList(data || [])
    } catch (e: any) {
      console.error('Load return list error:', e)
    } finally {
      setLoadingList(false)
    }
  }

  const searchProducts = async () => {
    if (!searchTerm.trim()) { setProducts([]); return }
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('pr_products')
        .select('product_code, product_name, storage_location')
        .eq('is_active', true)
        .eq('product_type', productTypeFilter)
        .or(`product_code.ilike.%${searchTerm}%,product_name.ilike.%${searchTerm}%`)
        .limit(20)
      if (error) throw error
      setProducts(data || [])
    } catch (e: any) {
      showMessage({ message: `ค้นหาไม่สำเร็จ: ${e.message}` })
    } finally {
      setLoading(false)
    }
  }

  const handleBarcodeScan = (barcode: string) => {
    setShowScanner(false)
    setSearchTerm(barcode)
    setTimeout(() => searchProducts(), 100)
  }

  const addItem = (product: any) => {
    const existing = selectedItems.find((i) => i.product_code === product.product_code)
    if (existing) {
      setSelectedItems(selectedItems.map((i) => i.product_code === product.product_code ? { ...i, qty: i.qty + 1 } : i))
    } else {
      setSelectedItems([...selectedItems, { ...product, qty: 1, topic: '' }])
    }
  }

  const updateItemTopic = (code: string, topic: string) => {
    setSelectedItems(selectedItems.map((i) => i.product_code === code ? { ...i, topic } : i))
  }

  const removeItem = (code: string) => setSelectedItems(selectedItems.filter((i) => i.product_code !== code))

  const updateQty = (code: string, qty: number) => {
    if (qty < 1) { removeItem(code); return }
    setSelectedItems(selectedItems.map((i) => i.product_code === code ? { ...i, qty } : i))
  }

  const submitReturn = async () => {
    if (selectedItems.length === 0) { showMessage({ message: 'กรุณาเพิ่มรายการสินค้า' }); return }
    if (selectedItems.some((i) => !i.topic)) { showMessage({ message: 'กรุณาเลือกหัวข้อคืนให้ครบทุกรายการ' }); return }
    if (!notes.trim()) { showMessage({ message: 'กรุณากรอกหมายเหตุ' }); return }

    const ok = await showConfirm({
      title: 'ยืนยันการคืนของ',
      message: `ยืนยันสร้างใบคืน ${returnNo}?\nจำนวนรายการ: ${selectedItems.length}`,
    })
    if (!ok) return

    setSubmitting(true)
    try {
      const { error: retErr } = await supabase
        .from('wms_return_requisitions')
        .insert({
          return_no: returnNo,
          topic: null,
          status: 'pending',
          created_by: user?.id,
          note: notes.trim() || null,
        })
        .select()
        .single()
      if (retErr) throw retErr

      const { data: retData } = await supabase
        .from('wms_return_requisitions')
        .select('id')
        .eq('return_no', returnNo)
        .single()
      if (!retData) throw new Error('ไม่พบใบคืนที่สร้าง')

      const productCodes = selectedItems.map((i) => i.product_code)
      const { data: prods } = await supabase
        .from('pr_products')
        .select('id, product_code')
        .in('product_code', productCodes)
      const codeToId = (prods || []).reduce<Record<string, string>>((acc, p) => { acc[p.product_code] = p.id; return acc }, {})

      const items = selectedItems
        .filter((i) => codeToId[i.product_code])
        .map((i) => ({
          return_requisition_id: retData.id,
          product_id: codeToId[i.product_code],
          qty: i.qty,
          topic: i.topic || null,
        }))
      if (items.length > 0) {
        const { error: itemErr } = await supabase.from('wms_return_requisition_items').insert(items)
        if (itemErr) throw itemErr
      }

      showMessage({ message: `สร้างใบคืน ${returnNo} สำเร็จ` })
      setSelectedItems([])
      setNotes('')
      generateReturnNo()
    } catch (e: any) {
      showMessage({ message: `สร้างใบคืนไม่สำเร็จ: ${e.message}` })
    } finally {
      setSubmitting(false)
    }
  }

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      pending: 'bg-amber-500',
      approved: 'bg-green-500',
      rejected: 'bg-red-500',
    }
    const labels: Record<string, string> = {
      pending: 'รออนุมัติ',
      approved: 'อนุมัติแล้ว',
      rejected: 'ไม่อนุมัติ',
    }
    return (
      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold text-white ${map[status] || 'bg-gray-500'}`}>
        {labels[status] || status}
      </span>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tab switcher */}
      <div className="flex border-b border-slate-700 px-3 pt-2">
        <button
          type="button"
          onClick={() => setActiveTab('create')}
          className={`px-4 py-2 text-sm font-bold rounded-t-lg ${
            activeTab === 'create' ? 'bg-slate-800 text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'
          }`}
        >
          สร้างใบคืน
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('list')}
          className={`px-4 py-2 text-sm font-bold rounded-t-lg ${
            activeTab === 'list' ? 'bg-slate-800 text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'
          }`}
        >
          รายการใบคืน
        </button>
      </div>

      {activeTab === 'create' ? (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {/* Return No */}
          <div className="rounded-xl bg-slate-800 border border-slate-700 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">เลขที่ใบคืน</span>
              <span className="text-sm font-bold text-blue-400">{returnNo}</span>
            </div>
          </div>

          {/* Product type filter */}
          <div className="flex gap-2">
            {(['FG', 'RM', 'PP'] as ProductType[]).map((pt) => (
              <button
                key={pt}
                type="button"
                onClick={() => setProductTypeFilter(pt)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold ${
                  productTypeFilter === pt ? 'bg-blue-600 text-white' : 'bg-slate-700 text-gray-300'
                }`}
              >
                {pt === 'FG' ? 'สินค้าสำเร็จรูป' : pt === 'RM' ? 'วัตถุดิบ' : 'สินค้าแปรรูป'}
              </button>
            ))}
          </div>

          {/* Search & scan */}
          <div className="flex gap-2">
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && searchProducts()}
              placeholder="ค้นหาสินค้า..."
              className="flex-1 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white placeholder-gray-500"
            />
            <button
              type="button"
              onClick={searchProducts}
              className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold"
            >
              ค้นหา
            </button>
            <button
              type="button"
              onClick={() => setShowScanner(true)}
              className="px-3 py-2 bg-green-600 text-white rounded-lg text-sm"
            >
              <i className="fas fa-camera" />
            </button>
          </div>

          {/* Dropdown select */}
          {!loadingAllProducts && allProducts.length > 0 && (
            <select
              value={selectedProductCode}
              onChange={(e) => {
                if (e.target.value) {
                  const p = allProducts.find((x) => x.product_code === e.target.value)
                  if (p) addItem(p)
                  setSelectedProductCode('')
                }
              }}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white"
            >
              <option value="">-- เลือกสินค้าจากรายการ ({allProducts.length}) --</option>
              {allProducts.map((p) => (
                <option key={p.product_code} value={p.product_code}>
                  {p.product_code} - {p.product_name}
                </option>
              ))}
            </select>
          )}

          {/* Search results */}
          {loading && <div className="text-center text-gray-500 text-xs py-2">กำลังค้นหา...</div>}
          {products.length > 0 && (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {products.map((p) => (
                <button
                  key={p.product_code}
                  type="button"
                  onClick={() => addItem(p)}
                  className="w-full flex items-center gap-2 p-2 rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 text-left"
                >
                  <img
                    src={getProductImageUrl(p.product_code)}
                    alt=""
                    className="w-10 h-10 rounded-lg object-cover bg-slate-700"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-white truncate">{p.product_code}</div>
                    <div className="text-[10px] text-gray-400 truncate">{p.product_name}</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Selected items */}
          {selectedItems.length > 0 && (
            <div className="rounded-xl bg-slate-800 border border-slate-700 p-3 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-bold text-white">รายการคืน ({selectedItems.length})</span>
              </div>
              {selectedItems.map((item) => (
                <div key={item.product_code} className="bg-slate-700 rounded-lg p-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <img
                      src={getProductImageUrl(item.product_code)}
                      alt=""
                      className="w-10 h-10 rounded-lg object-cover bg-slate-600"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-white truncate">{item.product_code}</div>
                      <div className="text-[10px] text-gray-400 truncate">{item.product_name}</div>
                    </div>
                    <button type="button" onClick={() => removeItem(item.product_code)} className="text-red-400 hover:text-red-300">
                      <i className="fas fa-trash text-sm" />
                    </button>
                  </div>
                  <select
                    value={item.topic || ''}
                    onChange={(e) => updateItemTopic(item.product_code, e.target.value)}
                    className={`w-full rounded-lg border bg-slate-600 px-3 py-2 text-sm text-white ${
                      item.topic ? 'border-slate-500' : 'border-red-500/50'
                    }`}
                  >
                    <option value="">-- หัวข้อคืน * --</option>
                    {requisitionTopics.map((t) => (
                      <option key={t.id} value={t.topic_name}>{t.topic_name}</option>
                    ))}
                  </select>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => updateQty(item.product_code, item.qty - 1)} className="w-7 h-7 rounded bg-slate-600 text-white font-bold text-sm">-</button>
                    <input
                      type="number"
                      value={item.qty}
                      onChange={(e) => updateQty(item.product_code, Number(e.target.value) || 0)}
                      className="w-12 text-center rounded bg-slate-600 text-white text-sm py-1"
                      min={1}
                    />
                    <button type="button" onClick={() => updateQty(item.product_code, item.qty + 1)} className="w-7 h-7 rounded bg-slate-600 text-white font-bold text-sm">+</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Notes (required) */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              หมายเหตุ <span className="text-red-400">*</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={`w-full rounded-lg border bg-slate-800 px-3 py-2 text-sm text-white placeholder-gray-500 ${
                notes.trim() ? 'border-slate-600' : 'border-red-500/60'
              }`}
              rows={2}
              placeholder="กรุณาระบุหมายเหตุ (จำเป็น)"
            />
          </div>

          {/* Submit */}
          <button
            type="button"
            onClick={submitReturn}
            disabled={submitting || selectedItems.length === 0 || selectedItems.some((i) => !i.topic) || !notes.trim()}
            className="w-full py-3 rounded-xl bg-orange-600 text-white font-bold text-base hover:bg-orange-700 active:bg-orange-800 disabled:opacity-50"
          >
            {submitting ? 'กำลังบันทึก...' : `ยืนยันคืนของ (${selectedItems.length} รายการ)`}
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loadingList ? (
            <div className="flex justify-center py-10">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400" />
            </div>
          ) : returnList.length === 0 ? (
            <p className="text-center text-gray-500 py-10">ยังไม่มีรายการคืน</p>
          ) : (
            returnList.map((r) => (
              <div key={r.id} className="rounded-xl bg-slate-800 border border-slate-700 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-white">{r.return_no}</span>
                  {statusBadge(r.status)}
                </div>
                <div className="text-[10px] text-gray-400 mt-1">
                  {r.topic && <span className="mr-3">หัวข้อ: {r.topic}</span>}
                  {new Date(r.created_at).toLocaleString('th-TH')}
                </div>
                {r.note && <div className="text-xs text-gray-400 mt-1">{r.note}</div>}
              </div>
            ))
          )}
        </div>
      )}

      {showScanner && <BarcodeScanner onScan={handleBarcodeScan} onClose={() => setShowScanner(false)} />}
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
