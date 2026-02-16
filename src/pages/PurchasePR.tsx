import { useCallback, useEffect, useMemo, useState } from 'react'
import Modal from '../components/ui/Modal'
import { useAuthContext } from '../contexts/AuthContext'
import type { InventoryPR, InventoryPRItem, Product } from '../types'
import {
  loadPRList,
  loadPRDetail,
  createPR,
  approvePR,
  rejectPR,
  loadProductsWithLastPrice,
} from '../lib/purchaseApi'
import { getPublicUrl } from '../lib/qcApi'

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  pending: { label: 'รออนุมัติ', color: 'bg-yellow-100 text-yellow-800' },
  approved: { label: 'อนุมัติแล้ว', color: 'bg-green-100 text-green-800' },
  rejected: { label: 'ไม่อนุมัติ', color: 'bg-red-100 text-red-800' },
}

const APPROVE_ROLES = ['superadmin', 'admin', 'account']

interface DraftItem {
  product_id: string
  qty: number
  unit: string
  estimated_price: number | null
  note: string
}

export default function PurchasePR() {
  const { user } = useAuthContext()

  // list state
  const [prs, setPrs] = useState<(InventoryPR & { _itemCount?: number })[]>([])
  const [products, setProducts] = useState<(Product & { last_price?: number | null })[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')

  // create modal
  const [createOpen, setCreateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftItems, setDraftItems] = useState<DraftItem[]>([{ product_id: '', qty: 1, unit: 'ชิ้น', estimated_price: null, note: '' }])
  const [note, setNote] = useState('')
  const [productSearch, setProductSearch] = useState('')

  // detail modal
  const [viewing, setViewing] = useState<InventoryPR | null>(null)
  const [viewItems, setViewItems] = useState<InventoryPRItem[]>([])
  const [detailLoading, setDetailLoading] = useState(false)

  // approve/reject
  const [updating, setUpdating] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  const canApprove = APPROVE_ROLES.includes(user?.role || '')

  const handleCreateFromTopBar = useCallback(() => setCreateOpen(true), [])

  useEffect(() => {
    window.addEventListener('purchase-pr-create', handleCreateFromTopBar)
    return () => window.removeEventListener('purchase-pr-create', handleCreateFromTopBar)
  }, [handleCreateFromTopBar])

  useEffect(() => {
    loadAll()
  }, [statusFilter, search])

  async function loadAll() {
    setLoading(true)
    try {
      const [prData, prodData] = await Promise.all([
        loadPRList({ status: statusFilter, search }),
        products.length ? Promise.resolve(products) : loadProductsWithLastPrice(),
      ])
      setPrs(prData.map((pr: any) => ({
        ...pr,
        _itemCount: pr.inv_pr_items?.length ?? 0,
      })))
      if (!products.length) setProducts(prodData as any)
    } catch (e) {
      console.error('Load PR failed:', e)
    } finally {
      setLoading(false)
    }
  }

  const productMap = useMemo(() => {
    const m = new Map<string, Product & { last_price?: number | null }>()
    products.forEach((p) => m.set(p.id, p))
    return m
  }, [products])

  const filteredProducts = useMemo(() => {
    if (!productSearch.trim()) return products
    const s = productSearch.toLowerCase()
    return products.filter(
      (p) =>
        p.product_code.toLowerCase().includes(s) ||
        p.product_name.toLowerCase().includes(s) ||
        (p.product_name_cn && p.product_name_cn.toLowerCase().includes(s)) ||
        (p.seller_name && p.seller_name.toLowerCase().includes(s))
    )
  }, [products, productSearch])

  /* ── Draft item helpers ── */
  function addDraftItem() {
    setDraftItems((prev) => [...prev, { product_id: '', qty: 1, unit: 'ชิ้น', estimated_price: null, note: '' }])
  }
  function updateDraftItem(i: number, patch: Partial<DraftItem>) {
    setDraftItems((prev) => prev.map((item, idx) => (idx === i ? { ...item, ...patch } : item)))
  }
  function removeDraftItem(i: number) {
    setDraftItems((prev) => prev.filter((_, idx) => idx !== i))
  }

  function onSelectProduct(index: number, productId: string) {
    const prod = productMap.get(productId)
    updateDraftItem(index, {
      product_id: productId,
      estimated_price: prod?.last_price ?? prod?.unit_cost ?? null,
    })
  }

  /* ── Create PR ── */
  async function handleCreatePR() {
    const valid = draftItems.filter((i) => i.product_id && i.qty > 0)
    if (!valid.length) { alert('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ'); return }
    setSaving(true)
    try {
      await createPR({
        items: valid.map((i) => ({
          product_id: i.product_id,
          qty: i.qty,
          unit: i.unit,
          estimated_price: i.estimated_price,
          note: i.note || undefined,
        })),
        note: note.trim() || undefined,
        userId: user?.id,
      })
      setDraftItems([{ product_id: '', qty: 1, unit: 'ชิ้น', estimated_price: null, note: '' }])
      setNote('')
      setCreateOpen(false)
      await loadAll()
    } catch (e: any) {
      alert('สร้าง PR ไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  /* ── View Detail ── */
  async function openDetail(pr: InventoryPR) {
    setViewing(pr)
    setDetailLoading(true)
    try {
      const detail = await loadPRDetail(pr.id)
      setViewing(detail)
      setViewItems(detail.inv_pr_items || [])
    } catch (e) {
      console.error(e)
    } finally {
      setDetailLoading(false)
    }
  }

  /* ── Approve / Reject ── */
  async function handleApprove() {
    if (!viewing) return
    setUpdating(true)
    try {
      await approvePR(viewing.id, user?.id || '')
      setViewing(null)
      await loadAll()
    } catch (e: any) {
      alert('อนุมัติไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setUpdating(false)
    }
  }

  async function handleReject() {
    if (!viewing || !rejectReason.trim()) { alert('กรุณาระบุเหตุผล'); return }
    setUpdating(true)
    try {
      await rejectPR(viewing.id, user?.id || '', rejectReason.trim())
      setRejectOpen(false)
      setRejectReason('')
      setViewing(null)
      await loadAll()
    } catch (e: any) {
      alert('ปฏิเสธไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setUpdating(false)
    }
  }

  const statusTabs = [
    { key: 'all', label: 'ทั้งหมด' },
    { key: 'pending', label: 'รออนุมัติ' },
    { key: 'approved', label: 'อนุมัติแล้ว' },
    { key: 'rejected', label: 'ไม่อนุมัติ' },
  ]

  return (
    <div className="space-y-4 mt-12">
      {/* ── Filter Bar ── */}
      <div className="bg-white rounded-xl shadow-sm border p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* status tabs */}
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
          {/* search */}
          <div className="flex-1 min-w-[200px]">
            <input
              type="text"
              placeholder="ค้นหาเลขที่ PR..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
            />
          </div>
        </div>
      </div>

      {/* ── PR List ── */}
      <div className="bg-white rounded-xl shadow-sm border">
        {loading ? (
          <div className="flex justify-center items-center py-16">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500" />
          </div>
        ) : prs.length === 0 ? (
          <div className="text-center py-16 text-gray-400">ไม่พบรายการ PR</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">เลขที่ PR</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">สถานะ</th>
                  <th className="px-4 py-3 text-center font-semibold text-gray-600">รายการ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">วันที่ขอ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">หมายเหตุ</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">การจัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {prs.map((pr) => {
                  const st = STATUS_MAP[pr.status] || { label: pr.status, color: 'bg-gray-100 text-gray-700' }
                  return (
                    <tr key={pr.id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">{pr.pr_no}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${st.color}`}>
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center text-gray-600">{(pr as any)._itemCount || '-'}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {pr.requested_at ? new Date(pr.requested_at).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-500 max-w-[200px] truncate">{pr.note || '-'}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => openDetail(pr)}
                          className="px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 text-xs font-semibold transition-colors"
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

      {/* ── Create PR Modal ── */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} closeOnBackdropClick={false} contentClassName="max-w-4xl">
        <div className="p-6 space-y-5">
          <h2 className="text-xl font-bold text-gray-900">สร้างใบขอซื้อ (PR)</h2>

          {/* product search */}
          <div>
            <input
              type="text"
              placeholder="ค้นหาสินค้า... (รหัส, ชื่อ, ชื่อจีน, ผู้จัดจำหน่าย)"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
            />
          </div>

          {/* items */}
          <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
            {draftItems.map((item, index) => {
              const prod = item.product_id ? productMap.get(item.product_id) : null
              const imgUrl = prod ? getPublicUrl('product-images', prod.product_code) : ''
              return (
                <div key={`draft-${index}`} className="border rounded-lg p-3 bg-gray-50/50">
                  <div className="flex gap-3">
                    {/* product image */}
                    <div className="w-16 h-16 rounded-lg bg-gray-200 overflow-hidden flex-shrink-0">
                      {imgUrl ? (
                        <img src={imgUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">ไม่มีรูป</div>
                      )}
                    </div>

                    <div className="flex-1 space-y-2">
                      {/* product select */}
                      <select
                        value={item.product_id}
                        onChange={(e) => onSelectProduct(index, e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg bg-white text-sm"
                      >
                        <option value="">เลือกสินค้า</option>
                        {filteredProducts.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.product_code} - {p.product_name}
                            {p.seller_name ? ` (${p.seller_name})` : ''}
                          </option>
                        ))}
                      </select>

                      {/* product info */}
                      {prod && (
                        <div className="text-xs text-gray-500 flex flex-wrap gap-x-4">
                          {prod.product_name_cn && <span>ชื่อจีน: {prod.product_name_cn}</span>}
                          {prod.seller_name && <span>ผู้จัดจำหน่าย: {prod.seller_name}</span>}
                          {prod.product_category && <span>หมวด: {prod.product_category}</span>}
                          {prod.last_price != null && (
                            <span className="text-blue-600 font-medium">ราคาซื้อล่าสุด: {Number(prod.last_price).toLocaleString()} บาท</span>
                          )}
                        </div>
                      )}

                      {/* qty / unit / price */}
                      <div className="grid grid-cols-4 gap-2">
                        <div>
                          <label className="block text-xs text-gray-500 mb-0.5">จำนวน</label>
                          <input
                            type="number"
                            min={1}
                            value={item.qty}
                            onChange={(e) => updateDraftItem(index, { qty: Number(e.target.value) || 1 })}
                            className="w-full px-2 py-1.5 border rounded-lg text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-0.5">หน่วย</label>
                          <input
                            type="text"
                            value={item.unit}
                            onChange={(e) => updateDraftItem(index, { unit: e.target.value })}
                            className="w-full px-2 py-1.5 border rounded-lg text-sm"
                            placeholder="ชิ้น"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-0.5">ราคาประเมิน</label>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            value={item.estimated_price ?? ''}
                            onChange={(e) => updateDraftItem(index, { estimated_price: e.target.value ? Number(e.target.value) : null })}
                            className="w-full px-2 py-1.5 border rounded-lg text-sm"
                            placeholder="0.00"
                          />
                        </div>
                        <div className="flex items-end">
                          <button
                            onClick={() => removeDraftItem(index)}
                            disabled={draftItems.length === 1}
                            className="w-full px-2 py-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 text-sm disabled:opacity-30 transition-colors"
                          >
                            ลบ
                          </button>
                        </div>
                      </div>

                      {/* item note */}
                      <div>
                        <input
                          type="text"
                          value={item.note}
                          onChange={(e) => updateDraftItem(index, { note: e.target.value })}
                          className="w-full px-2 py-1.5 border rounded-lg text-sm"
                          placeholder="หมายเหตุรายการ (ถ้ามี)"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <button onClick={addDraftItem} className="px-4 py-2 border-2 border-dashed border-gray-300 rounded-lg hover:border-emerald-400 hover:text-emerald-600 text-sm text-gray-500 w-full transition-colors">
            + เพิ่มรายการสินค้า
          </button>

          {/* note */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">หมายเหตุ</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
              rows={2}
              placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)"
            />
          </div>

          {/* actions */}
          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setCreateOpen(false)} className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium">
              ยกเลิก
            </button>
            <button onClick={handleCreatePR} disabled={saving} className="px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 text-sm font-semibold transition-colors">
              {saving ? 'กำลังบันทึก...' : 'บันทึก PR'}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Detail Modal ── */}
      <Modal open={!!viewing} onClose={() => { setViewing(null); setRejectOpen(false) }} contentClassName="max-w-4xl">
        <div className="p-6 space-y-5">
          {detailLoading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500" />
            </div>
          ) : viewing ? (
            <>
              {/* header */}
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">รายละเอียด PR</h2>
                  <p className="text-sm text-gray-500 mt-1">
                    เลขที่: <span className="font-semibold text-gray-800">{viewing.pr_no}</span>
                  </p>
                </div>
                <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${(STATUS_MAP[viewing.status] || { color: 'bg-gray-100 text-gray-700' }).color}`}>
                  {(STATUS_MAP[viewing.status] || { label: viewing.status }).label}
                </span>
              </div>

              {/* meta */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">วันที่ขอ</div>
                  <div className="font-medium">{viewing.requested_at ? new Date(viewing.requested_at).toLocaleString('th-TH') : '-'}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">จำนวนรายการ</div>
                  <div className="font-medium">{viewItems.length} รายการ</div>
                </div>
                {viewing.approved_at && (
                  <div className="bg-green-50 rounded-lg p-3">
                    <div className="text-green-600 text-xs">วันที่อนุมัติ</div>
                    <div className="font-medium text-green-800">{new Date(viewing.approved_at).toLocaleString('th-TH')}</div>
                  </div>
                )}
                {viewing.rejected_at && (
                  <div className="bg-red-50 rounded-lg p-3">
                    <div className="text-red-600 text-xs">ไม่อนุมัติ</div>
                    <div className="font-medium text-red-800">{viewing.rejection_reason || '-'}</div>
                  </div>
                )}
              </div>

              {viewing.note && (
                <div className="bg-blue-50 rounded-lg p-3 text-sm">
                  <span className="text-blue-600 font-medium">หมายเหตุ:</span> {viewing.note}
                </div>
              )}

              {/* items table */}
              <div className="overflow-x-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b">
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600 w-14">รูป</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600">สินค้า</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">จำนวน</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">ราคาซื้อล่าสุด</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">ราคาประเมิน</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600">หมายเหตุ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {viewItems.map((item: any) => {
                      const prod = item.pr_products
                      const imgUrl = prod ? getPublicUrl('product-images', prod.product_code) : ''
                      return (
                        <tr key={item.id} className="hover:bg-gray-50/50">
                          <td className="px-3 py-2">
                            <div className="w-10 h-10 rounded bg-gray-200 overflow-hidden">
                              {imgUrl ? (
                                <img src={imgUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-gray-400 text-[10px]">-</div>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-medium text-gray-900">{prod?.product_code} - {prod?.product_name}</div>
                            <div className="text-xs text-gray-500 flex gap-3 mt-0.5">
                              {prod?.product_name_cn && <span>{prod.product_name_cn}</span>}
                              {prod?.seller_name && <span>ผู้จัดจำหน่าย: {prod.seller_name}</span>}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right font-medium">
                            {Number(item.qty).toLocaleString()} {item.unit || ''}
                          </td>
                          <td className="px-3 py-2 text-right text-blue-600">
                            {item.last_purchase_price != null ? Number(item.last_purchase_price).toLocaleString(undefined, { minimumFractionDigits: 2 }) : '-'}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {item.estimated_price != null ? Number(item.estimated_price).toLocaleString(undefined, { minimumFractionDigits: 2 }) : '-'}
                          </td>
                          <td className="px-3 py-2 text-gray-500 max-w-[160px] truncate">
                            {item.note || '-'}
                          </td>
                        </tr>
                      )
                    })}
                    {!viewItems.length && (
                      <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">ไม่มีรายการ</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* actions */}
              <div className="flex justify-end gap-3 pt-3 border-t">
                {canApprove && viewing.status === 'pending' && !rejectOpen && (
                  <>
                    <button
                      onClick={() => setRejectOpen(true)}
                      disabled={updating}
                      className="px-5 py-2.5 bg-red-50 text-red-700 rounded-lg hover:bg-red-100 text-sm font-semibold disabled:opacity-50 transition-colors"
                    >
                      ไม่อนุมัติ
                    </button>
                    <button
                      onClick={handleApprove}
                      disabled={updating}
                      className="px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-semibold disabled:opacity-50 transition-colors"
                    >
                      {updating ? 'กำลังดำเนินการ...' : 'อนุมัติ'}
                    </button>
                  </>
                )}
                {rejectOpen && (
                  <div className="flex-1 flex gap-2 items-end">
                    <div className="flex-1">
                      <label className="block text-xs text-gray-500 mb-1">เหตุผลที่ไม่อนุมัติ</label>
                      <input
                        type="text"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg text-sm"
                        placeholder="ระบุเหตุผล..."
                        autoFocus
                      />
                    </div>
                    <button
                      onClick={() => { setRejectOpen(false); setRejectReason('') }}
                      className="px-3 py-2 border rounded-lg text-sm hover:bg-gray-50"
                    >
                      ยกเลิก
                    </button>
                    <button
                      onClick={handleReject}
                      disabled={updating}
                      className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-semibold disabled:opacity-50"
                    >
                      ยืนยัน
                    </button>
                  </div>
                )}
                <button
                  onClick={() => { setViewing(null); setRejectOpen(false) }}
                  className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium"
                >
                  ปิด
                </button>
              </div>
            </>
          ) : null}
        </div>
      </Modal>
    </div>
  )
}
