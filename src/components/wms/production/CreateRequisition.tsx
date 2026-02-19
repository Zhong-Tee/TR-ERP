import { useState, useEffect } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import BarcodeScanner from './BarcodeScanner'
import { getProductImageUrl, sortOrderItems } from '../wmsUtils'
import { useWmsModal } from '../useWmsModal'
import type { ProductType } from '../../../types'

interface ReqItem {
  product_code: string
  product_name: string
  storage_location?: string
  qty: number
  requisition_topic: string
}

export default function CreateRequisition() {
  const { user } = useAuthContext()
  const [activeTab, setActiveTab] = useState<'create' | 'list'>('create')
  const [searchTerm, setSearchTerm] = useState('')
  const [products, setProducts] = useState<any[]>([])
  const [allProducts, setAllProducts] = useState<any[]>([])
  const [selectedItems, setSelectedItems] = useState<ReqItem[]>([])
  const [requisitionId, setRequisitionId] = useState('')
  const [notes, setNotes] = useState('')
  const [requisitionTopics, setRequisitionTopics] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingAllProducts, setLoadingAllProducts] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [selectedProductCode, setSelectedProductCode] = useState('')
  const [productTypeFilter, setProductTypeFilter] = useState<ProductType>('FG')
  const [submitting, setSubmitting] = useState(false)
  const [reqList, setReqList] = useState<any[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detailItems, setDetailItems] = useState<any[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()

  useEffect(() => {
    generateRequisitionId()
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
    if (activeTab === 'list') loadReqList()
  }, [activeTab])

  const generateRequisitionId = async () => {
    const date = new Date()
    const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
    const { count } = await supabase
      .from('wms_requisitions')
      .select('*', { count: 'exact', head: true })
      .like('requisition_id', `REQ-${dateStr}-%`)
    const seq = ((count || 0) + 1).toString().padStart(3, '0')
    setRequisitionId(`REQ-${dateStr}-${seq}`)
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

  const loadReqList = async () => {
    setLoadingList(true)
    try {
      const { data, error } = await supabase
        .from('wms_requisitions')
        .select('*')
        .eq('created_by', user?.id || '')
        .order('created_at', { ascending: false })
        .limit(50)
      const requisitionsWithUsers = await Promise.all(
        (data || []).map(async (req: any) => {
          if (req.approved_by) {
            const { data: userData } = await supabase.from('us_users').select('username').eq('id', req.approved_by).single()
            return { ...req, approved_by_user: userData }
          }
          return req
        })
      )
      if (error) throw error
      setReqList(requisitionsWithUsers)
    } catch (e: any) {
      console.error('Load req list error:', e)
    } finally {
      setLoadingList(false)
    }
  }

  const toggleDetail = async (reqId: string) => {
    if (expandedId === reqId) { setExpandedId(null); setDetailItems([]); return }
    setExpandedId(reqId)
    setDetailLoading(true)
    try {
      const { data, error } = await supabase
        .from('wms_requisition_items')
        .select('*')
        .eq('requisition_id', reqId)
        .order('created_at', { ascending: true })
      if (error) throw error
      setDetailItems(sortOrderItems(data || []))
    } catch (e: any) {
      showMessage({ message: `เกิดข้อผิดพลาด: ${e.message}` })
      setDetailItems([])
    } finally {
      setDetailLoading(false)
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
      setSelectedItems([...selectedItems, { ...product, qty: 1, requisition_topic: '' }])
    }
  }

  const updateItemTopic = (code: string, topic: string) => {
    setSelectedItems(selectedItems.map((i) => i.product_code === code ? { ...i, requisition_topic: topic } : i))
  }

  const removeItem = (code: string) => setSelectedItems(selectedItems.filter((i) => i.product_code !== code))

  const updateQty = (code: string, qty: number) => {
    if (qty < 1) { removeItem(code); return }
    setSelectedItems(selectedItems.map((i) => i.product_code === code ? { ...i, qty } : i))
  }

  const submitRequisition = async () => {
    if (selectedItems.length === 0) { showMessage({ message: 'กรุณาเพิ่มรายการสินค้า' }); return }
    if (selectedItems.some((i) => !i.requisition_topic)) { showMessage({ message: 'กรุณาเลือกหัวข้อการเบิกให้ครบทุกรายการ' }); return }
    if (!notes.trim()) { showMessage({ message: 'กรุณากรอกหมายเหตุ' }); return }

    const ok = await showConfirm({
      title: 'ยืนยันการสร้างใบเบิก',
      message: `ยืนยันสร้างใบเบิก ${requisitionId}?\nจำนวนรายการ: ${selectedItems.length}`,
    })
    if (!ok) return

    setSubmitting(true)
    try {
      const { error: reqError } = await supabase
        .from('wms_requisitions')
        .insert({
          requisition_id: requisitionId,
          created_by: user?.id,
          status: 'pending',
          notes: notes.trim(),
          requisition_topic: null,
        })
        .select()
        .single()
      if (reqError) throw reqError

      const items = selectedItems.map((item) => ({
        requisition_id: requisitionId,
        product_code: item.product_code,
        product_name: item.product_name,
        location: item.storage_location || null,
        qty: item.qty,
        requisition_topic: item.requisition_topic || null,
      }))
      const { error: itemsError } = await supabase.from('wms_requisition_items').insert(items)
      if (itemsError) throw itemsError

      showMessage({ message: `สร้างใบเบิก ${requisitionId} สำเร็จ` })
      setSelectedItems([])
      setNotes('')
      setSearchTerm('')
      setProducts([])
      setSelectedProductCode('')
      generateRequisitionId()
    } catch (e: any) {
      showMessage({ message: `สร้างใบเบิกไม่สำเร็จ: ${e.message}` })
    } finally {
      setSubmitting(false)
    }
  }

  const statusBadge = (status: string) => {
    const map: Record<string, string> = { pending: 'bg-amber-500', approved: 'bg-green-500', rejected: 'bg-red-500' }
    const labels: Record<string, string> = { pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ' }
    return (
      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold text-white ${map[status] || 'bg-gray-500'}`}>
        {labels[status] || status}
      </span>
    )
  }

  const formatDate = (dateString: string) => {
    if (!dateString) return '-'
    return new Date(dateString).toLocaleString('th-TH', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
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
          สร้างใบเบิก
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('list')}
          className={`px-4 py-2 text-sm font-bold rounded-t-lg ${
            activeTab === 'list' ? 'bg-slate-800 text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'
          }`}
        >
          รายการใบเบิก
        </button>
      </div>

      {activeTab === 'create' ? (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {/* Requisition No */}
          <div className="rounded-xl bg-slate-800 border border-slate-700 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">เลขที่ใบเบิก</span>
              <span className="text-sm font-bold text-blue-400">{requisitionId}</span>
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
                <span className="text-sm font-bold text-white">รายการเบิก ({selectedItems.length})</span>
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
                    value={item.requisition_topic || ''}
                    onChange={(e) => updateItemTopic(item.product_code, e.target.value)}
                    className={`w-full rounded-lg border bg-slate-600 px-3 py-2 text-sm text-white ${
                      item.requisition_topic ? 'border-slate-500' : 'border-red-500/50'
                    }`}
                  >
                    <option value="">-- หัวข้อเบิก * --</option>
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
            onClick={submitRequisition}
            disabled={submitting || selectedItems.length === 0 || selectedItems.some((i) => !i.requisition_topic) || !notes.trim()}
            className="w-full py-3 rounded-xl bg-green-600 text-white font-bold text-base hover:bg-green-700 active:bg-green-800 disabled:opacity-50"
          >
            {submitting ? 'กำลังบันทึก...' : `ยืนยันเบิกของ (${selectedItems.length} รายการ)`}
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loadingList ? (
            <div className="flex justify-center py-10">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400" />
            </div>
          ) : reqList.length === 0 ? (
            <p className="text-center text-gray-500 py-10">ยังไม่มีรายการเบิก</p>
          ) : (
            reqList.map((req) => {
              const isExpanded = expandedId === req.requisition_id
              return (
                <div key={req.id} className="rounded-xl bg-slate-800 border border-slate-700 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => toggleDetail(req.requisition_id)}
                    className="w-full text-left p-3 active:bg-slate-700 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-bold text-white truncate">{req.requisition_id}</span>
                        <i className={`fas fa-chevron-down text-[10px] text-gray-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      </div>
                      {statusBadge(req.status)}
                    </div>
                    <div className="text-[10px] text-gray-400 mt-1">
                      {formatDate(req.created_at)}
                    </div>
                    {req.notes && <div className="text-xs text-gray-400 mt-1 truncate">หมายเหตุ: {req.notes}</div>}
                    {req.status === 'approved' && req.approved_by_user && (
                      <div className="text-[10px] text-green-400 mt-1">
                        <i className="fas fa-check-circle mr-1" />อนุมัติโดย: {req.approved_by_user.username}
                      </div>
                    )}
                    {req.status === 'rejected' && req.approved_by_user && (
                      <div className="text-[10px] text-red-400 mt-1">
                        <i className="fas fa-times-circle mr-1" />ปฏิเสธโดย: {req.approved_by_user.username}
                      </div>
                    )}
                  </button>

                  {isExpanded && (
                    <div className="border-t border-slate-700 px-3 pb-3 pt-2">
                      {detailLoading ? (
                        <div className="text-center py-4 text-gray-400 text-xs">กำลังโหลด...</div>
                      ) : detailItems.length === 0 ? (
                        <div className="text-center py-4 text-gray-500 text-xs">ไม่มีรายการสินค้า</div>
                      ) : (
                        <div className="space-y-1.5">
                          <div className="text-[10px] font-bold text-gray-400 mb-1">รายการสินค้า ({detailItems.length})</div>
                          {detailItems.map((item, idx) => (
                            <div key={item.id} className="flex items-center gap-2 p-2 bg-slate-700 rounded-lg">
                              <div className="text-xs font-bold text-gray-500 w-5 text-center shrink-0">{idx + 1}</div>
                              <img
                                src={getProductImageUrl(item.product_code)}
                                className="w-10 h-10 object-cover rounded-lg shrink-0 border border-slate-600"
                                onError={(e) => { (e.target as HTMLImageElement).src = 'https://placehold.co/100x100?text=NO+IMG' }}
                                alt={item.product_name}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-bold text-white truncate">{item.product_name}</div>
                                <div className="text-[10px] text-gray-400">รหัส: {item.product_code}</div>
                              </div>
                              <div className="text-white font-bold text-sm shrink-0 bg-blue-600/30 px-2 py-0.5 rounded-lg">
                                x{item.qty}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}

      {showScanner && <BarcodeScanner onScan={handleBarcodeScan} onClose={() => setShowScanner(false)} />}
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
