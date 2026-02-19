import { useState, useEffect } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import BarcodeScanner from './BarcodeScanner'
import { getProductImageUrl } from '../wmsUtils'
import { useWmsModal } from '../useWmsModal'
import type { ProductType } from '../../../types'

interface BorrowItem {
  product_code: string
  product_name: string
  storage_location?: string
  qty: number
  topic: string
}

export default function ProductionBorrow() {
  const { user } = useAuthContext()
  const [activeTab, setActiveTab] = useState<'create' | 'list'>('create')
  const [searchTerm, setSearchTerm] = useState('')
  const [products, setProducts] = useState<any[]>([])
  const [allProducts, setAllProducts] = useState<any[]>([])
  const [selectedItems, setSelectedItems] = useState<BorrowItem[]>([])
  const [borrowNo, setBorrowNo] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  const [requisitionTopics, setRequisitionTopics] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingAllProducts, setLoadingAllProducts] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [selectedProductCode, setSelectedProductCode] = useState('')
  const [productTypeFilter, setProductTypeFilter] = useState<ProductType>('FG')
  const [submitting, setSubmitting] = useState(false)
  const [borrowList, setBorrowList] = useState<any[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()

  useEffect(() => {
    generateBorrowNo()
    loadAllProducts()
    loadTopics()
    setDefaultDueDate()
  }, [])

  useEffect(() => {
    loadAllProducts()
    setProducts([])
    setSearchTerm('')
    setSelectedProductCode('')
  }, [productTypeFilter])

  useEffect(() => {
    if (activeTab === 'list') loadBorrowList()
  }, [activeTab])

  const setDefaultDueDate = () => {
    const d = new Date()
    d.setDate(d.getDate() + 7)
    setDueDate(d.toISOString().slice(0, 10))
  }

  const generateBorrowNo = async () => {
    const date = new Date()
    const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
    const { count } = await supabase
      .from('wms_borrow_requisitions')
      .select('*', { count: 'exact', head: true })
      .like('borrow_no', `BOR-${dateStr}-%`)
    const seq = ((count || 0) + 1).toString().padStart(3, '0')
    setBorrowNo(`BOR-${dateStr}-${seq}`)
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

  const loadBorrowList = async () => {
    setLoadingList(true)
    try {
      const { data, error } = await supabase
        .from('wms_borrow_requisitions')
        .select('*')
        .eq('created_by', user?.id || '')
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) throw error
      setBorrowList(data || [])
    } catch (e: any) {
      console.error('Load borrow list error:', e)
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

  const submitBorrow = async () => {
    if (selectedItems.length === 0) { showMessage({ message: 'กรุณาเพิ่มรายการสินค้า' }); return }
    if (selectedItems.some((i) => !i.topic)) { showMessage({ message: 'กรุณาเลือกหัวข้อยืมให้ครบทุกรายการ' }); return }
    if (!dueDate) { showMessage({ message: 'กรุณากำหนดวันคืน' }); return }
    if (!notes.trim()) { showMessage({ message: 'กรุณากรอกหมายเหตุ' }); return }

    const ok = await showConfirm({
      title: 'ยืนยันการยืมของ',
      message: `ยืนยันสร้างใบยืม ${borrowNo}?\nจำนวนรายการ: ${selectedItems.length}\nกำหนดคืน: ${dueDate}`,
    })
    if (!ok) return

    setSubmitting(true)
    try {
      const { error: borErr } = await supabase
        .from('wms_borrow_requisitions')
        .insert({
          borrow_no: borrowNo,
          topic: null,
          status: 'pending',
          due_date: dueDate,
          created_by: user?.id,
          note: notes.trim() || null,
        })
        .select()
        .single()
      if (borErr) throw borErr

      const { data: borData } = await supabase
        .from('wms_borrow_requisitions')
        .select('id')
        .eq('borrow_no', borrowNo)
        .single()
      if (!borData) throw new Error('ไม่พบใบยืมที่สร้าง')

      const productCodes = selectedItems.map((i) => i.product_code)
      const { data: prods } = await supabase
        .from('pr_products')
        .select('id, product_code')
        .in('product_code', productCodes)
      const codeToId = (prods || []).reduce<Record<string, string>>((acc, p) => { acc[p.product_code] = p.id; return acc }, {})

      const items = selectedItems
        .filter((i) => codeToId[i.product_code])
        .map((i) => ({
          borrow_requisition_id: borData.id,
          product_id: codeToId[i.product_code],
          qty: i.qty,
          topic: i.topic || null,
        }))
      if (items.length > 0) {
        const { error: itemErr } = await supabase.from('wms_borrow_requisition_items').insert(items)
        if (itemErr) throw itemErr
      }

      showMessage({ message: `สร้างใบยืม ${borrowNo} สำเร็จ` })
      setSelectedItems([])
      setNotes('')
      setDefaultDueDate()
      generateBorrowNo()
    } catch (e: any) {
      showMessage({ message: `สร้างใบยืมไม่สำเร็จ: ${e.message}` })
    } finally {
      setSubmitting(false)
    }
  }

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      pending: 'bg-amber-500',
      approved: 'bg-blue-500',
      partial_returned: 'bg-cyan-500',
      returned: 'bg-green-500',
      overdue: 'bg-red-500',
      written_off: 'bg-gray-500',
      rejected: 'bg-red-700',
    }
    const labels: Record<string, string> = {
      pending: 'รออนุมัติ',
      approved: 'อนุมัติแล้ว',
      partial_returned: 'คืนบางส่วน',
      returned: 'คืนแล้ว',
      overdue: 'เลยกำหนด',
      written_off: 'ตัดเป็นของเสีย',
      rejected: 'ไม่อนุมัติ',
    }
    return (
      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold text-white ${map[status] || 'bg-gray-500'}`}>
        {labels[status] || status}
      </span>
    )
  }

  const isOverdue = (due: string, status: string) => {
    if (['returned', 'written_off', 'rejected'].includes(status)) return false
    return new Date(due) < new Date(new Date().toISOString().slice(0, 10))
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-slate-700 px-3 pt-2">
        <button
          type="button"
          onClick={() => setActiveTab('create')}
          className={`px-4 py-2 text-sm font-bold rounded-t-lg ${
            activeTab === 'create' ? 'bg-slate-800 text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'
          }`}
        >
          สร้างใบยืม
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('list')}
          className={`px-4 py-2 text-sm font-bold rounded-t-lg ${
            activeTab === 'list' ? 'bg-slate-800 text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'
          }`}
        >
          รายการใบยืม
        </button>
      </div>

      {activeTab === 'create' ? (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div className="rounded-xl bg-slate-800 border border-slate-700 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">เลขที่ใบยืม</span>
              <span className="text-sm font-bold text-blue-400">{borrowNo}</span>
            </div>
          </div>

          {/* Due date */}
          <div className="rounded-xl bg-slate-800 border border-slate-700 p-3 space-y-2">
            <label className="block text-xs text-gray-400">
              วันกำหนดคืน <span className="text-red-400">*</span>
            </label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className={`w-full rounded-lg border bg-slate-700 px-3 py-2 text-sm text-white ${
                dueDate ? 'border-slate-600' : 'border-red-500/60'
              }`}
            />
            <div className="flex gap-2">
              {[7, 14, 30].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => {
                    const dt = new Date()
                    dt.setDate(dt.getDate() + d)
                    setDueDate(dt.toISOString().slice(0, 10))
                  }}
                  className="flex-1 py-1 rounded-lg bg-slate-600 text-xs text-gray-300 hover:bg-slate-500 font-bold"
                >
                  {d} วัน
                </button>
              ))}
            </div>
          </div>

          {/* Product type filter */}
          <div className="flex gap-2">
            {(['FG', 'RM'] as ProductType[]).map((pt) => (
              <button
                key={pt}
                type="button"
                onClick={() => setProductTypeFilter(pt)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold ${
                  productTypeFilter === pt ? 'bg-blue-600 text-white' : 'bg-slate-700 text-gray-300'
                }`}
              >
                {pt === 'FG' ? 'สินค้าสำเร็จรูป' : 'วัตถุดิบ'}
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
            <button type="button" onClick={searchProducts} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold">
              ค้นหา
            </button>
            <button type="button" onClick={() => setShowScanner(true)} className="px-3 py-2 bg-green-600 text-white rounded-lg text-sm">
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
                <span className="text-sm font-bold text-white">รายการยืม ({selectedItems.length})</span>
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
                    <option value="">-- หัวข้อยืม * --</option>
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
            onClick={submitBorrow}
            disabled={submitting || selectedItems.length === 0 || selectedItems.some((i) => !i.topic) || !dueDate || !notes.trim()}
            className="w-full py-3 rounded-xl bg-blue-600 text-white font-bold text-base hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50"
          >
            {submitting ? 'กำลังบันทึก...' : `ยืนยันยืมของ (${selectedItems.length} รายการ)`}
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loadingList ? (
            <div className="flex justify-center py-10">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400" />
            </div>
          ) : borrowList.length === 0 ? (
            <p className="text-center text-gray-500 py-10">ยังไม่มีรายการยืม</p>
          ) : (
            borrowList.map((r) => (
              <div key={r.id} className={`rounded-xl bg-slate-800 border p-3 ${isOverdue(r.due_date, r.status) ? 'border-red-500/60' : 'border-slate-700'}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-white">{r.borrow_no}</span>
                  <div className="flex items-center gap-1.5">
                    {isOverdue(r.due_date, r.status) && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold text-white bg-red-500 animate-pulse">เลยกำหนด</span>
                    )}
                    {statusBadge(r.status)}
                  </div>
                </div>
                <div className="text-[10px] text-gray-400 mt-1 flex flex-wrap gap-x-3">
                  <span>กำหนดคืน: {new Date(r.due_date).toLocaleDateString('th-TH')}</span>
                  <span>{new Date(r.created_at).toLocaleString('th-TH')}</span>
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
