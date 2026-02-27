import { useCallback, useEffect, useMemo, useState } from 'react'
import Modal from '../components/ui/Modal'
import { useWmsModal } from '../components/wms/useWmsModal'
import { useAuthContext } from '../contexts/AuthContext'
import type { InventorySample, InventorySampleItem } from '../types'
import {
  loadSamples,
  loadSampleDetail,
  createSample,
  updateSampleTest,
  convertSampleToProduct,
  getNextProductCode,
  loadSellers,
  createSeller,
  loadProductCategoryOptions,
  loadUserDisplayNames,
} from '../lib/purchaseApi'
import { supabase } from '../lib/supabase'
import { getPublicUrl } from '../lib/qcApi'

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  received: { label: 'รับแล้ว', color: 'bg-blue-100 text-blue-800' },
  testing: { label: 'กำลังทดสอบ', color: 'bg-yellow-100 text-yellow-800' },
  approved: { label: 'ผ่านการทดสอบ', color: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: 'ไม่ผ่าน', color: 'bg-red-100 text-red-800' },
  converted: { label: 'นำเข้าระบบแล้ว', color: 'bg-green-100 text-green-800' },
}

interface DraftItem {
  product_name_manual: string
  qty: number
  note: string
  image_file: File | null
  image_preview: string
}

interface TestItemResult {
  item_id: string
  name: string
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
}

