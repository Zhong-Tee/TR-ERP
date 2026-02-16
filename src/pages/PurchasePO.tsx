import { useEffect, useMemo, useState } from 'react'
import Modal from '../components/ui/Modal'
import { useAuthContext } from '../contexts/AuthContext'
import type { InventoryPO, InventoryPR, InventoryPRItem } from '../types'
import {
  loadPOList,
  loadPODetail,
  loadApprovedPRsWithoutPO,
  convertPRtoPO,
  markPOOrdered,
  updatePOShipping,
  loadSellers,
} from '../lib/purchaseApi'
import { getPublicUrl } from '../lib/qcApi'

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  open: { label: 'เปิด', color: 'bg-blue-100 text-blue-800' },
  ordered: { label: 'สั่งซื้อแล้ว', color: 'bg-emerald-100 text-emerald-800' },
  partial: { label: 'รับบางส่วน', color: 'bg-yellow-100 text-yellow-800' },
  received: { label: 'รับครบ', color: 'bg-green-100 text-green-800' },
  closed: { label: 'ปิด', color: 'bg-gray-200 text-gray-700' },
}

const SHIPPING_METHODS = [
  { value: 'sea', label: 'ทางเรือ' },
  { value: 'air', label: 'ทางอากาศ' },
  { value: 'express', label: 'ด่วน (Express)' },
  { value: 'land', label: 'ทางบก' },
  { value: 'other', label: 'อื่นๆ' },
]

interface PriceEdit {
  product_id: string
  unit_price: number | null
}

