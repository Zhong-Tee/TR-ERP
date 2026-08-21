import { useState, useEffect } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import BarcodeScanner from './BarcodeScanner'
import MobileProductPicker from './MobileProductPicker'
import { getProductImageUrl, sortOrderItems } from '../wmsUtils'
import { useWmsModal } from '../useWmsModal'
import type { ProductType } from '../../../types'

interface ReqItem {
  product_code: string
  product_name: string
  storage_location?: string
  qty: number
  requisition_topic: string
  item_note?: string
  damage_files?: File[]
  damage_previews?: string[]
}

const PHOTO_REQUIRED_TOPICS = new Set(['ผลิตเสีย', 'สินค้าชำรุด'])
const requiresDamageEvidence = (topic: string) => PHOTO_REQUIRED_TOPICS.has(topic)
const DAMAGE_BUCKET = 'wms-damage-evidence'

export default function CreateRequisition() {
  const { user } = useAuthContext()
  const [activeTab, setActiveTab] = useState<'create' | 'list'>('create')
  const [searchTerm, setSearchTerm] = useState('')
  const [allProducts, setAllProducts] = useState<any[]>([])
  const [selectedItems, setSelectedItems] = useState<ReqItem[]>([])
  const [requisitionId, setRequisitionId] = useState('')
  const [requisitionTopics, setRequisitionTopics] = useState<any[]>([])
  const [loadingAllProducts, setLoadingAllProducts] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
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
    setSearchTerm('')
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
      if (error) throw error
      const rows = data || []
      const approverIds = [...new Set(rows.map((r: any) => r.approved_by).filter(Boolean))]
      const userMap = new Map<string, string>()
      if (approverIds.length > 0) {
        const { data: users } = await supabase.from('us_users').select('id, username').in('id', approverIds)
        for (const u of (users ?? []) as { id: string; username: string }[]) userMap.set(u.id, u.username)
      }
      const requisitionsWithUsers = rows.map((req: any) => ({
        ...req,
        approved_by_user: req.approved_by ? { username: userMap.get(req.approved_by) || '-' } : null,
      }))
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

  const handleBarcodeScan = (barcode: string) => {
    setShowScanner(false)
    setSearchTerm(barcode)
  }

  const addItem = (product: any) => {
    const existing = selectedItems.find((i) => i.product_code === product.product_code)
    if (existing) {
      setSelectedItems(selectedItems.map((i) => i.product_code === product.product_code ? { ...i, qty: i.qty + 1 } : i))
    } else {
      setSelectedItems([...selectedItems, { ...product, qty: 1, requisition_topic: '', item_note: '', damage_files: [], damage_previews: [] }])
    }
  }

  const updateItemTopic = (code: string, topic: string) => {
    setSelectedItems(selectedItems.map((i) => {
      if (i.product_code !== code) return i
      if (!requiresDamageEvidence(topic)) (i.damage_previews || []).forEach(URL.revokeObjectURL)
      return { ...i, requisition_topic: topic,
        damage_files: requiresDamageEvidence(topic) ? i.damage_files : [],
        damage_previews: requiresDamageEvidence(topic) ? i.damage_previews : [] }
    }))
  }

  const updateItemNote = (code: string, item_note: string) => {
    setSelectedItems(selectedItems.map((i) => i.product_code === code ? { ...i, item_note } : i))
  }

  const addDamagePhotos = (code: string, files: FileList | null) => {
    if (!files) return
    setSelectedItems((current) => current.map((item) => {
      if (item.product_code !== code) return item
      const accepted = Array.from(files).filter((file) => file.type.startsWith('image/') && file.size <= 10 * 1024 * 1024)
      const nextFiles = [...(item.damage_files || []), ...accepted].slice(0, 5)
      ;(item.damage_previews || []).forEach(URL.revokeObjectURL)
      return { ...item, damage_files: nextFiles, damage_previews: nextFiles.map(URL.createObjectURL) }
    }))
  }

  const removeDamagePhoto = (code: string, index: number) => {
    setSelectedItems((current) => current.map((item) => {
      if (item.product_code !== code) return item
      const nextFiles = (item.damage_files || []).filter((_, fileIndex) => fileIndex !== index)
      ;(item.damage_previews || []).forEach(URL.revokeObjectURL)
      return { ...item, damage_files: nextFiles, damage_previews: nextFiles.map(URL.createObjectURL) }
    }))
  }

  const removeItem = (code: string) => setSelectedItems(selectedItems.filter((i) => i.product_code !== code))

  const updateQty = (code: string, qty: number) => {
    if (qty < 1) { removeItem(code); return }
    setSelectedItems(selectedItems.map((i) => i.product_code === code ? { ...i, qty } : i))
  }

  const submitRequisition = async () => {
    if (selectedItems.length === 0) { showMessage({ message: 'กรุณาเพิ่มรายการสินค้า' }); return }
    if (selectedItems.some((i) => !i.requisition_topic)) { showMessage({ message: 'กรุณาเลือกหัวข้อการเบิกให้ครบทุกรายการ' }); return }
    if (selectedItems.some((i) => requiresDamageEvidence(i.requisition_topic) && !i.item_note?.trim())) {
      showMessage({ message: 'หัวข้อผลิตเสียและสินค้าชำรุดต้องกรอกหมายเหตุให้ครบทุกรายการ' }); return
    }
    if (selectedItems.some((i) => requiresDamageEvidence(i.requisition_topic) && !(i.damage_files || []).length)) {
      showMessage({ message: 'หัวข้อผลิตเสียและสินค้าชำรุดต้องถ่ายหรือแนบรูปอย่างน้อย 1 รูปต่อรายการ' }); return
    }

    const ok = await showConfirm({
      title: 'ยืนยันการสร้างใบเบิก',
      message: `ยืนยันสร้างใบเบิก ${requisitionId}?\nจำนวนรายการ: ${selectedItems.length}`,
    })
    if (!ok) return

    setSubmitting(true)
    const uploadedPaths: string[] = []
    try {
      const { error: reqError } = await supabase
        .from('wms_requisitions')
        .insert({
          requisition_id: requisitionId,
          created_by: user?.id,
          status: 'pending',
          notes: null,
          requisition_topic: null,
        })
        .select()
        .single()
      if (reqError) throw reqError

      const items = []
      for (const item of selectedItems) {
        const damagePaths: string[] = []
        for (const file of item.damage_files || []) {
          const ext = file.name.split('.').pop() || 'jpg'
          const path = `${user?.id}/${requisitionId}/${item.product_code}/${crypto.randomUUID()}.${ext}`
          const { error } = await supabase.storage.from(DAMAGE_BUCKET).upload(path, file, { contentType: file.type, upsert: false })
          if (error) throw error
          uploadedPaths.push(path); damagePaths.push(path)
        }
        items.push({ requisition_id: requisitionId, product_code: item.product_code, product_name: item.product_name,
          location: item.storage_location || null, qty: item.qty, requisition_topic: item.requisition_topic || null,
          item_note: item.item_note?.trim() || null, damage_image_paths: damagePaths })
      }
      const { error: itemsError } = await supabase.from('wms_requisition_items').insert(items)
      if (itemsError) throw itemsError

      showMessage({ message: `สร้างใบเบิก ${requisitionId} สำเร็จ` })
      setSelectedItems([])
      setSearchTerm('')
      generateRequisitionId()
    } catch (e: any) {
      if (uploadedPaths.length) await supabase.storage.from(DAMAGE_BUCKET).remove(uploadedPaths)
      await supabase.from('wms_requisitions').delete().eq('requisition_id', requisitionId)
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
      <div className="flex border-b border-gray-200 px-3 pt-2">
        <button
          type="button"
          onClick={() => setActiveTab('create')}
          className={`px-4 py-2 text-sm font-bold rounded-t-lg ${
            activeTab === 'create' ? 'bg-white text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'
          }`}
        >
          สร้างใบเบิก
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('list')}
          className={`px-4 py-2 text-sm font-bold rounded-t-lg ${
            activeTab === 'list' ? 'bg-white text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'
          }`}
        >
          รายการใบเบิก
        </button>
      </div>

      {activeTab === 'create' ? (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {/* Requisition No */}
          <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">เลขที่ใบเบิก</span>
              <span className="text-sm font-bold text-blue-600">{requisitionId}</span>
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
                  productTypeFilter === pt ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
                }`}
              >
                {pt === 'FG' ? 'สินค้าสำเร็จรูป' : pt === 'RM' ? 'วัตถุดิบ' : 'สินค้าแปรรูป'}
              </button>
            ))}
          </div>

          <MobileProductPicker
            products={allProducts}
            query={searchTerm}
            onQueryChange={setSearchTerm}
            onSelect={addItem}
            onOpenScanner={() => setShowScanner(true)}
            loading={loadingAllProducts}
            selectedCodes={selectedItems.map((item) => item.product_code)}
          />

          {/* Selected items */}
          {selectedItems.length > 0 && (
            <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-3 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-bold text-gray-900">รายการเบิก ({selectedItems.length})</span>
              </div>
              {selectedItems.map((item) => (
                <div key={item.product_code} className="bg-gray-100 rounded-lg p-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <img
                      src={getProductImageUrl(item.product_code)}
                      alt=""
                      className="w-10 h-10 rounded-lg object-cover bg-gray-200"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-gray-900 truncate">{item.product_code}</div>
                      <div className="text-[10px] text-gray-500 truncate">{item.product_name}</div>
                    </div>
                    <button type="button" onClick={() => removeItem(item.product_code)} className="text-red-500 hover:text-red-600">
                      <i className="fas fa-trash text-sm" />
                    </button>
                  </div>
                  <select
                    value={item.requisition_topic || ''}
                    onChange={(e) => updateItemTopic(item.product_code, e.target.value)}
                    className={`w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 ${
                      item.requisition_topic ? 'border-gray-300' : 'border-red-500/50'
                    }`}
                  >
                    <option value="">-- หัวข้อเบิก * --</option>
                    {requisitionTopics.map((t) => (
                      <option key={t.id} value={t.topic_name}>{t.topic_name}</option>
                    ))}
                  </select>
                  <textarea
                    value={item.item_note || ''}
                    onChange={(e) => updateItemNote(item.product_code, e.target.value)}
                    className={`w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 ${
                      requiresDamageEvidence(item.requisition_topic) && !item.item_note?.trim() ? 'border-red-500' : 'border-gray-300'
                    }`}
                    rows={2}
                    placeholder={requiresDamageEvidence(item.requisition_topic) ? 'กรุณาระบุรายละเอียดความเสียหาย (จำเป็น)' : 'หมายเหตุรายการ (ไม่บังคับกรอก)'}
                  />
                  {requiresDamageEvidence(item.requisition_topic) && <div className="rounded-lg border border-red-200 bg-red-50 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-red-700">รูปหลักฐานความเสียหาย * (สูงสุด 5 รูป)</span>
                      <label className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg bg-red-600 text-white" title="ถ่ายรูปจุดผลิตเสีย">
                        <i className="fas fa-camera" aria-hidden />
                        <input type="file" accept="image/*" capture="environment" multiple className="hidden"
                          onChange={(e) => { addDamagePhotos(item.product_code, e.target.files); e.target.value = '' }} />
                      </label>
                    </div>
                    {!!item.damage_previews?.length && <div className="mt-2 grid grid-cols-4 gap-2">
                      {item.damage_previews.map((src, index) => <div key={src} className="relative aspect-square">
                        <img src={src} alt="รูปจุดผลิตเสีย" className="h-full w-full rounded-lg object-cover" />
                        <button type="button" onClick={() => removeDamagePhoto(item.product_code, index)}
                          className="absolute -right-1 -top-1 h-5 w-5 rounded-full bg-red-600 text-xs text-white">×</button>
                      </div>)}
                    </div>}
                  </div>}
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => updateQty(item.product_code, item.qty - 1)} className="w-7 h-7 rounded bg-gray-200 text-gray-900 font-bold text-sm">-</button>
                    <input
                      type="number"
                      value={item.qty}
                      onChange={(e) => updateQty(item.product_code, Number(e.target.value) || 0)}
                      className="w-12 text-center rounded border border-gray-300 bg-white text-gray-900 text-sm py-1"
                      min={1}
                    />
                    <button type="button" onClick={() => updateQty(item.product_code, item.qty + 1)} className="w-7 h-7 rounded bg-gray-200 text-gray-900 font-bold text-sm">+</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Submit */}
          <button
            type="button"
            onClick={submitRequisition}
            disabled={submitting || selectedItems.length === 0 || selectedItems.some((i) => !i.requisition_topic ||
              (requiresDamageEvidence(i.requisition_topic) && (!i.item_note?.trim() || !(i.damage_files || []).length)))}
            className="w-full py-3 rounded-xl bg-green-600 text-white font-bold text-base hover:bg-green-700 active:bg-green-800 disabled:opacity-50"
          >
            {submitting ? 'กำลังบันทึก...' : `ยืนยันเบิกของ (${selectedItems.length} รายการ)`}
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loadingList ? (
            <div className="flex justify-center py-10">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            </div>
          ) : reqList.length === 0 ? (
            <p className="text-center text-gray-500 py-10">ยังไม่มีรายการเบิก</p>
          ) : (
            reqList.map((req) => {
              const isExpanded = expandedId === req.requisition_id
              return (
                <div key={req.id} className="rounded-xl bg-white border border-gray-200 shadow-sm overflow-hidden">
                  <button
                    type="button"
                    onClick={() => toggleDetail(req.requisition_id)}
                    className="w-full text-left p-3 active:bg-gray-100 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-bold text-gray-900 truncate">{req.requisition_id}</span>
                        <i className={`fas fa-chevron-down text-[10px] text-gray-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      </div>
                      {statusBadge(req.status)}
                    </div>
                    <div className="text-[10px] text-gray-500 mt-1">
                      {formatDate(req.created_at)}
                    </div>
                    {req.notes && <div className="text-xs text-gray-500 mt-1 truncate">หมายเหตุ: {req.notes}</div>}
                    {req.status === 'approved' && req.approved_by_user && (
                      <div className="text-[10px] text-green-600 mt-1">
                        <i className="fas fa-check-circle mr-1" />อนุมัติโดย: {req.approved_by_user.username}
                      </div>
                    )}
                    {req.status === 'rejected' && req.approved_by_user && (
                      <div className="text-[10px] text-red-500 mt-1">
                        <i className="fas fa-times-circle mr-1" />ปฏิเสธโดย: {req.approved_by_user.username}
                      </div>
                    )}
                  </button>

                  {isExpanded && (
                    <div className="border-t border-gray-200 px-3 pb-3 pt-2">
                      {detailLoading ? (
                        <div className="text-center py-4 text-gray-500 text-xs">กำลังโหลด...</div>
                      ) : detailItems.length === 0 ? (
                        <div className="text-center py-4 text-gray-500 text-xs">ไม่มีรายการสินค้า</div>
                      ) : (
                        <div className="space-y-1.5">
                          <div className="text-[10px] font-bold text-gray-500 mb-1">รายการสินค้า ({detailItems.length})</div>
                          {detailItems.map((item, idx) => (
                            <div key={item.id} className="flex items-center gap-2 p-2 bg-gray-100 rounded-lg">
                              <div className="text-xs font-bold text-gray-500 w-5 text-center shrink-0">{idx + 1}</div>
                              <img
                                src={getProductImageUrl(item.product_code)}
                                className="w-10 h-10 object-cover rounded-lg shrink-0 border border-gray-300"
                                onError={(e) => { (e.target as HTMLImageElement).src = 'https://placehold.co/100x100?text=NO+IMG' }}
                                alt={item.product_name}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-bold text-gray-900 truncate">{item.product_name}</div>
                                <div className="text-[10px] text-gray-500">รหัส: {item.product_code}</div>
                              </div>
                              <div className="text-blue-700 font-bold text-sm shrink-0 bg-blue-100 px-2 py-0.5 rounded-lg">
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