export default function PurchaseSample() {
  const { user } = useAuthContext()
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()

  const [samples, setSamples] = useState<InventorySample[]>([])
  const [categoryOptions, setCategoryOptions] = useState<string[]>([])
  const [sellers, setSellers] = useState<Array<{ id: string; name: string; name_cn: string | null }>>([])
  const [userMap, setUserMap] = useState<Record<string, string>>({})
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
  const [draftItems, setDraftItems] = useState<DraftItem[]>([{ product_name_manual: '', qty: 1, note: '', image_file: null, image_preview: '' }])
  const [note, setNote] = useState('')

  const [viewing, setViewing] = useState<InventorySample | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [actionSaving, setActionSaving] = useState(false)
  const [startTestOpen, setStartTestOpen] = useState(false)
  const [testingByName, setTestingByName] = useState('')

  // Test modal
  const [testOpen, setTestOpen] = useState(false)
  const [testDecision, setTestDecision] = useState<'approved' | 'rejected'>('approved')
  const [testNote, setTestNote] = useState('')
  const [rejectionReason, setRejectionReason] = useState('')
  const [testItemResults, setTestItemResults] = useState<TestItemResult[]>([])

  // Convert modal
  const [convertOpen, setConvertOpen] = useState(false)
  const [addCategoryOpen, setAddCategoryOpen] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [addSellerOpen, setAddSellerOpen] = useState(false)
  const [newSellerName, setNewSellerName] = useState('')
  const [newSellerNameCn, setNewSellerNameCn] = useState('')
  const [sellerSaving, setSellerSaving] = useState(false)
  const [convertForm, setConvertForm] = useState<ConvertForm>({
    itemId: '', itemName: '', productCode: '', productName: '',
    productNameCn: '', productType: 'FG', productCategory: '',
    sellerName: '',
  })

  const handleCreateFromTopBar = useCallback(() => setCreateOpen(true), [])
  useEffect(() => {
    window.addEventListener('purchase-sample-create', handleCreateFromTopBar)
    return () => window.removeEventListener('purchase-sample-create', handleCreateFromTopBar)
  }, [handleCreateFromTopBar])

  useEffect(() => { loadAll() }, [statusFilter, debouncedSearch])

  const sortedCategoryOptions = useMemo(() => [...categoryOptions].sort((a, b) => a.localeCompare(b, 'th')), [categoryOptions])

  async function loadAll() {
    setLoading(true)
    try {
      const [sampleData, sellerData, categories] = await Promise.all([
        loadSamples({ status: statusFilter, search: debouncedSearch }),
        loadSellers(),
        loadProductCategoryOptions(),
      ])
      setSamples(sampleData.map((s: any) => ({ ...s, _itemCount: s.inv_sample_items?.length ?? 0 })))
      setSellers(sellerData as any)
      setCategoryOptions(categories)

      const userIds = sampleData
        .flatMap((s) => [s.received_by, s.testing_started_by, s.tested_by, s.approved_by])
        .filter(Boolean) as string[]
      if (userIds.length > 0) {
        const names = await loadUserDisplayNames(userIds)
        setUserMap((prev) => ({ ...prev, ...names }))
      }
    } catch (e) {
      console.error('Load samples failed:', e)
    } finally {
      setLoading(false)
    }
  }

  function addDraftItem() {
    setDraftItems((prev) => [...prev, { product_name_manual: '', qty: 1, note: '', image_file: null, image_preview: '' }])
  }
  function updateDraftItem(i: number, patch: Partial<DraftItem>) {
    setDraftItems((prev) => prev.map((item, idx) => (idx === i ? { ...item, ...patch } : item)))
  }
  function removeDraftItem(i: number) {
    setDraftItems((prev) => prev.filter((_, idx) => idx !== i))
  }

  async function handleCreate() {
    const valid = draftItems.filter((i) => i.product_name_manual.trim() && i.qty > 0)
    if (!valid.length) { showMessage({ message: 'กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ' }); return }
    setSaving(true)
    try {
      const derivedSampleLabel = valid[0].product_name_manual.trim()
      const itemsWithImage = await Promise.all(valid.map(async (item) => {
        let imageUrl: string | undefined = undefined
        if (item.image_file) {
          const ext = item.image_file.name.split('.').pop() || 'jpg'
          const fileName = `sample-${Date.now()}-${crypto.randomUUID()}.${ext}`
          const { error } = await supabase.storage.from('product-images').upload(fileName, item.image_file, { upsert: false })
          if (error) throw error
          const { data } = supabase.storage.from('product-images').getPublicUrl(fileName)
          imageUrl = data.publicUrl
        }
        return {
          product_name_manual: item.product_name_manual,
          image_url: imageUrl,
          qty: item.qty,
          note: item.note || undefined,
        }
      }))
      await createSample({
        items: itemsWithImage,
        sampleLabel: derivedSampleLabel,
        note: note.trim() || undefined,
        userId: user?.id,
      })
      setDraftItems([{ product_name_manual: '', qty: 1, note: '', image_file: null, image_preview: '' }])
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
  async function handleConfirmStartTesting() {
    if (!viewing) return
    if (!testingByName.trim()) {
      showMessage({ message: 'กรุณาระบุชื่อผู้ทดสอบ' })
      return
    }
    setActionSaving(true)
    try {
      await updateSampleTest(viewing.id, 'testing', { userId: user?.id, testingByName: testingByName.trim() })
      setStartTestOpen(false)
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
      note: item.item_test_note || '',
    }))
    setTestItemResults(items)
    setTestDecision('approved')
    setTestNote(viewing.test_note || '')
    setRejectionReason(viewing.rejection_reason || '')
    setTestOpen(true)
  }

  async function handleSubmitTestResult() {
    if (!viewing) return
    if (testDecision === 'rejected' && !rejectionReason.trim()) {
      showMessage({ message: 'กรุณาระบุเหตุผลที่ไม่ผ่าน' })
      return
    }
    setActionSaving(true)
    try {
      await updateSampleTest(viewing.id, testDecision, {
        userId: user?.id,
        testNote: testNote.trim() || undefined,
        rejectionReason: testDecision === 'rejected' ? rejectionReason.trim() : undefined,
        itemResults: testItemResults.map((r) => ({
          item_id: r.item_id,
          result: testDecision === 'approved' ? 'passed' : 'failed',
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
  async function openConvertModal(item: InventorySampleItem) {
    const displayName = item.pr_products
      ? `${item.pr_products.product_code} - ${item.pr_products.product_name}`
      : item.product_name_manual || ''
    const fgNext = await getNextProductCode('FG')
    setConvertForm({
      itemId: item.id,
      itemName: displayName,
      productCode: fgNext,
      productName: item.product_name_manual || item.pr_products?.product_name || '',
      productNameCn: item.pr_products?.product_name_cn || '',
      productType: 'FG',
      productCategory: item.pr_products?.product_category || '',
      sellerName: viewing?.supplier_name || item.pr_products?.seller_name || '',
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

  function handleAddCategory() {
    const next = newCategoryName.trim()
    if (!next) {
      showMessage({ message: 'กรุณาระบุชื่อหมวดหมู่' })
      return
    }
    setCategoryOptions((prev) => (prev.includes(next) ? prev : [...prev, next]))
    setConvertForm((f) => ({ ...f, productCategory: next }))
    setNewCategoryName('')
    setAddCategoryOpen(false)
  }

  async function handleAddSeller() {
    const name = newSellerName.trim()
    if (!name) {
      showMessage({ message: 'กรุณาระบุชื่อผู้ขาย' })
      return
    }
    setSellerSaving(true)
    try {
      const created = await createSeller({ name, nameCn: newSellerNameCn.trim() || undefined })
      await loadAll()
      setConvertForm((f) => ({ ...f, sellerName: created.name }))
      setNewSellerName('')
      setNewSellerNameCn('')
      setAddSellerOpen(false)
    } catch (e: any) {
      showMessage({ title: 'เพิ่มผู้ขายไม่สำเร็จ', message: e?.message || String(e) })
    } finally {
      setSellerSaving(false)
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
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">ชื่อเรียกสินค้า</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">ผู้ทดสอบ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">ผู้อนุมัติ</th>
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
                      <td className="px-4 py-3 text-gray-700 font-medium">{s.sample_label || '-'}</td>
                      <td className="px-4 py-3 text-gray-600">{s.testing_by_name || '-'}</td>
                      <td className="px-4 py-3 text-gray-600">{s.approved_by ? userMap[s.approved_by] || '-' : '-'}</td>
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
          <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
            {draftItems.map((item, index) => (
              <div key={`draft-${index}`} className="border rounded-lg p-3 bg-gray-50/50 space-y-2">
                <input
                  type="text"
                  value={item.product_name_manual}
                  onChange={(e) => updateDraftItem(index, { product_name_manual: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                  placeholder="ชื่อสินค้าตัวอย่าง"
                />
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
                <div>
                  <label className="block text-xs text-gray-500 mb-0.5">รูปถ่าย</label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0] || null
                      if (!file) return
                      const preview = URL.createObjectURL(file)
                      updateDraftItem(index, { image_file: file, image_preview: preview })
                      e.target.value = ''
                    }}
                    className="w-full text-xs"
                  />
                  {item.image_preview && (
                    <img src={item.image_preview} alt="" className="mt-2 w-20 h-20 object-cover rounded border" />
                  )}
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
                  <div className="text-gray-500 text-xs">ชื่อเรียกสินค้า</div>
                  <div className="font-medium">{viewing.sample_label || '-'}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">วันที่รับ</div>
                  <div className="font-medium">{viewing.received_at ? new Date(viewing.received_at).toLocaleString('th-TH') : '-'}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">จำนวนรายการ</div>
                  <div className="font-medium">{(viewing.inv_sample_items || []).length} รายการ</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">ผู้ทดสอบ</div>
                  <div className="font-medium">{viewing.testing_by_name || '-'}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">ผู้อนุมัติ</div>
                  <div className="font-medium">{viewing.approved_by ? userMap[viewing.approved_by] || '-' : '-'}</div>
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
                      const imgUrl = item.image_url || (prod ? getPublicUrl('product-images', prod.product_code) : '')
                      const displayName = prod
                        ? `${prod.product_code} - ${prod.product_name}`
                        : item.product_name_manual || '-'
                      const qtyValue = Number(item.qty)
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
                          <td className="px-3 py-2 text-right">{Number.isFinite(qtyValue) ? qtyValue.toLocaleString() : '-'}</td>
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
                    onClick={async () => {
                      const ok = await showConfirm({ title: 'เริ่มทดสอบ', message: 'ยืนยันเริ่มทดสอบสินค้าตัวอย่างนี้ ?', confirmText: 'เริ่มทดสอบ' })
                      if (!ok) return
                      setTestingByName(viewing.testing_by_name || '')
                      setStartTestOpen(true)
                    }}
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
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">ผลการทดสอบโดยรวม</label>
            <select
              value={testDecision}
              onChange={(e) => setTestDecision(e.target.value as 'approved' | 'rejected')}
              className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
            >
              <option value="approved">ผ่าน</option>
              <option value="rejected">ไม่ผ่าน</option>
            </select>
          </div>
          <div className="space-y-3 max-h-[40vh] overflow-y-auto">
            {testItemResults.map((item, idx) => (
              <div key={item.item_id} className="border rounded-lg p-3 bg-gray-50/50">
                <div className="font-medium text-sm mb-2">{item.name}</div>
                <input
                  type="text"
                  value={item.note}
                  onChange={(e) => setTestItemResults((prev) => prev.map((r, i) => i === idx ? { ...r, note: e.target.value } : r))}
                  className="w-full px-3 py-1.5 border rounded-lg text-sm"
                  placeholder="หมายเหตุ (ถ้ามี)"
                />
              </div>
            ))}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">หมายเหตุภาพรวม</label>
            <textarea value={testNote} onChange={(e) => setTestNote(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" rows={2} placeholder="ผลการทดสอบโดยรวม..." />
          </div>

          {testDecision === 'rejected' && (
            <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">เหตุผลที่ไม่ผ่าน (กรณีไม่ผ่าน)</label>
            <input type="text" value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="ระบุเหตุผล..." />
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setTestOpen(false)} className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium">ยกเลิก</button>
            <button
              onClick={handleSubmitTestResult}
              disabled={actionSaving}
              className={`px-5 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 ${
                testDecision === 'approved' ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-red-50 text-red-700 hover:bg-red-100'
              }`}
            >
              {actionSaving ? 'กำลังบันทึก...' : (testDecision === 'approved' ? 'ผ่านการทดสอบ' : 'ยืนยันไม่ผ่าน')}
            </button>
          </div>
        </div>
      </Modal>

      {/* Start Testing Modal */}
      <Modal open={startTestOpen} onClose={() => setStartTestOpen(false)} closeOnBackdropClick={false} contentClassName="max-w-lg">
        <div className="p-6 space-y-4">
          <h2 className="text-xl font-bold text-gray-900">เริ่มทดสอบสินค้า</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">ผู้ทดสอบ <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={testingByName}
              onChange={(e) => setTestingByName(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
              placeholder="ระบุชื่อผู้ทดสอบ"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setStartTestOpen(false)} className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium">ยกเลิก</button>
            <button
              onClick={handleConfirmStartTesting}
              disabled={actionSaving}
              className="px-5 py-2.5 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 text-sm font-semibold disabled:opacity-50"
            >
              {actionSaving ? 'กำลังบันทึก...' : 'ยืนยันเริ่มทดสอบ'}
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
              <select
                value={convertForm.productType}
                onChange={async (e) => {
                  const productType = e.target.value
                  setConvertForm((f) => ({ ...f, productType }))
                  const nextCode = await getNextProductCode(productType as 'FG' | 'RM')
                  setConvertForm((f) => ({ ...f, productCode: nextCode }))
                }}
                className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
              >
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
              <div className="flex gap-2">
                <select
                  value={convertForm.productCategory}
                  onChange={(e) => setConvertForm((f) => ({ ...f, productCategory: e.target.value }))}
                  className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
                >
                  <option value="">-- เลือกหมวดหมู่ --</option>
                  {sortedCategoryOptions.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setAddCategoryOpen(true)}
                  className="px-3 py-2 border rounded-lg text-xs hover:bg-gray-50"
                >
                  + เพิ่ม
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">ผู้จัดจำหน่าย</label>
              <div className="flex gap-2">
                <select
                  value={convertForm.sellerName}
                  onChange={(e) => setConvertForm((f) => ({ ...f, sellerName: e.target.value }))}
                  className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
                >
                  <option value="">-- เลือกผู้ขาย --</option>
                  {sellers.map((s) => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setAddSellerOpen(true)}
                  className="px-3 py-2 border rounded-lg text-xs hover:bg-gray-50"
                >
                  + เพิ่ม
                </button>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setConvertOpen(false)} className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium">ยกเลิก</button>
            <button onClick={handleConvertToProduct} disabled={actionSaving} className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-semibold">
              {actionSaving ? 'กำลังบันทึก...' : 'สร้างสินค้าและนำเข้า'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Add Category Modal */}
      <Modal open={addCategoryOpen} onClose={() => setAddCategoryOpen(false)} closeOnBackdropClick={false} contentClassName="max-w-md">
        <div className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-gray-900">เพิ่มหมวดหมู่</h2>
          <div>
            <label className="block text-xs text-gray-500 mb-1">ชื่อหมวดหมู่ใหม่</label>
            <input
              type="text"
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
              placeholder="ระบุชื่อหมวดหมู่"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setAddCategoryOpen(false)} className="px-4 py-2 border rounded-lg hover:bg-gray-50 text-sm">ยกเลิก</button>
            <button onClick={handleAddCategory} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-semibold">บันทึก</button>
          </div>
        </div>
      </Modal>

      {/* Add Seller Modal */}
      <Modal open={addSellerOpen} onClose={() => setAddSellerOpen(false)} closeOnBackdropClick={false} contentClassName="max-w-md">
        <div className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-gray-900">เพิ่มผู้ขาย</h2>
          <div>
            <label className="block text-xs text-gray-500 mb-1">ชื่อผู้ขาย <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={newSellerName}
              onChange={(e) => setNewSellerName(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
              placeholder="ระบุชื่อผู้ขาย"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">ชื่อจีน (ถ้ามี)</label>
            <input
              type="text"
              value={newSellerNameCn}
              onChange={(e) => setNewSellerNameCn(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
              placeholder="ระบุชื่อจีน"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setAddSellerOpen(false)} className="px-4 py-2 border rounded-lg hover:bg-gray-50 text-sm">ยกเลิก</button>
            <button onClick={handleAddSeller} disabled={sellerSaving} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-semibold disabled:opacity-50">
              {sellerSaving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
        </div>
      </Modal>
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