export default function PurchasePO() {
  const { user } = useAuthContext()

  // list
  const [pos, setPos] = useState<InventoryPO[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')

  // create from PR
  const [availablePRs, setAvailablePRs] = useState<InventoryPR[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedPR, setSelectedPR] = useState<InventoryPR | null>(null)
  const [sellers, setSellers] = useState<{ id: string; name: string; name_cn: string | null }[]>([])
  const [selectedSellerId, setSelectedSellerId] = useState('')
  const [selectedSellerName, setSelectedSellerName] = useState('')
  const [priceEdits, setPriceEdits] = useState<PriceEdit[]>([])
  const [poNote, setPoNote] = useState('')
  const [saving, setSaving] = useState(false)

  // detail
  const [viewing, setViewing] = useState<InventoryPO | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // shipping modal
  const [shippingOpen, setShippingOpen] = useState(false)
  const [shippingPO, setShippingPO] = useState<InventoryPO | null>(null)
  const [shippingForm, setShippingForm] = useState({
    method: '',
    weight: '',
    cbm: '',
    cost: '',
    currency: 'CNY',
    exchangeRate: '',
  })
  const [shippingSaving, setShippingSaving] = useState(false)

  const [updating, setUpdating] = useState<string | null>(null)

  useEffect(() => { loadAll() }, [statusFilter, search])

  async function loadAll() {
    setLoading(true)
    try {
      const [poData, prData, sellerData] = await Promise.all([
        loadPOList({ status: statusFilter, search }),
        availablePRs.length ? Promise.resolve(availablePRs) : loadApprovedPRsWithoutPO(),
        sellers.length ? Promise.resolve(sellers) : loadSellers(),
      ])
      setPos(poData)
      if (!availablePRs.length) setAvailablePRs(prData)
      if (!sellers.length) setSellers(sellerData as any)
    } catch (e) {
      console.error('Load PO failed:', e)
    } finally {
      setLoading(false)
    }
  }

  function openCreateFromPR(pr: InventoryPR) {
    setSelectedPR(pr)
    const items = (pr.inv_pr_items || []) as any[]
    setPriceEdits(items.map((i: any) => ({
      product_id: i.product_id,
      unit_price: i.estimated_price ?? null,
    })))
    setSelectedSellerId('')
    setSelectedSellerName('')
    setPoNote('')
    setCreateOpen(true)
  }

  function onSellerChange(sellerId: string) {
    setSelectedSellerId(sellerId)
    const seller = sellers.find((s) => s.id === sellerId)
    setSelectedSellerName(seller ? seller.name : '')
  }

  function updatePrice(productId: string, price: number | null) {
    setPriceEdits((prev) =>
      prev.map((p) => (p.product_id === productId ? { ...p, unit_price: price } : p))
    )
  }

  const totalAmount = useMemo(() => {
    if (!selectedPR) return 0
    const items = (selectedPR.inv_pr_items || []) as any[]
    return items.reduce((sum: number, item: any) => {
      const pe = priceEdits.find((p) => p.product_id === item.product_id)
      const price = pe?.unit_price ?? 0
      return sum + (price * Number(item.qty))
    }, 0)
  }, [selectedPR, priceEdits])

  async function handleCreate() {
    if (!selectedPR) return
    setSaving(true)
    try {
      await convertPRtoPO({
        prId: selectedPR.id,
        supplierId: selectedSellerId || null,
        supplierName: selectedSellerName || null,
        prices: priceEdits.filter((p) => p.unit_price != null).map((p) => ({
          product_id: p.product_id,
          unit_price: p.unit_price!,
        })),
        note: poNote.trim() || undefined,
      })
      setCreateOpen(false)
      setSelectedPR(null)
      setAvailablePRs([])
      await loadAll()
    } catch (e: any) {
      alert('สร้าง PO ไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  async function handleMarkOrdered(po: InventoryPO) {
    setUpdating(po.id)
    try {
      await markPOOrdered(po.id, user?.id || '')
      await loadAll()
    } catch (e: any) {
      alert('ไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setUpdating(null)
    }
  }

  async function openDetail(po: InventoryPO) {
    setViewing(po)
    setDetailLoading(true)
    try {
      const detail = await loadPODetail(po.id)
      setViewing(detail)
    } catch (e) {
      console.error(e)
    } finally {
      setDetailLoading(false)
    }
  }

  function openShipping(po: InventoryPO) {
    setShippingPO(po)
    setShippingForm({
      method: po.intl_shipping_method || '',
      weight: po.intl_shipping_weight ? String(po.intl_shipping_weight) : '',
      cbm: po.intl_shipping_cbm ? String(po.intl_shipping_cbm) : '',
      cost: po.intl_shipping_cost ? String(po.intl_shipping_cost) : '',
      currency: po.intl_shipping_currency || 'CNY',
      exchangeRate: po.intl_exchange_rate ? String(po.intl_exchange_rate) : '',
    })
    setShippingOpen(true)
  }

  const shippingCostTHB = useMemo(() => {
    const cost = Number(shippingForm.cost) || 0
    const rate = Number(shippingForm.exchangeRate) || 0
    return cost * rate
  }, [shippingForm.cost, shippingForm.exchangeRate])

  async function handleSaveShipping() {
    if (!shippingPO) return
    setShippingSaving(true)
    try {
      const costThb = shippingCostTHB
      const total = Number(shippingPO.total_amount || 0)
      await updatePOShipping(shippingPO.id, {
        intl_shipping_method: shippingForm.method || undefined,
        intl_shipping_weight: shippingForm.weight ? Number(shippingForm.weight) : undefined,
        intl_shipping_cbm: shippingForm.cbm ? Number(shippingForm.cbm) : undefined,
        intl_shipping_cost: shippingForm.cost ? Number(shippingForm.cost) : undefined,
        intl_shipping_currency: shippingForm.currency,
        intl_exchange_rate: shippingForm.exchangeRate ? Number(shippingForm.exchangeRate) : undefined,
        intl_shipping_cost_thb: costThb || undefined,
        grand_total: total + costThb || undefined,
      })
      setShippingOpen(false)
      if (viewing && viewing.id === shippingPO.id) {
        const detail = await loadPODetail(shippingPO.id)
        setViewing(detail)
      }
      await loadAll()
    } catch (e: any) {
      alert('บันทึกไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setShippingSaving(false)
    }
  }

  const statusTabs = [
    { key: 'all', label: 'ทั้งหมด' },
    { key: 'open', label: 'เปิด' },
    { key: 'ordered', label: 'สั่งซื้อแล้ว' },
    { key: 'partial', label: 'รับบางส่วน' },
    { key: 'received', label: 'รับครบ' },
  ]

  return (
    <div className="space-y-4 mt-12">
      {/* ── Approved PRs waiting for PO ── */}
      {availablePRs.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-blue-800 mb-3">PR ที่อนุมัติแล้ว รอสร้าง PO ({availablePRs.length})</h3>
          <div className="flex flex-wrap gap-2">
            {availablePRs.map((pr) => (
              <button
                key={pr.id}
                onClick={() => openCreateFromPR(pr)}
                className="px-3 py-1.5 bg-white border border-blue-300 rounded-lg text-sm text-blue-700 hover:bg-blue-100 font-medium transition-colors"
              >
                {pr.pr_no} → สร้าง PO
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Filter Bar ── */}
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
              placeholder="ค้นหาเลขที่ PO..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
            />
          </div>
        </div>
      </div>

      {/* ── PO List ── */}
      <div className="bg-white rounded-xl shadow-sm border">
        {loading ? (
          <div className="flex justify-center items-center py-16">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500" />
          </div>
        ) : pos.length === 0 ? (
          <div className="text-center py-16 text-gray-400">ไม่พบรายการ PO</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">เลขที่ PO</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">PR</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">ผู้จัดจำหน่าย</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">สถานะ</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">ยอดรวม</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">วันที่สั่ง</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">การจัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pos.map((po) => {
                  const st = STATUS_MAP[po.status] || { label: po.status, color: 'bg-gray-100 text-gray-700' }
                  return (
                    <tr key={po.id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">{po.po_no}</td>
                      <td className="px-4 py-3 text-gray-600">{(po as any).inv_pr?.pr_no || '-'}</td>
                      <td className="px-4 py-3 text-gray-600">{po.supplier_name || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${st.color}`}>
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {po.grand_total != null ? Number(po.grand_total).toLocaleString(undefined, { minimumFractionDigits: 2 }) : po.total_amount != null ? Number(po.total_amount).toLocaleString(undefined, { minimumFractionDigits: 2 }) : '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {po.ordered_at ? new Date(po.ordered_at).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex gap-1.5 justify-end">
                          <button
                            onClick={() => openDetail(po)}
                            className="px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 text-xs font-semibold"
                          >
                            ดู
                          </button>
                          {po.status === 'open' && (
                            <>
                              <button
                                onClick={() => openShipping(po)}
                                className="px-3 py-1.5 bg-purple-50 text-purple-700 rounded-lg hover:bg-purple-100 text-xs font-semibold"
                              >
                                ค่าขนส่ง
                              </button>
                              <button
                                onClick={() => handleMarkOrdered(po)}
                                disabled={updating === po.id}
                                className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-xs font-semibold disabled:opacity-50"
                              >
                                สั่งซื้อแล้ว
                              </button>
                            </>
                          )}
                          {(po.status === 'ordered' || po.status === 'received') && po.intl_shipping_cost == null && (
                            <button
                              onClick={() => openShipping(po)}
                              className="px-3 py-1.5 bg-purple-50 text-purple-700 rounded-lg hover:bg-purple-100 text-xs font-semibold"
                            >
                              + ค่าขนส่ง
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Create PO from PR Modal ── */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} closeOnBackdropClick={false} contentClassName="max-w-4xl">
        <div className="p-6 space-y-5">
          <h2 className="text-xl font-bold text-gray-900">สร้างใบสั่งซื้อ (PO) จาก PR</h2>

          {selectedPR && (
            <>
              <div className="bg-blue-50 rounded-lg p-3 text-sm">
                <span className="font-semibold text-blue-800">PR: {selectedPR.pr_no}</span>
              </div>

              {/* supplier selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">ผู้จัดจำหน่าย</label>
                <select
                  value={selectedSellerId}
                  onChange={(e) => onSellerChange(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
                >
                  <option value="">-- เลือกผู้จัดจำหน่าย --</option>
                  {sellers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} {s.name_cn ? `(${s.name_cn})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* items with price edit */}
              <div className="overflow-x-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b">
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600">สินค้า</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600 w-24">จำนวน</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600 w-32">ราคาต่อหน่วย</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600 w-32">รวม</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {((selectedPR.inv_pr_items || []) as any[]).map((item: any) => {
                      const pe = priceEdits.find((p) => p.product_id === item.product_id)
                      const price = pe?.unit_price ?? 0
                      const subtotal = price * Number(item.qty)
                      const prod = item.pr_products
                      return (
                        <tr key={item.id || item.product_id}>
                          <td className="px-3 py-2">
                            <div className="font-medium">{prod?.product_code} - {prod?.product_name}</div>
                          </td>
                          <td className="px-3 py-2 text-right">{Number(item.qty).toLocaleString()} {item.unit || ''}</td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              min={0}
                              step={0.01}
                              value={pe?.unit_price ?? ''}
                              onChange={(e) => updatePrice(item.product_id, e.target.value ? Number(e.target.value) : null)}
                              className="w-full px-2 py-1.5 border rounded-lg text-sm text-right"
                              placeholder="0.00"
                            />
                          </td>
                          <td className="px-3 py-2 text-right font-medium">
                            {subtotal ? subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '-'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gray-50 border-t">
                      <td colSpan={3} className="px-3 py-2.5 text-right font-semibold text-gray-700">ยอดรวม</td>
                      <td className="px-3 py-2.5 text-right font-bold text-emerald-700 text-base">
                        {totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })} บาท
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* note */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">หมายเหตุ PO</label>
                <textarea
                  value={poNote}
                  onChange={(e) => setPoNote(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                  rows={2}
                  placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2 border-t">
                <button onClick={() => setCreateOpen(false)} className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium">
                  ยกเลิก
                </button>
                <button onClick={handleCreate} disabled={saving} className="px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 text-sm font-semibold">
                  {saving ? 'กำลังสร้าง...' : 'สร้าง PO'}
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* ── Detail Modal ── */}
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
                  <h2 className="text-xl font-bold text-gray-900">รายละเอียด PO</h2>
                  <p className="text-sm text-gray-500 mt-1">
                    เลขที่: <span className="font-semibold text-gray-800">{viewing.po_no}</span>
                    {(viewing as any).inv_pr?.pr_no && (
                      <span className="ml-3">PR: <span className="font-semibold">{(viewing as any).inv_pr.pr_no}</span></span>
                    )}
                  </p>
                </div>
                <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${(STATUS_MAP[viewing.status] || { color: 'bg-gray-100 text-gray-700' }).color}`}>
                  {(STATUS_MAP[viewing.status] || { label: viewing.status }).label}
                </span>
              </div>

              {/* meta */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">ผู้จัดจำหน่าย</div>
                  <div className="font-medium">{viewing.supplier_name || '-'}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">ยอดรวมสินค้า</div>
                  <div className="font-medium">{viewing.total_amount != null ? Number(viewing.total_amount).toLocaleString(undefined, { minimumFractionDigits: 2 }) : '-'} บาท</div>
                </div>
                {viewing.intl_shipping_cost_thb != null && (
                  <div className="bg-purple-50 rounded-lg p-3">
                    <div className="text-purple-600 text-xs">ค่าขนส่งต่างประเทศ</div>
                    <div className="font-medium text-purple-800">{Number(viewing.intl_shipping_cost_thb).toLocaleString(undefined, { minimumFractionDigits: 2 })} บาท</div>
                  </div>
                )}
                <div className="bg-emerald-50 rounded-lg p-3">
                  <div className="text-emerald-600 text-xs">ยอดรวมทั้งหมด</div>
                  <div className="font-bold text-emerald-800">{viewing.grand_total != null ? Number(viewing.grand_total).toLocaleString(undefined, { minimumFractionDigits: 2 }) : viewing.total_amount != null ? Number(viewing.total_amount).toLocaleString(undefined, { minimumFractionDigits: 2 }) : '-'} บาท</div>
                </div>
              </div>

              {/* shipping details */}
              {viewing.intl_shipping_method && (
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 text-sm">
                  <div className="font-semibold text-purple-800 mb-1">ค่าขนส่งต่างประเทศ</div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                    <div>วิธี: {SHIPPING_METHODS.find((m) => m.value === viewing.intl_shipping_method)?.label || viewing.intl_shipping_method}</div>
                    {viewing.intl_shipping_weight && <div>น้ำหนัก: {viewing.intl_shipping_weight} กก.</div>}
                    {viewing.intl_shipping_cbm && <div>CBM: {viewing.intl_shipping_cbm}</div>}
                    {viewing.intl_shipping_cost && <div>ค่าขนส่ง: {Number(viewing.intl_shipping_cost).toLocaleString()} {viewing.intl_shipping_currency}</div>}
                    {viewing.intl_exchange_rate && <div>อัตราแลกเปลี่ยน: {viewing.intl_exchange_rate}</div>}
                  </div>
                </div>
              )}

              {/* PO note */}
              {viewing.note && (
                <div className="bg-blue-50 rounded-lg p-3 text-sm">
                  <span className="text-blue-600 font-medium">หมายเหตุ:</span> {viewing.note}
                </div>
              )}

              {/* items */}
              <div className="overflow-x-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b">
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600 w-14">รูป</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600">สินค้า</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">จำนวน</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">ราคาต่อหน่วย</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">รวม</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600">หมายเหตุ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(viewing.inv_po_items || []).map((item: any) => {
                      const prod = item.pr_products
                      const imgUrl = prod ? getPublicUrl('product-images', prod.product_code) : ''
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
                          <td className="px-3 py-2">
                            <div className="font-medium">{prod?.product_code} - {prod?.product_name}</div>
                          </td>
                          <td className="px-3 py-2 text-right">{Number(item.qty).toLocaleString()} {item.unit || ''}</td>
                          <td className="px-3 py-2 text-right">{item.unit_price != null ? Number(item.unit_price).toLocaleString(undefined, { minimumFractionDigits: 2 }) : '-'}</td>
                          <td className="px-3 py-2 text-right font-medium">{item.subtotal != null ? Number(item.subtotal).toLocaleString(undefined, { minimumFractionDigits: 2 }) : '-'}</td>
                          <td className="px-3 py-2 text-gray-500 max-w-[160px] truncate">{item.note || '-'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t">
                <button onClick={() => setViewing(null)} className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium">
                  ปิด
                </button>
              </div>
            </>
          ) : null}
        </div>
      </Modal>

      {/* ── Shipping Cost Modal ── */}
      <Modal open={shippingOpen} onClose={() => setShippingOpen(false)} contentClassName="max-w-lg">
        <div className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-gray-900">ค่าขนส่งต่างประเทศ</h2>
          {shippingPO && (
            <p className="text-sm text-gray-500">PO: <span className="font-semibold">{shippingPO.po_no}</span></p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">วิธีขนส่ง</label>
              <select
                value={shippingForm.method}
                onChange={(e) => setShippingForm((f) => ({ ...f, method: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
              >
                <option value="">-- เลือก --</option>
                {SHIPPING_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">สกุลเงิน</label>
              <select
                value={shippingForm.currency}
                onChange={(e) => setShippingForm((f) => ({ ...f, currency: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
              >
                <option value="CNY">CNY (หยวน)</option>
                <option value="USD">USD (ดอลลาร์)</option>
                <option value="EUR">EUR (ยูโร)</option>
                <option value="JPY">JPY (เยน)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">น้ำหนัก (กก.)</label>
              <input
                type="number"
                min={0}
                step={0.001}
                value={shippingForm.weight}
                onChange={(e) => setShippingForm((f) => ({ ...f, weight: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">CBM (ลบ.ม.)</label>
              <input
                type="number"
                min={0}
                step={0.0001}
                value={shippingForm.cbm}
                onChange={(e) => setShippingForm((f) => ({ ...f, cbm: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">ค่าขนส่ง ({shippingForm.currency})</label>
              <input
                type="number"
                min={0}
                step={0.01}
                value={shippingForm.cost}
                onChange={(e) => setShippingForm((f) => ({ ...f, cost: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">อัตราแลกเปลี่ยน (→ บาท)</label>
              <input
                type="number"
                min={0}
                step={0.0001}
                value={shippingForm.exchangeRate}
                onChange={(e) => setShippingForm((f) => ({ ...f, exchangeRate: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
          </div>

          {shippingCostTHB > 0 && (
            <div className="bg-purple-50 rounded-lg p-3 text-sm">
              <span className="text-purple-600">ค่าขนส่งเป็นบาท:</span>{' '}
              <span className="font-bold text-purple-800">{shippingCostTHB.toLocaleString(undefined, { minimumFractionDigits: 2 })} บาท</span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setShippingOpen(false)} className="px-4 py-2 border rounded-lg hover:bg-gray-50 text-sm">
              ยกเลิก
            </button>
            <button onClick={handleSaveShipping} disabled={shippingSaving} className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 text-sm font-semibold">
              {shippingSaving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
