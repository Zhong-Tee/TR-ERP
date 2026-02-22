import { useCallback, useEffect, useState } from 'react'
import Modal from '../components/ui/Modal'
import { useWmsModal } from '../components/wms/useWmsModal'
import { useAuthContext } from '../contexts/AuthContext'
import type { InventorySample, InventorySampleItem, Product } from '../types'
import {
  loadSamples,
  loadSampleDetail,
  createSample,
  updateSampleTest,
  convertSampleToProduct,
  loadProductsWithLastPrice,
} from '../lib/purchaseApi'
import { getPublicUrl } from '../lib/qcApi'

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  received: { label: 'รับแล้ว', color: 'bg-blue-100 text-blue-800' },
  testing: { label: 'กำลังทดสอบ', color: 'bg-yellow-100 text-yellow-800' },
  approved: { label: 'ผ่านการทดสอบ', color: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: 'ไม่ผ่าน', color: 'bg-red-100 text-red-800' },
  converted: { label: 'นำเข้าระบบแล้ว', color: 'bg-green-100 text-green-800' },
}

interface DraftItem {
  mode: 'existing' | 'manual'
  product_id: string
  product_name_manual: string
  qty: number
  note: string
}

interface TestItemResult {
  item_id: string
  name: string
  result: string
  note: string
}

interface ConvertForm {
  itemId: string
  itemName: string
  productCode: string
  productName: string
  productNameCn: string
  productType: string
  productCategory: string
  sellerName: string
  unitCost: string
}

