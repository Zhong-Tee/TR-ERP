import { useEffect, useState } from 'react'
import Modal from '../components/ui/Modal'
import { useAuthContext } from '../contexts/AuthContext'
import type { InventoryGR, InventoryPO } from '../types'
import {
  loadGRList,
  loadGRDetail,
  loadOrderedPOsWithoutGR,
  loadPOItemsForGR,
  receiveGR,
} from '../lib/purchaseApi'
import { getPublicUrl } from '../lib/qcApi'

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  pending: { label: 'รอรับ', color: 'bg-yellow-100 text-yellow-800' },
  partial: { label: 'รับบางส่วน', color: 'bg-orange-100 text-orange-800' },
  received: { label: 'รับครบ', color: 'bg-green-100 text-green-800' },
}

interface ReceiveItem {
  product_id: string
  product_code: string
  product_name: string
  qty_ordered: number
  qty_received: number
  shortage_note: string
}

export default function PurchaseGR() {
  const { user } = useAuthContext()

  // list
  const [grs, setGrs] = useState<InventoryGR[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')

  // POs waiting for GR
  const [availablePOs, setAvailablePOs] = useState<InventoryPO[]>([])

  // receive modal
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [selectedPO, setSelectedPO] = useState<InventoryPO | null>(null)
  const [receiveItems, setReceiveItems] = useState<ReceiveItem[]>([])
  const [domCompany, setDomCompany] = useState('')
  const [domCost, setDomCost] = useState('')
  const [grNote, setGrNote] = useState('')
  const [shortageNote, setShortageNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [shippingExpanded, setShippingExpanded] = useState(false)

  // detail modal
  const [viewing, setViewing] = useState<InventoryGR | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => { loadAll() }, [statusFilter, search])

  async function loadAll() {
    setLoading(true)
    try {
      const [grData, poData] = await Promise.all([
        loadGRList({ status: statusFilter, search }),
        loadOrderedPOsWithoutGR(),
      ])
      setGrs(grData)
      setAvailablePOs(poData)
    } catch (e) {
      console.error('Load GR failed:', e)
    } finally {
      setLoading(false)
    }
  }

  async function openReceive(po: InventoryPO) {
    setSelectedPO(po)
    setDomCompany('')
    setDomCost('')
    setGrNote('')
    setShortageNote('')
    setShippingExpanded(false)

    try {
      const poItems = await loadPOItemsForGR(po.id)
      setReceiveItems(poItems.map((item: any) => ({
        product_id: item.product_id,
        product_code: item.pr_products?.product_code || '',
        product_name: item.pr_products?.product_name || '',
        qty_ordered: Number(item.qty),
        qty_received: Number(item.qty),
        shortage_note: '',
      })))
      setReceiveOpen(true)
    } catch (e) {
      console.error(e)
      alert('โหลดรายการ PO ไม่สำเร็จ')
    }
  }

  function updateReceiveItem(index: number, patch: Partial<ReceiveItem>) {
    setReceiveItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, ...patch } : item))
    )
  }

  const totalReceived = receiveItems.reduce((s, i) => s + i.qty_received, 0)
  const totalOrdered = receiveItems.reduce((s, i) => s + i.qty_ordered, 0)
  const hasShortage = receiveItems.some((i) => i.qty_received < i.qty_ordered)
  const costPerPiece = totalReceived > 0 && Number(domCost) > 0 ? Number(domCost) / totalReceived : 0

  async function handleReceive() {
    if (!selectedPO) return
    if (receiveItems.some((i) => i.qty_received < 0)) {
      alert('จำนวนรับไม่สามารถติดลบได้')
      return
    }
    setSaving(true)
    try {
      await receiveGR({
        poId: selectedPO.id,
        items: receiveItems.map((i) => ({
          product_id: i.product_id,
          qty_received: i.qty_received,
          qty_ordered: i.qty_ordered,
          shortage_note: i.shortage_note || undefined,
        })),
        shipping: {
          dom_shipping_company: domCompany || undefined,
          dom_shipping_cost: domCost ? Number(domCost) : undefined,
          note: grNote || undefined,
          shortage_note: shortageNote || undefined,
        },
        userId: user?.id,
      })
      setReceiveOpen(false)
      setSelectedPO(null)
      await loadAll()
    } catch (e: any) {
      alert('รับเข้าคลังไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  async function openDetail(gr: InventoryGR) {
    setViewing(gr)
    setDetailLoading(true)
    try {
      const detail = await loadGRDetail(gr.id)
      setViewing(detail)
    } catch (e) {
      console.error(e)
    } finally {
      setDetailLoading(false)
    }
  }

  const statusTabs = [
    { key: 'all', label: 'ทั้งหมด' },
    { key: 'partial', label: 'รับบางส่วน' },
    { key: 'received', label: 'รับครบ' },
  ]

  return (
    <div className="space-y-4 mt-12">
      {/* ── POs waiting for GR ── */}
      {availablePOs.length > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-orange-800 mb-3">PO ที่รอรับเข้าคลัง ({availablePOs.length})</h3>
          <div className="flex flex-wrap gap-2">
            {availablePOs.map((po) => (
              <button
                key={po.id}
                onClick={() => openReceive(po)}
                className="px-3 py-1.5 bg-white border border-orange-300 rounded-lg text-sm text-orange-700 hover:bg-orange-100 font-medium transition-colors"
              >
                {po.po_no} → รับเข้าคลัง
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
              placeholder="ค้นหาเลขที่ GR..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
            />
          </div>
        </div>
      </div>

      {/* ── GR List ── */}
      <div className="bg-white rounded-xl shadow-sm border">
        {loading ? (
          <div className="flex justify-center items-center py-16">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500" />
          </div>
        ) : grs.length === 0 ? (
          <div className="text-center py-16 text-gray-400">ไม่พบรายการ GR</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">เลขที่ GR</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">PO</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">สถานะ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">วันที่รับ</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">ค่าขนส่ง</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">ต้นทุน/ชิ้น</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">การจัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {grs.map((gr) => {
                  const st = STATUS_MAP[gr.status] || { label: gr.status, color: 'bg-gray-100 text-gray-700' }
                  return (
                    <tr key={gr.id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">{gr.gr_no}</td>
                      <td className="px-4 py-3 text-gray-600">{(gr as any).inv_po?.po_no || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${st.color}`}>
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {gr.received_at ? new Date(gr.received_at).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        {gr.dom_shipping_cost != null ? Number(gr.dom_shipping_cost).toLocaleString(undefined, { minimumFractionDigits: 2 }) + ' บาท' : '-'}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        {gr.dom_cost_per_piece != null ? Number(gr.dom_cost_per_piece).toLocaleString(undefined, { minimumFractionDigits: 2 }) + ' บาท' : '-'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => openDetail(gr)}
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

      {/* ── Receive GR Modal ── */}
      <Modal open={receiveOpen} onClose={() => setReceiveOpen(false)} closeOnBackdropClick={false} contentClassName="max-w-4xl">
        <div className="p-6 space-y-5">
          <h2 className="text-xl font-bold text-gray-900">ตรวจรับสินค้า (GR)</h2>
          {selectedPO && (
            <div className="bg-orange-50 rounded-lg p-3 text-sm">
              <span className="font-semibold text-orange-800">PO: {selectedPO.po_no}</span>
              {selectedPO.supplier_name && <span className="ml-3 text-gray-600">ผู้จัดจำหน่าย: {selectedPO.supplier_name}</span>}
            </div>
          )}

          {/* items table */}
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600 w-14">รูป</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600">สินค้า</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-gray-600 w-24">จำนวนสั่ง</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-gray-600 w-28">จำนวนรับ</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-gray-600 w-20">ขาด</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600 w-40">หมายเหตุขาดส่ง</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {receiveItems.map((item, index) => {
                  const shortage = Math.max(item.qty_ordered - item.qty_received, 0)
                  const imgUrl = getPublicUrl('product-images', item.product_code)
                  return (
                    <tr key={item.product_id} className={shortage > 0 ? 'bg-red-50/50' : ''}>
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
                        <div className="font-medium">{item.product_code} - {item.product_name}</div>
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600">{Number(item.qty_ordered).toLocaleString()}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          max={item.qty_ordered}
                          value={item.qty_received}
                          onChange={(e) => updateReceiveItem(index, { qty_received: Number(e.target.value) || 0 })}
                          className="w-full px-2 py-1.5 border rounded-lg text-sm text-right"
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {shortage > 0 ? (
                          <span className="text-red-600 font-semibold">{shortage.toLocaleString()}</span>
                        ) : (
                          <span className="text-green-600">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {shortage > 0 && (
                          <input
                            type="text"
                            value={item.shortage_note}
                            onChange={(e) => updateReceiveItem(index, { shortage_note: e.target.value })}
                            className="w-full px-2 py-1.5 border rounded-lg text-xs border-red-200"
                            placeholder="ระบุเหตุผล..."
                          />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 border-t">
                  <td colSpan={2} className="px-3 py-2.5 text-right font-semibold text-gray-700">รวม</td>
                  <td className="px-3 py-2.5 text-right font-medium">{totalOrdered.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right font-medium">{totalReceived.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right font-semibold text-red-600">
                    {hasShortage ? (totalOrdered - totalReceived).toLocaleString() : '-'}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          {hasShortage && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <label className="block text-xs text-red-600 font-medium mb-1">หมายเหตุภาพรวมของขาดส่ง</label>
              <input
                type="text"
                value={shortageNote}
                onChange={(e) => setShortageNote(e.target.value)}
                className="w-full px-3 py-2 border border-red-200 rounded-lg text-sm"
                placeholder="เช่น ติดตามส่งรอบหน้า..."
              />
            </div>
          )}

          {/* Domestic shipping (collapsible) */}
          <div className="border rounded-lg">
            <button
              onClick={() => setShippingExpanded(!shippingExpanded)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <span>ค่าขนส่งในประเทศ (ไม่บังคับ)</span>
              <svg className={`w-4 h-4 transition-transform ${shippingExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {shippingExpanded && (
              <div className="px-4 pb-4 space-y-3 border-t">
                <div className="grid grid-cols-2 gap-3 pt-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">ชื่อบริษัทขนส่ง</label>
                    <input
                      type="text"
                      value={domCompany}
                      onChange={(e) => setDomCompany(e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg text-sm"
                      placeholder="เช่น Kerry, Flash, J&T..."
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">ค่าขนส่งรวม (บาท)</label>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={domCost}
                      onChange={(e) => setDomCost(e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg text-sm"
                      placeholder="0.00"
                    />
                  </div>
                </div>
                {costPerPiece > 0 && (
                  <div className="bg-blue-50 rounded-lg p-3 text-sm">
                    <span className="text-blue-600">ต้นทุนขนส่งต่อชิ้น:</span>{' '}
                    <span className="font-bold text-blue-800">{costPerPiece.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} บาท</span>
                    <span className="text-xs text-gray-500 ml-2">({Number(domCost).toLocaleString()} / {totalReceived.toLocaleString()} ชิ้น)</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* note */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">หมายเหตุ</label>
            <textarea
              value={grNote}
              onChange={(e) => setGrNote(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
              rows={2}
              placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setReceiveOpen(false)} className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium">
              ยกเลิก
            </button>
            <button onClick={handleReceive} disabled={saving} className="px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 text-sm font-semibold">
              {saving ? 'กำลังบันทึก...' : hasShortage ? 'รับบางส่วน' : 'รับเข้าคลัง'}
            </button>
          </div>
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
                  <h2 className="text-xl font-bold text-gray-900">รายละเอียด GR</h2>
                  <p className="text-sm text-gray-500 mt-1">
                    เลขที่: <span className="font-semibold text-gray-800">{viewing.gr_no}</span>
                    {(viewing as any).inv_po?.po_no && (
                      <span className="ml-3">PO: <span className="font-semibold">{(viewing as any).inv_po.po_no}</span></span>
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
                  <div className="text-gray-500 text-xs">วันที่รับ</div>
                  <div className="font-medium">{viewing.received_at ? new Date(viewing.received_at).toLocaleString('th-TH') : '-'}</div>
                </div>
                {viewing.dom_shipping_company && (
                  <div className="bg-blue-50 rounded-lg p-3">
                    <div className="text-blue-600 text-xs">บริษัทขนส่ง</div>
                    <div className="font-medium">{viewing.dom_shipping_company}</div>
                  </div>
                )}
                {viewing.dom_shipping_cost != null && (
                  <div className="bg-blue-50 rounded-lg p-3">
                    <div className="text-blue-600 text-xs">ค่าขนส่งในประเทศ</div>
                    <div className="font-medium">{Number(viewing.dom_shipping_cost).toLocaleString(undefined, { minimumFractionDigits: 2 })} บาท</div>
                  </div>
                )}
                {viewing.dom_cost_per_piece != null && (
                  <div className="bg-blue-50 rounded-lg p-3">
                    <div className="text-blue-600 text-xs">ต้นทุนต่อชิ้น</div>
                    <div className="font-bold">{Number(viewing.dom_cost_per_piece).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} บาท</div>
                  </div>
                )}
              </div>

              {viewing.shortage_note && (
                <div className="bg-red-50 rounded-lg p-3 text-sm">
                  <span className="text-red-600 font-medium">หมายเหตุของขาดส่ง:</span> {viewing.shortage_note}
                </div>
              )}

              {/* items */}
              <div className="overflow-x-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b">
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600 w-14">รูป</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600">สินค้า</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">จำนวนสั่ง</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">จำนวนรับ</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">ขาด</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600">หมายเหตุ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(viewing.inv_gr_items || []).map((item: any) => {
                      const prod = item.pr_products
                      const imgUrl = prod ? getPublicUrl('product-images', prod.product_code) : ''
                      const shortage = Number(item.qty_shortage || 0)
                      return (
                        <tr key={item.id} className={shortage > 0 ? 'bg-red-50/50' : ''}>
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
                          <td className="px-3 py-2 text-right text-gray-600">{item.qty_ordered != null ? Number(item.qty_ordered).toLocaleString() : '-'}</td>
                          <td className="px-3 py-2 text-right font-medium">{Number(item.qty_received).toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">
                            {shortage > 0 ? (
                              <span className="text-red-600 font-semibold">{shortage.toLocaleString()}</span>
                            ) : (
                              <span className="text-green-600">-</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-500">{item.shortage_note || ''}</td>
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
    </div>
  )
}
