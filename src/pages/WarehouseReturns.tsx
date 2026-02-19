import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import Modal from '../components/ui/Modal'
import { useAuthContext } from '../contexts/AuthContext'
import { InventoryReturn, InventoryReturnItem } from '../types'
import { adjustStockBalancesBulkRPC } from '../lib/inventory'
import { getProductImageUrl } from '../components/wms/wmsUtils'
import { useWmsModal } from '../components/wms/useWmsModal'

type StatusFilter = 'all' | 'pending' | 'return_to_stock' | 'waste'

interface MatchedOrder {
  bill_no: string
  tracking_number: string
  customer_name?: string
  status?: string
  items: Array<{
    product_id: string
    product_code: string
    product_name: string
    qty: number
  }>
}

function generateCode(prefix: string) {
  const date = new Date()
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const rand = Math.floor(Math.random() * 9000) + 1000
  return `${prefix}-${y}${m}${d}-${rand}`
}

export default function WarehouseReturns() {
  const { user } = useAuthContext()
  const [returnsList, setReturnsList] = useState<InventoryReturn[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [viewing, setViewing] = useState<InventoryReturn | null>(null)
  const [viewItems, setViewItems] = useState<InventoryReturnItem[]>([])
  const [updating, setUpdating] = useState<string | null>(null)
  const [lightboxImg, setLightboxImg] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [wasteCostMap, setWasteCostMap] = useState<Record<string, number>>({})

  const canSeeCost = ['superadmin', 'account'].includes(user?.role || '')

  // Create form - tracking lookup
  const [trackingInput, setTrackingInput] = useState('')
  const [searching, setSearching] = useState(false)
  const [matchedOrder, setMatchedOrder] = useState<MatchedOrder | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')

  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('inv_returns')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      const list = (data || []) as InventoryReturn[]
      setReturnsList(list)
      if (canSeeCost) loadWasteCosts(list)
    } catch (e) {
      console.error('Load returns failed:', e)
    } finally {
      setLoading(false)
    }
  }

  async function loadWasteCosts(returns: InventoryReturn[]) {
    const wasteReturns = returns.filter((r) => r.status === 'received' && r.disposition === 'waste')
    if (wasteReturns.length === 0) { setWasteCostMap({}); return }

    const costMap: Record<string, number> = {}
    const ids = wasteReturns.map((r) => r.id)
    const { data: items } = await supabase
      .from('inv_return_items')
      .select('return_id, qty, pr_products(unit_cost)')
      .in('return_id', ids)
    ;(items || []).forEach((item: any) => {
      const cost = Number(item.pr_products?.unit_cost) || 0
      const qty = Number(item.qty) || 0
      costMap[item.return_id] = (costMap[item.return_id] || 0) + cost * qty
    })
    setWasteCostMap(costMap)
  }

  const lookupTracking = async (tracking: string) => {
    const trimmed = tracking.trim().toUpperCase()
    if (!trimmed) return
    setSearching(true)
    setMatchedOrder(null)
    setNotFound(false)

    try {
      const { data: orders, error } = await supabase
        .from('or_orders')
        .select('bill_no, tracking_number, recipient_name, status, or_order_items(product_id, quantity)')
        .eq('tracking_number', trimmed)
        .limit(1)
      if (error) throw error

      if (!orders || orders.length === 0) {
        setNotFound(true)
        return
      }

      const order = orders[0]
      const items = order.or_order_items || []
      const productIds = items.map((i: any) => i.product_id).filter(Boolean)

      let productMap: Record<string, { product_code: string; product_name: string }> = {}
      if (productIds.length > 0) {
        const { data: prods } = await supabase
          .from('pr_products')
          .select('id, product_code, product_name')
          .in('id', productIds)
        ;(prods || []).forEach((p: any) => {
          productMap[p.id] = { product_code: p.product_code, product_name: p.product_name }
        })
      }

      setMatchedOrder({
        bill_no: order.bill_no,
        tracking_number: order.tracking_number,
        customer_name: order.recipient_name || '-',
        status: order.status,
        items: items.map((i: any) => ({
          product_id: i.product_id,
          product_code: productMap[i.product_id]?.product_code || '-',
          product_name: productMap[i.product_id]?.product_name || '-',
          qty: Number(i.quantity) || 1,
        })),
      })
    } catch (e: any) {
      showMessage({ message: `ค้นหาไม่สำเร็จ: ${e.message}` })
    } finally {
      setSearching(false)
    }
  }

  async function createReturn() {
    if (!matchedOrder) return
    if (!reason.trim()) {
      showMessage({ message: 'กรุณาระบุเหตุผลตีกลับ' })
      return
    }

    const ok = await showConfirm({
      title: 'ยืนยันรับสินค้าตีกลับ',
      message: `บิล: ${matchedOrder.bill_no}\nTracking: ${matchedOrder.tracking_number}\nรายการ: ${matchedOrder.items.length} รายการ`,
    })
    if (!ok) return

    setSaving(true)
    try {
      const returnNo = generateCode('RTN')
      const { data: retData, error: retErr } = await supabase
        .from('inv_returns')
        .insert({
          return_no: returnNo,
          ref_bill_no: matchedOrder.bill_no,
          tracking_number: matchedOrder.tracking_number,
          reason: reason.trim(),
          status: 'pending',
          created_by: user?.id || null,
          note: note.trim() || null,
        })
        .select('*')
        .single()
      if (retErr) throw retErr

      const itemsPayload = matchedOrder.items
        .filter((i) => i.product_id)
        .map((i) => ({
          return_id: retData.id,
          product_id: i.product_id,
          qty: i.qty,
        }))
      if (itemsPayload.length > 0) {
        const { error: itemErr } = await supabase.from('inv_return_items').insert(itemsPayload)
        if (itemErr) throw itemErr
      }

      showMessage({ message: `รับสินค้าตีกลับ ${returnNo} สำเร็จ` })
      resetCreateForm()
      setCreateOpen(false)
      await loadAll()
    } catch (e: any) {
      showMessage({ message: `สร้างใบรับสินค้าตีกลับไม่สำเร็จ: ${e.message}` })
    } finally {
      setSaving(false)
    }
  }

  function resetCreateForm() {
    setTrackingInput('')
    setMatchedOrder(null)
    setNotFound(false)
    setReason('')
    setNote('')
  }

  async function processReturn(ret: InventoryReturn, disposition: 'return_to_stock' | 'waste') {
    const label = disposition === 'return_to_stock' ? 'คืนกลับสต๊อค' : 'ตีเป็นของเสีย'
    const ok = await showConfirm({
      title: label,
      message: `ยืนยัน "${label}" สำหรับ ${ret.return_no}?`,
    })
    if (!ok) return

    setUpdating(ret.id)
    try {
      const { data: items, error: itemsError } = await supabase
        .from('inv_return_items')
        .select('product_id, qty')
        .eq('return_id', ret.id)
      if (itemsError) throw itemsError

      const { error } = await supabase
        .from('inv_returns')
        .update({
          status: 'received',
          disposition,
          received_by: user?.id || null,
          received_at: new Date().toISOString(),
        })
        .eq('id', ret.id)
      if (error) throw error

      if (disposition === 'return_to_stock') {
        await adjustStockBalancesBulkRPC(
          (items || []).map((item) => ({
            productId: item.product_id,
            qtyDelta: Number(item.qty),
            movementType: 'return',
            refType: 'inv_returns',
            refId: ret.id,
            note: `รับสินค้าตีกลับ ${ret.return_no} (คืนกลับสต๊อค)`,
          }))
        )
      } else if (disposition === 'waste') {
        const wasteItems = (items || []).map((item) => ({
          product_id: item.product_id,
          qty: Number(item.qty),
        }))
        const { error: wasteErr } = await supabase.rpc('rpc_record_waste_cost', {
          p_items: wasteItems,
          p_ref_id: ret.id,
          p_user_id: user?.id || null,
        })
        if (wasteErr) throw wasteErr
      }

      await loadAll()
      showMessage({ message: `${label} — ${ret.return_no} เรียบร้อย` })
      setViewing(null)
    } catch (e: any) {
      showMessage({ message: `ดำเนินการไม่สำเร็จ: ${e.message}` })
    } finally {
      setUpdating(null)
    }
  }

  async function openView(ret: InventoryReturn) {
    setViewing(ret)
    const { data, error } = await supabase
      .from('inv_return_items')
      .select('id, return_id, product_id, qty, pr_products(product_code, product_name, unit_cost)')
      .eq('return_id', ret.id)
    if (!error) {
      setViewItems((data || []) as unknown as InventoryReturnItem[])
    }
  }

  const filteredReturns = useMemo(() => {
    if (statusFilter === 'all') return returnsList
    if (statusFilter === 'pending') return returnsList.filter((r) => r.status === 'pending')
    if (statusFilter === 'return_to_stock') return returnsList.filter((r) => r.status === 'received' && r.disposition === 'return_to_stock')
    if (statusFilter === 'waste') return returnsList.filter((r) => r.status === 'received' && r.disposition === 'waste')
    return returnsList
  }, [returnsList, statusFilter])

  const stats = useMemo(() => ({
    all: returnsList.length,
    pending: returnsList.filter((r) => r.status === 'pending').length,
    return_to_stock: returnsList.filter((r) => r.status === 'received' && r.disposition === 'return_to_stock').length,
    waste: returnsList.filter((r) => r.status === 'received' && r.disposition === 'waste').length,
  }), [returnsList])

  const statusLabel = (ret: InventoryReturn) => {
    if (ret.status === 'received' && ret.disposition === 'return_to_stock') return 'คืนกลับสต๊อค'
    if (ret.status === 'received' && ret.disposition === 'waste') return 'ตีเป็นของเสีย'
    if (ret.status === 'received') return 'รับแล้ว'
    return 'รอดำเนินการ'
  }

  const statusColor = (ret: InventoryReturn) => {
    if (ret.status === 'received' && ret.disposition === 'waste') return 'bg-red-500 text-white'
    if (ret.status === 'received') return 'bg-green-500 text-white'
    return 'bg-amber-500 text-white'
  }

  const formatDate = (dateString: string) => {
    if (!dateString) return '-'
    return new Date(dateString).toLocaleString('th-TH', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const filterTabs: { key: StatusFilter; label: string; color: string; activeColor: string; count: number }[] = [
    { key: 'all', label: 'ทั้งหมด', color: 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200', activeColor: 'bg-slate-700 text-white border-slate-700', count: stats.all },
    { key: 'pending', label: 'รอดำเนินการ', color: 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100', activeColor: 'bg-amber-500 text-white border-amber-500', count: stats.pending },
    { key: 'return_to_stock', label: 'คืนกลับสต๊อค', color: 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100', activeColor: 'bg-green-600 text-white border-green-600', count: stats.return_to_stock },
    { key: 'waste', label: 'ตีเป็นของเสีย', color: 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100', activeColor: 'bg-red-600 text-white border-red-600', count: stats.waste },
  ]

  const isWasteView = statusFilter === 'waste'

  return (
    <div className="space-y-6 mt-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setStatusFilter(tab.key)}
              className={`px-4 py-2 rounded-xl text-sm font-bold border transition ${
                statusFilter === tab.key ? tab.activeColor : tab.color
              }`}
            >
              {tab.label} ({tab.count})
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => { resetCreateForm(); setCreateOpen(true) }}
          className="px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold"
        >
          + เปิดใบรับสินค้าตีกลับ
        </button>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          </div>
        ) : filteredReturns.length === 0 ? (
          <div className="text-center py-12 text-gray-500">ไม่มีรายการ</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-3 text-left font-semibold rounded-tl-xl">เลขที่รับคืน</th>
                  <th className="p-3 text-left font-semibold">เลขบิลอ้างอิง</th>
                  <th className="p-3 text-left font-semibold">เลขพัสดุ</th>
                  <th className="p-3 text-left font-semibold">เหตุผล</th>
                  <th className="p-3 text-left font-semibold">วันที่</th>
                  <th className="p-3 text-left font-semibold">สถานะ</th>
                  {isWasteView && canSeeCost && (
                    <th className="p-3 text-right font-semibold">ต้นทุนรวม</th>
                  )}
                  <th className={`p-3 text-right font-semibold ${!(isWasteView && canSeeCost) ? 'rounded-tr-xl' : 'rounded-tr-xl'}`}>การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {filteredReturns.map((ret, idx) => (
                  <tr key={ret.id} className={`border-b border-gray-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="p-3 font-medium">{ret.return_no}</td>
                    <td className="p-3">{ret.ref_bill_no || '-'}</td>
                    <td className="p-3">{ret.tracking_number || '-'}</td>
                    <td className="p-3">{ret.reason || '-'}</td>
                    <td className="p-3">{formatDate(ret.created_at)}</td>
                    <td className="p-3">
                      <span className={`inline-flex px-3 py-1 rounded-full text-xs font-bold ${statusColor(ret)}`}>
                        {statusLabel(ret)}
                      </span>
                    </td>
                    {isWasteView && canSeeCost && (
                      <td className="p-3 text-right font-bold text-red-600">
                        {wasteCostMap[ret.id]
                          ? `฿${wasteCostMap[ret.id].toLocaleString('th-TH', { minimumFractionDigits: 2 })}`
                          : '-'}
                      </td>
                    )}
                    <td className="p-3 text-right">
                      <button
                        type="button"
                        onClick={() => openView(ret)}
                        className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-xs font-bold transition"
                      >
                        ดูรายละเอียด
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create modal - tracking lookup */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} closeOnBackdropClick={true} contentClassName="max-w-4xl">
        <div className="bg-white rounded-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
          <div className="p-6 border-b border-gray-200 flex justify-between items-center bg-gradient-to-r from-blue-600 to-blue-700">
            <h2 className="text-2xl font-black text-white">เปิดใบรับสินค้าตีกลับ</h2>
            <button
              onClick={() => setCreateOpen(false)}
              className="text-white text-3xl font-bold w-12 h-12 flex items-center justify-center rounded-full hover:bg-blue-800 transition-all"
            >
              <i className="fas fa-times" style={{ fontSize: '1.5rem', lineHeight: '1' }}></i>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 bg-gray-50 space-y-4">
            {/* Tracking input */}
            <div className="bg-white p-6 rounded-xl border shadow-sm space-y-3">
              <div className="text-sm font-bold text-gray-700 uppercase">ค้นหาด้วยเลขพัสดุ</div>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={trackingInput}
                  onChange={(e) => setTrackingInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && lookupTracking(trackingInput)}
                  placeholder="พิมพ์เลขพัสดุ..."
                  className="flex-1 px-4 py-3 border border-gray-300 rounded-xl text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 transition"
                />
                <button
                  type="button"
                  onClick={() => lookupTracking(trackingInput)}
                  disabled={searching || !trackingInput.trim()}
                  className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 disabled:opacity-50 transition"
                >
                  {searching ? (
                    <><i className="fas fa-spinner fa-spin mr-2"></i>ค้นหา...</>
                  ) : (
                    <><i className="fas fa-search mr-2"></i>ค้นหา</>
                  )}
                </button>
              </div>
            </div>

            {/* Not found */}
            {notFound && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-center">
                <i className="fas fa-exclamation-triangle text-red-400 text-2xl mb-2"></i>
                <div className="text-red-600 font-bold">ไม่พบเลขพัสดุนี้ในระบบ</div>
                <div className="text-sm text-red-400 mt-1">กรุณาตรวจสอบเลขพัสดุอีกครั้ง</div>
              </div>
            )}

            {/* Matched order */}
            {matchedOrder && (
              <>
                {/* Order info */}
                <div className="bg-white p-6 rounded-xl border shadow-sm">
                  <div className="flex items-center gap-2 mb-4">
                    <i className="fas fa-check-circle text-green-500 text-lg"></i>
                    <span className="font-bold text-green-600">พบข้อมูลบิล</span>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-sm text-gray-500 font-bold uppercase mb-1">เลขบิล</div>
                      <div className="font-bold text-slate-800 text-lg">{matchedOrder.bill_no}</div>
                    </div>
                    <div>
                      <div className="text-sm text-gray-500 font-bold uppercase mb-1">เลขพัสดุ</div>
                      <div className="font-bold text-slate-800 text-lg">{matchedOrder.tracking_number}</div>
                    </div>
                    <div>
                      <div className="text-sm text-gray-500 font-bold uppercase mb-1">ลูกค้า</div>
                      <div className="font-bold text-slate-800">{matchedOrder.customer_name}</div>
                    </div>
                    <div>
                      <div className="text-sm text-gray-500 font-bold uppercase mb-1">สถานะ</div>
                      <div className="font-bold text-slate-800">{matchedOrder.status}</div>
                    </div>
                  </div>
                </div>

                {/* Items */}
                <div className="bg-white p-6 rounded-xl border shadow-sm">
                  <h3 className="text-lg font-black text-slate-800 mb-4">รายการสินค้า ({matchedOrder.items.length} รายการ)</h3>
                  <div className="space-y-3">
                    {matchedOrder.items.map((item, idx) => (
                      <div key={idx} className="flex items-center gap-4 p-4 bg-gray-50 rounded-xl border hover:bg-blue-50 transition">
                        <div className="text-lg font-black text-gray-400 w-8 text-center shrink-0">{idx + 1}</div>
                        <img
                          src={getProductImageUrl(item.product_code)}
                          className="w-20 h-20 object-cover rounded-lg shrink-0 border-2 border-gray-200 cursor-pointer hover:opacity-80 transition"
                          onClick={() => setLightboxImg(getProductImageUrl(item.product_code))}
                          onError={(e) => {
                            const target = e.target as HTMLImageElement
                            target.src = 'https://placehold.co/100x100?text=NO+IMG'
                          }}
                          alt={item.product_name}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-bold text-slate-800 text-base mb-1">{item.product_name}</div>
                          <div className="text-xs text-gray-500">รหัส: {item.product_code}</div>
                        </div>
                        <div className="text-slate-800 font-black text-xl shrink-0 bg-blue-100 px-4 py-2 rounded-lg">
                          x{item.qty}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Reason & Note */}
                <div className="bg-white p-6 rounded-xl border shadow-sm space-y-4">
                  <div>
                    <label className="block text-sm font-bold text-gray-700 uppercase mb-2">
                      เหตุผลตีกลับ <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      className={`w-full px-4 py-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-blue-200 transition ${
                        reason.trim() ? 'border-gray-300 focus:border-blue-500' : 'border-red-300 focus:border-red-500'
                      }`}
                      placeholder="ระบุเหตุผลตีกลับ"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-gray-700 uppercase mb-2">หมายเหตุ</label>
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 transition"
                      rows={2}
                      placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)"
                    />
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          {matchedOrder && (
            <div className="p-4 border-t border-gray-200 flex gap-3 bg-white">
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="flex-1 py-3 border border-gray-300 rounded-xl font-bold text-gray-600 hover:bg-gray-50 transition"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={createReturn}
                disabled={saving || !reason.trim()}
                className="flex-1 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 disabled:opacity-50 transition"
              >
                {saving ? (
                  <><i className="fas fa-spinner fa-spin mr-2"></i>กำลังบันทึก...</>
                ) : (
                  <><i className="fas fa-check mr-2"></i>บันทึกใบรับคืน</>
                )}
              </button>
            </div>
          )}
        </div>
      </Modal>

      {/* View detail modal */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} closeOnBackdropClick={true} contentClassName="max-w-4xl">
        <div className="bg-white rounded-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
          <div className="p-6 border-b border-gray-200 flex justify-between items-center bg-gradient-to-r from-blue-600 to-blue-700">
            <div>
              <h2 className="text-2xl font-black text-white">ใบรับคืน: {viewing?.return_no}</h2>
              {viewing && (
                <div className="mt-2">
                  <span className={`inline-block px-3 py-1 rounded-lg text-xs font-bold ${statusColor(viewing)}`}>
                    {statusLabel(viewing)}
                  </span>
                </div>
              )}
            </div>
            <button
              onClick={() => setViewing(null)}
              className="text-white text-3xl font-bold w-12 h-12 flex items-center justify-center rounded-full hover:bg-blue-800 transition-all"
            >
              <i className="fas fa-times" style={{ fontSize: '1.5rem', lineHeight: '1' }}></i>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 bg-gray-50 space-y-4">
            {viewing && (
              <div className="bg-white p-6 rounded-xl border shadow-sm">
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <div className="text-sm text-gray-500 font-bold uppercase mb-1">เลขบิลอ้างอิง</div>
                    <div className="font-bold text-slate-800 text-lg">{viewing.ref_bill_no || '-'}</div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-500 font-bold uppercase mb-1">เลขพัสดุ</div>
                    <div className="font-bold text-slate-800 text-lg">{viewing.tracking_number || '-'}</div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-500 font-bold uppercase mb-1">วันที่ทำรายการ</div>
                    <div className="text-slate-600 text-sm">{formatDate(viewing.created_at)}</div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-500 font-bold uppercase mb-1">วันที่ดำเนินการ</div>
                    <div className="text-slate-600 text-sm">{viewing.received_at ? formatDate(viewing.received_at) : '-'}</div>
                  </div>
                </div>
                {viewing.reason && (
                  <div className="mb-3">
                    <div className="text-sm text-gray-500 font-bold uppercase mb-1">เหตุผลตีกลับ</div>
                    <div className="text-red-600 bg-red-50 px-3 py-2 rounded-lg font-bold inline-block">{viewing.reason}</div>
                  </div>
                )}
                {viewing.note && (
                  <div className="mt-4 pt-4 border-t">
                    <div className="text-sm text-gray-500 font-bold uppercase mb-2">หมายเหตุ</div>
                    <div className="text-base text-gray-700 font-medium break-words bg-gray-50 p-3 rounded-lg">{viewing.note}</div>
                  </div>
                )}
              </div>
            )}

            <div className="bg-white p-6 rounded-xl border shadow-sm">
              {(() => {
                const showCost = canSeeCost
                const totalCost = showCost
                  ? viewItems.reduce((sum, item: any) => {
                      const cost = Number(item.pr_products?.unit_cost) || 0
                      return sum + cost * Number(item.qty)
                    }, 0)
                  : 0

                return (
                  <>
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-black text-slate-800">รายการสินค้า ({viewItems.length} รายการ)</h3>
                      {showCost && totalCost > 0 && (
                        <div className="text-right">
                          <div className="text-xs text-gray-500 uppercase font-bold">ต้นทุนรวม</div>
                          <div className="text-xl font-black text-red-600">฿{totalCost.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</div>
                        </div>
                      )}
                    </div>
                    {viewItems.length === 0 ? (
                      <div className="text-center py-8 text-gray-400">
                        <i className="fas fa-inbox text-2xl mb-2"></i>
                        <div>ไม่มีรายการ</div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {viewItems.map((item: any, idx) => {
                          const code = item.pr_products?.product_code || ''
                          const name = item.pr_products?.product_name || '-'
                          const unitCost = Number(item.pr_products?.unit_cost) || 0
                          const qty = Number(item.qty)
                          const lineCost = unitCost * qty
                          return (
                            <div key={item.id} className="flex items-center gap-4 p-4 bg-gray-50 rounded-xl border hover:bg-blue-50 transition">
                              <div className="text-lg font-black text-gray-400 w-8 text-center shrink-0">{idx + 1}</div>
                              <img
                                src={getProductImageUrl(code)}
                                className="w-20 h-20 object-cover rounded-lg shrink-0 border-2 border-gray-200 cursor-pointer hover:opacity-80 transition"
                                onClick={() => setLightboxImg(getProductImageUrl(code))}
                                onError={(e) => {
                                  const target = e.target as HTMLImageElement
                                  target.src = 'https://placehold.co/100x100?text=NO+IMG'
                                }}
                                alt={name}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="font-bold text-slate-800 text-base mb-1">{name}</div>
                                <div className="text-xs text-gray-500">รหัส: {code || '-'}</div>
                                {showCost && unitCost > 0 && (
                                  <div className="text-xs text-red-500 mt-1 font-medium">
                                    ต้นทุน: ฿{unitCost.toLocaleString('th-TH', { minimumFractionDigits: 2 })} / ชิ้น
                                  </div>
                                )}
                              </div>
                              <div className="text-right shrink-0">
                                <div className="text-slate-800 font-black text-xl bg-blue-100 px-4 py-2 rounded-lg">
                                  x{qty.toLocaleString()}
                                </div>
                                {showCost && lineCost > 0 && (
                                  <div className="text-xs text-red-600 font-bold mt-1 text-center">
                                    ฿{lineCost.toLocaleString('th-TH', { minimumFractionDigits: 2 })}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          </div>

          {viewing?.status === 'pending' && (
            <div className="p-4 border-t border-gray-200 flex gap-3 bg-white">
              <button
                type="button"
                onClick={() => viewing && processReturn(viewing, 'waste')}
                disabled={updating === viewing?.id}
                className="flex-1 bg-red-600 text-white py-3 rounded-xl font-bold hover:bg-red-700 disabled:opacity-50 transition"
              >
                <i className="fas fa-trash mr-2"></i>
                ตีเป็นของเสีย
              </button>
              <button
                type="button"
                onClick={() => viewing && processReturn(viewing, 'return_to_stock')}
                disabled={updating === viewing?.id}
                className="flex-1 bg-green-600 text-white py-3 rounded-xl font-bold hover:bg-green-700 disabled:opacity-50 transition"
              >
                {updating === viewing?.id ? (
                  <><i className="fas fa-spinner fa-spin mr-2"></i>กำลังดำเนินการ...</>
                ) : (
                  <><i className="fas fa-undo mr-2"></i>คืนกลับสต๊อค</>
                )}
              </button>
            </div>
          )}
        </div>
      </Modal>

      {/* Lightbox */}
      {lightboxImg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-80 p-4"
          onClick={() => setLightboxImg(null)}
        >
          <div className="relative max-w-[90vw] max-h-[85vh]">
            <button
              type="button"
              onClick={() => setLightboxImg(null)}
              className="absolute -top-3 -right-3 z-10 w-10 h-10 rounded-full bg-white border border-gray-300 text-gray-600 flex items-center justify-center text-sm font-bold hover:bg-red-500 hover:text-white hover:border-red-500 transition-colors shadow-lg"
            >
              <i className="fas fa-times"></i>
            </button>
            <img
              src={lightboxImg}
              alt="product"
              className="max-w-full max-h-[85vh] rounded-xl object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}

      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