export default function PurchaseSample() {
  const { user } = useAuthContext()
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()

  const [samples, setSamples] = useState<InventorySample[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  const [debouncedSearch, setDebouncedSearch] = useState(search)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 400)
    return () => clearTimeout(timer)
  }, [search])

  const [createOpen, setCreateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftItems, setDraftItems] = useState<DraftItem[]>([{ mode: 'manual', product_id: '', product_name_manual: '', qty: 1, note: '' }])
  const [supplierName, setSupplierName] = useState('')
  const [note, setNote] = useState('')

  const [viewing, setViewing] = useState<InventorySample | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [actionSaving, setActionSaving] = useState(false)

  // Test modal
  const [testOpen, setTestOpen] = useState(false)
  const [testNote, setTestNote] = useState('')
  const [rejectionReason, setRejectionReason] = useState('')
  const [testItemResults, setTestItemResults] = useState<TestItemResult[]>([])

  // Convert modal
  const [convertOpen, setConvertOpen] = useState(false)
  const [convertForm, setConvertForm] = useState<ConvertForm>({
    itemId: '', itemName: '', productCode: '', productName: '',
    productNameCn: '', productType: 'FG', productCategory: '',
    sellerName: '', unitCost: '',
  })

  const handleCreateFromTopBar = useCallback(() => setCreateOpen(true), [])
  useEffect(() => {
    window.addEventListener('purchase-sample-create', handleCreateFromTopBar)
    return () => window.removeEventListener('purchase-sample-create', handleCreateFromTopBar)
  }, [handleCreateFromTopBar])

  useEffect(() => { loadAll() }, [statusFilter, debouncedSearch])

  async function loadAll() {
    setLoading(true)
    try {
      const [sampleData, prodData] = await Promise.all([
        loadSamples({ status: statusFilter, search: debouncedSearch }),
        products.length ? Promise.resolve(products) : loadProductsWithLastPrice(),
      ])
      setSamples(sampleData.map((s: any) => ({ ...s, _itemCount: s.inv_sample_items?.length ?? 0 })))
      if (!products.length) setProducts(prodData as any)
    } catch (e) {
      console.error('Load samples failed:', e)
    } finally {
      setLoading(false)
    }
  }

  function addDraftItem() {
    setDraftItems((prev) => [...prev, { mode: 'manual', product_id: '', product_name_manual: '', qty: 1, note: '' }])
  }
  function updateDraftItem(i: number, patch: Partial<DraftItem>) {
    setDraftItems((prev) => prev.map((item, idx) => (idx === i ? { ...item, ...patch } : item)))
  }
  function removeDraftItem(i: number) {
    setDraftItems((prev) => prev.filter((_, idx) => idx !== i))
  }

  async function handleCreate() {
    const valid = draftItems.filter((i) => (i.mode === 'existing' ? i.product_id : i.product_name_manual.trim()) && i.qty > 0)
    if (!valid.length) { showMessage({ message: 'กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ' }); return }
    setSaving(true)
    try {
      await createSample({
        items: valid.map((i) => ({
          product_id: i.mode === 'existing' ? i.product_id : undefined,
          product_name_manual: i.mode === 'manual' ? i.product_name_manual : undefined,
          qty: i.qty,
          note: i.note || undefined,
        })),
        supplierName: supplierName.trim() || undefined,
        note: note.trim() || undefined,
        userId: user?.id,
      })
      setDraftItems([{ mode: 'manual', product_id: '', product_name_manual: '', qty: 1, note: '' }])
      setSupplierName('')
      setNote('')
      setCreateOpen(false)
      await loadAll()
    } catch (e: any) {
      showMessage({ title: 'เกิดข้อผิดพลาด', message: 'สร้างไม่สำเร็จ: ' + (e?.message || e) })
    } finally {
      setSaving(false)
    }
  }

  async function openDetail(sample: InventorySample) {
    setViewing(sample)
    setDetailLoading(true)
    try {
      const detail = await loadSampleDetail(sample.id)
      setViewing(detail)
    } catch (e) {
      console.error(e)
    } finally {
      setDetailLoading(false)
    }
  }

  async function refreshDetail() {
    if (!viewing) return
    try {
      const detail = await loadSampleDetail(viewing.id)
      setViewing(detail)
    } catch (e) {
      console.error(e)
    }
  }

  /* ── Start Testing ── */
  async function handleStartTesting() {
    if (!viewing) return
    const ok = await showConfirm({ title: 'เริ่มทดสอบ', message: 'ยืนยันเริ่มทดสอบสินค้าตัวอย่างนี้ ?', confirmText: 'เริ่มทดสอบ' })
    if (!ok) return
    setActionSaving(true)
    try {
      await updateSampleTest(viewing.id, 'testing', { userId: user?.id })
      await refreshDetail()
      await loadAll()
    } catch (e: any) {
      showMessage({ title: 'เกิดข้อผิดพลาด', message: 'ไม่สำเร็จ: ' + (e?.message || e) })
    } finally {
      setActionSaving(false)
    }
  }

  /* ── Open Test Result Modal ── */
  function openTestResultModal() {
    if (!viewing) return
    const items = (viewing.inv_sample_items || []).map((item: InventorySampleItem) => ({
      item_id: item.id,
      name: item.pr_products
        ? `${item.pr_products.product_code} - ${item.pr_products.product_name}`
        : item.product_name_manual || '-',
      result: item.item_test_result || 'passed',
      note: item.item_test_note || '',
    }))
    setTestItemResults(items)
    setTestNote(viewing.test_note || '')
    setRejectionReason('')
    setTestOpen(true)
  }

  async function handleSubmitTestResult(status: 'approved' | 'rejected') {
    if (!viewing) return
    if (status === 'rejected' && !rejectionReason.trim()) {
      showMessage({ message: 'กรุณาระบุเหตุผลที่ไม่ผ่าน' })
      return
    }
    setActionSaving(true)
    try {
      await updateSampleTest(viewing.id, status, {
        userId: user?.id,
        testNote: testNote.trim() || undefined,
        rejectionReason: status === 'rejected' ? rejectionReason.trim() : undefined,
        itemResults: testItemResults.map((r) => ({
          item_id: r.item_id,
          result: r.result,
          note: r.note || undefined,
        })),
      })
      setTestOpen(false)
      await refreshDetail()
      await loadAll()
    } catch (e: any) {
      showMessage({ title: 'เกิดข้อผิดพลาด', message: 'ไม่สำเร็จ: ' + (e?.message || e) })
    } finally {
      setActionSaving(false)
    }
  }

  /* ── Convert to Product ── */
  function openConvertModal(item: InventorySampleItem) {
    const displayName = item.pr_products
      ? `${item.pr_products.product_code} - ${item.pr_products.product_name}`
      : item.product_name_manual || ''
    setConvertForm({
      itemId: item.id,
      itemName: displayName,
      productCode: '',
      productName: item.product_name_manual || item.pr_products?.product_name || '',
      productNameCn: item.pr_products?.product_name_cn || '',
      productType: 'FG',
      productCategory: item.pr_products?.product_category || '',
      sellerName: viewing?.supplier_name || item.pr_products?.seller_name || '',
      unitCost: '',
    })
    setConvertOpen(true)
  }

  async function handleConvertToProduct() {
    if (!viewing) return
    if (!convertForm.productCode.trim()) { showMessage({ message: 'กรุณาระบุรหัสสินค้า' }); return }
    if (!convertForm.productName.trim()) { showMessage({ message: 'กรุณาระบุชื่อสินค้า' }); return }
    setActionSaving(true)
    try {
      await convertSampleToProduct({
        sampleId: viewing.id,
        itemId: convertForm.itemId,
        productCode: convertForm.productCode.trim(),
        productName: convertForm.productName.trim(),
        productNameCn: convertForm.productNameCn.trim() || undefined,
        productType: convertForm.productType,
        productCategory: convertForm.productCategory.trim() || undefined,
        sellerName: convertForm.sellerName.trim() || undefined,
        unitCost: convertForm.unitCost ? Number(convertForm.unitCost) : undefined,
        userId: user?.id,
      })
      setConvertOpen(false)
      await refreshDetail()
      await loadAll()
    } catch (e: any) {
      showMessage({ title: 'เกิดข้อผิดพลาด', message: 'นำเข้าไม่สำเร็จ: ' + (e?.message || e) })
    } finally {
      setActionSaving(false)
    }
  }

  const statusTabs = [
    { key: 'all', label: 'ทั้งหมด' },
    { key: 'received', label: 'รับแล้ว' },
    { key: 'testing', label: 'กำลังทดสอบ' },
    { key: 'approved', label: 'ผ่านการทดสอบ' },
    { key: 'rejected', label: 'ไม่ผ่าน' },
    { key: 'converted', label: 'นำเข้าระบบแล้ว' },
  ]

  return (
    <div className="space-y-4 mt-12">
      {/* Filter Bar */}
      <div className="bg-white rounded-xl shadow-sm border p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {statusTabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setStatusFilter(t.key)}
                className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                  statusFilter === t.key ? 'bg-white shadow text-emerald-700' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-[200px]">
            <input
              type="text"
              placeholder="ค้นหาเลขที่..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
            />
          </div>
        </div>
      </div>

      {/* List */}
      <div className="bg-white rounded-xl shadow-sm border">
        {loading ? (
          <div className="flex justify-center items-center py-16">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500" />
          </div>
        ) : samples.length === 0 ? (
          <div className="text-center py-16 text-gray-400">ไม่พบรายการสินค้าตัวอย่าง</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">เลขที่</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">สถานะ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">ผู้จัดจำหน่าย</th>
                  <th className="px-4 py-3 text-center font-semibold text-gray-600">รายการ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">วันที่รับ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">หมายเหตุ</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">การจัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {samples.map((s) => {
                  const st = STATUS_MAP[s.status] || { label: s.status, color: 'bg-gray-100 text-gray-700' }
                  return (
                    <tr key={s.id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">{s.sample_no}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${st.color}`}>
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{s.supplier_name || '-'}</td>
                      <td className="px-4 py-3 text-center text-gray-600">{(s as any)._itemCount || '-'}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {s.received_at ? new Date(s.received_at).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-500 max-w-[200px] truncate">{s.note || '-'}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => openDetail(s)}
                          className="px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 text-xs font-semibold"
                        >
                          ดูรายละเอียด
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} closeOnBackdropClick={false} contentClassName="max-w-3xl">
        <div className="p-6 space-y-5">
          <h2 className="text-xl font-bold text-gray-900">รับสินค้าตัวอย่าง</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">ผู้จัดจำหน่าย (ไม่บังคับ)</label>
            <input type="text" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="ชื่อผู้จัดจำหน่าย" />
          </div>
          <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
            {draftItems.map((item, index) => (
              <div key={`draft-${index}`} className="border rounded-lg p-3 bg-gray-50/50 space-y-2">
                <div className="flex gap-2 items-center">
                  <label className="flex items-center gap-1.5 text-xs text-gray-600">
                    <input type="radio" checked={item.mode === 'existing'} onChange={() => updateDraftItem(index, { mode: 'existing', product_name_manual: '' })} className="accent-emerald-600" />
                    สินค้าในระบบ
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-gray-600">
                    <input type="radio" checked={item.mode === 'manual'} onChange={() => updateDraftItem(index, { mode: 'manual', product_id: '' })} className="accent-emerald-600" />
                    พิมพ์ชื่อเอง
                  </label>
                </div>
                {item.mode === 'existing' ? (
                  <select value={item.product_id} onChange={(e) => updateDraftItem(index, { product_id: e.target.value })} className="w-full px-3 py-2 border rounded-lg bg-white text-sm">
                    <option value="">เลือกสินค้า</option>
                    {products.map((p) => (<option key={p.id} value={p.id}>{p.product_code} - {p.product_name}</option>))}
                  </select>
                ) : (
                  <input type="text" value={item.product_name_manual} onChange={(e) => updateDraftItem(index, { product_name_manual: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="ชื่อสินค้าตัวอย่าง" />
                )}
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-xs text-gray-500 mb-0.5">จำนวน</label>
                    <input type="number" min={1} value={item.qty} onChange={(e) => updateDraftItem(index, { qty: Number(e.target.value) || 1 })} className="w-full px-2 py-1.5 border rounded-lg text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-0.5">หมายเหตุ</label>
                    <input type="text" value={item.note} onChange={(e) => updateDraftItem(index, { note: e.target.value })} className="w-full px-2 py-1.5 border rounded-lg text-sm" placeholder="ถ้ามี" />
                  </div>
                  <div className="flex items-end">
                    <button onClick={() => removeDraftItem(index)} disabled={draftItems.length === 1} className="w-full px-2 py-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 text-sm disabled:opacity-30">ลบ</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button onClick={addDraftItem} className="px-4 py-2 border-2 border-dashed border-gray-300 rounded-lg hover:border-emerald-400 hover:text-emerald-600 text-sm text-gray-500 w-full">+ เพิ่มรายการ</button>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">หมายเหตุทั่วไป</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" rows={2} placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)" />
          </div>
          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setCreateOpen(false)} className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium">ยกเลิก</button>
            <button onClick={handleCreate} disabled={saving} className="px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 text-sm font-semibold">{saving ? 'กำลังบันทึก...' : 'บันทึก'}</button>
          </div>
        </div>
      </Modal>

      {/* Detail Modal */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} contentClassName="max-w-4xl">
        <div className="p-6 space-y-5">
          {detailLoading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500" />
            </div>
          ) : viewing ? (
            <>
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">รายละเอียดสินค้าตัวอย่าง</h2>
                  <p className="text-sm text-gray-500 mt-1">
                    เลขที่: <span className="font-semibold text-gray-800">{viewing.sample_no}</span>
                  </p>
                </div>
                <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${(STATUS_MAP[viewing.status] || { color: 'bg-gray-100 text-gray-700' }).color}`}>
                  {(STATUS_MAP[viewing.status] || { label: viewing.status }).label}
                </span>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">ผู้จัดจำหน่าย</div>
                  <div className="font-medium">{viewing.supplier_name || '-'}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">วันที่รับ</div>
                  <div className="font-medium">{viewing.received_at ? new Date(viewing.received_at).toLocaleString('th-TH') : '-'}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">จำนวนรายการ</div>
                  <div className="font-medium">{(viewing.inv_sample_items || []).length} รายการ</div>
                </div>
                {viewing.tested_at && (
                  <div className={`rounded-lg p-3 ${viewing.status === 'approved' ? 'bg-emerald-50' : viewing.status === 'rejected' ? 'bg-red-50' : 'bg-gray-50'}`}>
                    <div className="text-gray-500 text-xs">วันที่ทดสอบ</div>
                    <div className="font-medium">{new Date(viewing.tested_at).toLocaleString('th-TH')}</div>
                  </div>
                )}
              </div>

              {viewing.note && (
                <div className="bg-blue-50 rounded-lg p-3 text-sm">
                  <span className="text-blue-600 font-medium">หมายเหตุ:</span> {viewing.note}
                </div>
              )}

              {viewing.test_note && (
                <div className="bg-amber-50 rounded-lg p-3 text-sm">
                  <span className="text-amber-600 font-medium">ผลทดสอบ:</span> {viewing.test_note}
                </div>
              )}

              {viewing.rejection_reason && (
                <div className="bg-red-50 rounded-lg p-3 text-sm">
                  <span className="text-red-600 font-medium">เหตุผลที่ไม่ผ่าน:</span> {viewing.rejection_reason}
                </div>
              )}

              {/* Items table */}
              <div className="overflow-x-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b">
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600 w-14">รูป</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600">สินค้า</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">จำนวน</th>
                      <th className="px-3 py-2.5 text-center font-semibold text-gray-600">ผลทดสอบ</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600">หมายเหตุ</th>
                      {viewing.status === 'approved' && (
                        <th className="px-3 py-2.5 text-center font-semibold text-gray-600">นำเข้าระบบ</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(viewing.inv_sample_items || []).map((item: any) => {
                      const prod = item.pr_products
                      const imgUrl = prod ? getPublicUrl('product-images', prod.product_code) : ''
                      const displayName = prod
                        ? `${prod.product_code} - ${prod.product_name}`
                        : item.product_name_manual || '-'
                      const testResult = item.item_test_result
                      return (
                        <tr key={item.id}>
                          <td className="px-3 py-2">
                            <div className="w-10 h-10 rounded bg-gray-200 overflow-hidden">
                              {imgUrl ? (
                                <img src={imgUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-gray-400 text-[10px]">-</div>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 font-medium">{displayName}</td>
                          <td className="px-3 py-2 text-right">{Number(item.qty).toLocaleString()}</td>
                          <td className="px-3 py-2 text-center">
                            {testResult === 'passed' ? (
                              <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">ผ่าน</span>
                            ) : testResult === 'failed' ? (
                              <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800">ไม่ผ่าน</span>
                            ) : (
                              <span className="text-gray-400 text-xs">-</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-gray-500 text-xs">{item.item_test_note || item.note || '-'}</td>
                          {viewing.status === 'approved' && (
                            <td className="px-3 py-2 text-center">
                              {item.converted_product_id ? (
                                <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">นำเข้าแล้ว</span>
                              ) : (
                                <button
                                  onClick={() => openConvertModal(item)}
                                  disabled={actionSaving}
                                  className="px-3 py-1 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 text-xs font-semibold disabled:opacity-50"
                                >
                                  นำเข้าระบบ
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Action buttons */}
              <div className="flex justify-end gap-3 pt-3 border-t">
                {viewing.status === 'received' && (
                  <button
                    onClick={handleStartTesting}
                    disabled={actionSaving}
                    className="px-5 py-2.5 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 text-sm font-semibold disabled:opacity-50"
                  >
                    {actionSaving ? 'กำลังดำเนินการ...' : 'เริ่มทดสอบ'}
                  </button>
                )}
                {viewing.status === 'testing' && (
                  <button
                    onClick={openTestResultModal}
                    disabled={actionSaving}
                    className="px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-semibold disabled:opacity-50"
                  >
                    บันทึกผลทดสอบ
                  </button>
                )}
                <button onClick={() => setViewing(null)} className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium">ปิด</button>
              </div>
            </>
          ) : null}
        </div>
      </Modal>

      {/* Test Result Modal */}
      <Modal open={testOpen} onClose={() => setTestOpen(false)} closeOnBackdropClick={false} contentClassName="max-w-3xl">
        <div className="p-6 space-y-5">
          <h2 className="text-xl font-bold text-gray-900">บันทึกผลทดสอบ</h2>
          <div className="space-y-3 max-h-[40vh] overflow-y-auto">
            {testItemResults.map((item, idx) => (
              <div key={item.item_id} className="border rounded-lg p-3 bg-gray-50/50">
                <div className="font-medium text-sm mb-2">{item.name}</div>
                <div className="flex gap-3 items-center">
                  <select
                    value={item.result}
                    onChange={(e) => setTestItemResults((prev) => prev.map((r, i) => i === idx ? { ...r, result: e.target.value } : r))}
                    className="px-3 py-1.5 border rounded-lg text-sm bg-white"
                  >
                    <option value="passed">ผ่าน</option>
                    <option value="failed">ไม่ผ่าน</option>
                  </select>
                  <input
                    type="text"
                    value={item.note}
                    onChange={(e) => setTestItemResults((prev) => prev.map((r, i) => i === idx ? { ...r, note: e.target.value } : r))}
                    className="flex-1 px-3 py-1.5 border rounded-lg text-sm"
                    placeholder="หมายเหตุ (ถ้ามี)"
                  />
                </div>
              </div>
            ))}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">หมายเหตุภาพรวม</label>
            <textarea value={testNote} onChange={(e) => setTestNote(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" rows={2} placeholder="ผลการทดสอบโดยรวม..." />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">เหตุผลที่ไม่ผ่าน (กรณีไม่ผ่าน)</label>
            <input type="text" value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="ระบุเหตุผล..." />
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setTestOpen(false)} className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium">ยกเลิก</button>
            <button
              onClick={() => handleSubmitTestResult('rejected')}
              disabled={actionSaving}
              className="px-5 py-2.5 bg-red-50 text-red-700 rounded-lg hover:bg-red-100 text-sm font-semibold disabled:opacity-50"
            >
              ไม่ผ่าน
            </button>
            <button
              onClick={() => handleSubmitTestResult('approved')}
              disabled={actionSaving}
              className="px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-semibold disabled:opacity-50"
            >
              {actionSaving ? 'กำลังบันทึก...' : 'ผ่านการทดสอบ'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Convert to Product Modal */}
      <Modal open={convertOpen} onClose={() => setConvertOpen(false)} closeOnBackdropClick={false} contentClassName="max-w-lg">
        <div className="p-6 space-y-4">
          <h2 className="text-xl font-bold text-gray-900">นำเข้าระบบสินค้า</h2>
          <div className="bg-blue-50 rounded-lg p-3 text-sm text-blue-800">
            สร้างรหัสสินค้าใหม่จาก: <span className="font-semibold">{convertForm.itemName}</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">รหัสสินค้า <span className="text-red-500">*</span></label>
              <input type="text" value={convertForm.productCode} onChange={(e) => setConvertForm((f) => ({ ...f, productCode: e.target.value }))} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="เช่น FG-001" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">ประเภท</label>
              <select value={convertForm.productType} onChange={(e) => setConvertForm((f) => ({ ...f, productType: e.target.value }))} className="w-full px-3 py-2 border rounded-lg text-sm bg-white">
                <option value="FG">FG (สินค้าสำเร็จรูป)</option>
                <option value="RM">RM (วัตถุดิบ)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">ชื่อสินค้า <span className="text-red-500">*</span></label>
            <input type="text" value={convertForm.productName} onChange={(e) => setConvertForm((f) => ({ ...f, productName: e.target.value }))} className="w-full px-3 py-2 border rounded-lg text-sm" />
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">ชื่อจีน</label>
            <input type="text" value={convertForm.productNameCn} onChange={(e) => setConvertForm((f) => ({ ...f, productNameCn: e.target.value }))} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="ถ้ามี" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">หมวดหมู่</label>
              <input type="text" value={convertForm.productCategory} onChange={(e) => setConvertForm((f) => ({ ...f, productCategory: e.target.value }))} className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">ผู้จัดจำหน่าย</label>
              <input type="text" value={convertForm.sellerName} onChange={(e) => setConvertForm((f) => ({ ...f, sellerName: e.target.value }))} className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">ราคาต้นทุน (บาท)</label>
            <input type="number" min={0} step={0.01} value={convertForm.unitCost} onChange={(e) => setConvertForm((f) => ({ ...f, unitCost: e.target.value }))} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="0.00" />
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setConvertOpen(false)} className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium">ยกเลิก</button>
            <button onClick={handleConvertToProduct} disabled={actionSaving} className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-semibold">
              {actionSaving ? 'กำลังบันทึก...' : 'สร้างสินค้าและนำเข้า'}
            </button>
          </div>
        </div>
      </Modal>
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
