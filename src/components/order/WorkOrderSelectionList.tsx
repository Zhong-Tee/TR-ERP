import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { buildIlikeOr } from '../../lib/searchFilter'
import { localISODate } from '../../lib/localDate'
import { PLAN_WORK_QUEUE_ORDER_STATUSES } from '../../lib/planWorkQueue'
import { Order } from '../../types'
import Modal from '../ui/Modal'
import UrgencyBadge from '../common/UrgencyBadge'
import OrderDetailView from './OrderDetailView'

const WO_PREFIX_MAP: Record<string, string> = { OFFICE: 'OF' }
function woPrefix(channelCode: string) { return WO_PREFIX_MAP[channelCode] || channelCode }

interface WorkOrderSelectionListProps {
  searchTerm?: string
  channelFilter?: string
  onCountChange?: (count: number) => void
  onOrderClick?: (order: Order) => void
  onCreateWorkOrder?: () => void
}

export default function WorkOrderSelectionList({
  searchTerm = '',
  channelFilter = '',
  onCountChange,
  onOrderClick: _onOrderClick,
  onCreateWorkOrder,
}: WorkOrderSelectionListProps) {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectQty, setSelectQty] = useState<string>('')
  const [detailOrder, setDetailOrder] = useState<Order | null>(null)
  const [creating, setCreating] = useState(false)
  /** คลิก pill ช่องทาง = แสดงเฉพาะบิลช่องทางนั้น (null = ทั้งหมด) */
  const [pillChannel, setPillChannel] = useState<string | null>(null)
  /** Popup แจ้งผลหลังสร้างใบงาน (แสดงครั้งเดียว) */
  const [successPopup, setSuccessPopup] = useState<{ count: number } | null>(null)

  useEffect(() => {
    loadOrders()
  }, [searchTerm, channelFilter])

  async function loadOrders() {
    setLoading(true)
    try {
      let query = supabase
        .from('or_orders')
        .select('id, bill_no, customer_name, admin_user, tracking_number, channel_code, recipient_name, channel_order_no, scheduled_pickup_at, claim_shipping_confirmed_at, status, shipped_time, ship_due_at, overdue_at')
        .is('work_order_id', null)
        .order('created_at', { ascending: false })

      query = query.in('status', PLAN_WORK_QUEUE_ORDER_STATUSES)
      if (channelFilter) {
        query = query.eq('channel_code', channelFilter)
      }

      if (searchTerm) {
        query = query.or(
          buildIlikeOr(searchTerm, ['bill_no', 'customer_name', 'admin_user', 'tracking_number', 'channel_order_no', 'recipient_name'])
        )
      }

      const { data, error } = await query.limit(500)
      if (error) throw error
      const raw = (data || []) as Order[]
      const list = raw.filter((o) => {
        const bn = String(o.bill_no || '')
        if (!bn.startsWith('REQ')) return true
        return !!(o as Order & { claim_shipping_confirmed_at?: string | null }).claim_shipping_confirmed_at
      })
      setOrders(list)
      setSelectedIds(new Set())
      setSelectQty('')
      setPillChannel(null)
      onCountChange?.(list.length)
    } catch (error: any) {
      console.error('Error loading orders:', error)
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  /** ป้ายช่องทางสำหรับกรอง — บิลเคลม (REQ) แยกเป็น "(เคลม)ช่องทาง" เช่น (เคลม)SPTR */
  const pillChannelKeyOf = (o: Order) => {
    const ch = o.channel_code || 'N/A'
    return String(o.bill_no || '').startsWith('REQ') ? `(เคลม)${ch}` : ch
  }
  const channelCounts = orders.reduce<Record<string, number>>((acc, o) => {
    const key = pillChannelKeyOf(o)
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
  const channelList = Object.entries(channelCounts).sort(([a], [b]) => a.localeCompare(b))
  const filteredOrders = pillChannel ? orders.filter((o) => pillChannelKeyOf(o) === pillChannel) : orders

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    setSelectedIds(new Set(filteredOrders.map((o) => o.id)))
    setSelectQty(String(filteredOrders.length))
  }

  const clearSelection = () => {
    setSelectedIds(new Set())
    setSelectQty('')
  }

  const applySelectQty = () => {
    const n = parseInt(selectQty, 10)
    if (isNaN(n) || n < 1) {
      setSelectedIds(new Set())
      return
    }
    const topN = filteredOrders.slice(0, n).map((o) => o.id)
    setSelectedIds(new Set(topN))
  }

  useEffect(() => {
    if (selectQty === '') {
      setSelectedIds(new Set())
      return
    }
    // Use the same channel key as the visible table so claim bills such as
    // "(เคลม)SPTR" are not mixed into the regular "SPTR" selection.
    const list = pillChannel ? orders.filter((o) => pillChannelKeyOf(o) === pillChannel) : orders
    if (list.length === 0) return
    const n = parseInt(selectQty, 10)
    if (isNaN(n) || n < 1) {
      setSelectedIds(new Set())
      return
    }
    const topN = list.slice(0, n).map((o) => o.id)
    setSelectedIds(new Set(topN))
  }, [selectQty, orders, pillChannel])

  const selectedOrders = filteredOrders.filter((o) => selectedIds.has(o.id))

  /** สร้าง id สำหรับ plan_jobs (รูปแบบเดียวกับ Plan.tsx) */
  const planJobId = () => 'J' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)

  /**
   * คำนวณจำนวนต่อแผนกจาก order_items + product_category (logic ตาม index.html)
   * PACK = จำนวนบิล, STAMP/STK/CTT/LASER/TUBE = นับจาก product_category ของแต่ละรายการ
   * CTT รองรับหมวด UV และ SUBLIMATION
   */
  async function computeQtyFromOrders(orderIds: string[]): Promise<Record<string, number>> {
    const qty: Record<string, number> = { STAMP: 0, STK: 0, CTT: 0, LASER: 0, TUBE: 0, ETC: 0, PACK: orderIds.length }
    if (orderIds.length === 0) return qty

    const { data: items, error: itemsErr } = await supabase
      .from('or_order_items')
      .select('product_id, product_type, is_detail_row')
      .in('order_id', orderIds)
    if (itemsErr || !items?.length) return qty

    const productIds = [...new Set((items as { product_id: string }[]).map((r) => r.product_id).filter(Boolean))]
    const { data: products, error: prodErr } = await supabase
      .from('pr_products')
      .select('id, product_category')
      .in('id', productIds)
    if (prodErr || !products?.length) return qty

    const categoryByProductId: Record<string, string> = {}
    ;(products as { id: string; product_category: string | null }[]).forEach((p) => {
      categoryByProductId[p.id] = (p.product_category || '').toUpperCase()
    })

    ;(items as { product_id: string; product_type?: string | null; is_detail_row?: boolean | null }[]).forEach((row) => {
      const category = categoryByProductId[row.product_id] || ''
      const isCondoDetailRow = row.is_detail_row === true || (/^CONDO STAMP (2|3|5)FL$/.test(category) && row.product_type !== 'ชั้น1')
      if (isCondoDetailRow) return
      if (category.includes('STAMP')) qty.STAMP += 1
      if (category.includes('STK')) qty.STK += 1
      if (category.includes('UV') || category.includes('SUBLIMATION')) qty.CTT += 1
      if (category.includes('LASER')) qty.LASER += 1
      if (category.includes('TUBE')) qty.TUBE += 1
      if (['CALENDAR', 'ETC', 'INK'].includes(category)) qty.ETC += 1
    })
    return qty
  }

  async function handleCreateWorkOrder() {
    if (selectedOrders.length === 0) {
      alert('กรุณาเลือกรายการบิลอย่างน้อย 1 รายการ')
      return
    }

    setCreating(true)
    try {
      const byChannel = selectedOrders.reduce<Record<string, Order[]>>((acc, o) => {
        // Keep claim bills in their own work order and make the claim origin
        // visible in the generated name, e.g. "(เคลม)SPTR-170769-R1".
        const ch = pillChannelKeyOf(o)
        if (!acc[ch]) acc[ch] = []
        acc[ch].push(o)
        return acc
      }, {})

      const today = new Date()
      const datePart = today.toLocaleDateString('th-TH', { year: '2-digit', month: '2-digit', day: '2-digit' }).replace(/\//g, '')
      const dateISO = localISODate(today)

      const { data: maxOrder } = await supabase
        .from('plan_jobs')
        .select('order_index')
        .order('order_index', { ascending: false })
        .limit(1)
      let nextOrderIndex = (maxOrder?.[0]?.order_index ?? -1) + 1

      for (const [channelCode, channelOrders] of Object.entries(byChannel)) {
        const claimPrefix = '(เคลม)'
        const prefix = channelCode.startsWith(claimPrefix)
          ? `${claimPrefix}${woPrefix(channelCode.slice(claimPrefix.length))}`
          : woPrefix(channelCode)
        const { data: nextName, error: nameErr } = await supabase.rpc('rpc_next_work_order_name', {
          p_prefix: prefix,
          p_date_part: datePart,
        })
        if (nameErr) throw nameErr
        const workOrderName = String(nextName || '').trim()
        if (!workOrderName) throw new Error('สร้างเลขใบงานไม่สำเร็จ')

        const { data: insertedWO, error: insertError } = await supabase
          .from('or_work_orders')
          .insert({
            work_order_name: workOrderName,
            status: 'กำลังผลิต',
            order_count: channelOrders.length,
          })
          .select('id, work_order_name')
          .single()
        if (insertError) throw insertError
        const workOrderId = String((insertedWO as any)?.id || '')

        const orderIds = channelOrders.map((o) => o.id)
        const { error: updateError } = await supabase
          .from('or_orders')
          .update({
            work_order_id: workOrderId,
            work_order_name: workOrderName,
            // บิลที่ถูกดึงกลับเข้าใบงานใหม่ ไม่ควรถูกมองว่า "ย้ายออกจากใบงาน" อีก
            plan_released_from_work_order: null,
            plan_released_from_work_order_id: null,
            plan_released_at: null,
          })
          .in('id', orderIds)
        if (updateError) throw updateError

        // ถ้าบิลถูกปล่อยกลับมาจากใบงาน (status=ย้ายจากใบงาน)
        // เมื่อสร้างใบงานใหม่ให้กลับไปสถานะใบสั่งงาน
        const { error: normalizeStatusError } = await supabase
          .from('or_orders')
          .update({ status: 'ใบสั่งงาน' })
          .in('id', orderIds)
          .eq('status', 'ย้ายจากใบงาน')
        if (normalizeStatusError) throw normalizeStatusError

        const { data: existingPlan } = await supabase
          .from('plan_jobs')
          .select('id')
          .eq('work_order_id', workOrderId)
          .limit(1)
        if (!existingPlan?.length) {
          const cutTime = `${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`
          const qty = await computeQtyFromOrders(orderIds)
          const planRow = {
            id: planJobId(),
            date: dateISO,
            name: workOrderName,
            work_order_id: workOrderId,
            cut: cutTime,
            qty,
            tracks: {},
            line_assignments: {},
            manual_plan_starts: {},
            locked_plans: {},
            order_index: nextOrderIndex++,
          }
          const { error: planErr } = await supabase.from('plan_jobs').insert([planRow])
          if (planErr) {
            console.warn('Sync plan_jobs failed for', workOrderName, planErr)
            alert(
              `สร้างใบงาน "${workOrderName}" แล้ว แต่บันทึกแผนผลิต (plan_jobs) ไม่สำเร็จ — ตรวจสิทธิ์ role หรือดู Console\n${planErr.message}`
            )
          }
        }
      }

      await loadOrders()
      onCreateWorkOrder?.()
      setSuccessPopup({ count: Object.keys(byChannel).length })
    } catch (error: any) {
      console.error('Error creating work order:', error)
      alert('เกิดข้อผิดพลาด: ' + (error?.message || error))
    } finally {
      setCreating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 1. Pill ช่องทาง — คลิกได้ เพื่อกรองรายการบิล */}
      <div className="flex flex-wrap gap-2 items-center">
        {channelList.length === 0 ? (
          <span className="text-gray-500 text-sm">ไม่มีบิลรอสร้างใบงาน</span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setPillChannel(null)}
              className={`inline-flex px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                pillChannel === null
                  ? 'bg-gray-700 text-white ring-2 ring-gray-400'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              ทั้งหมด
            </button>
            {channelList.map(([code, count]) => (
              <button
                type="button"
                key={code}
                onClick={() => setPillChannel((prev) => (prev === code ? null : code))}
                className={`inline-flex px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  pillChannel === code
                    ? 'bg-blue-600 text-white ring-2 ring-blue-400'
                    : 'bg-blue-100 text-blue-800 hover:bg-blue-200'
                }`}
              >
                {code}: {count} บิล
              </button>
            ))}
          </>
        )}
      </div>

      {/* Action bar: จำนวนที่เลือก, กล่องกรอกตัวเลข, ปุ่มเลือกทั้งหมด, สร้างใบงาน, ย้ายไปรอลงข้อมูล, ยกเลิกบิล */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-gray-600">ระบุจำนวนที่เลือก:</span>
          <input
            type="number"
            min={1}
            max={filteredOrders.length}
            value={selectQty}
            onChange={(e) => setSelectQty(e.target.value)}
            onBlur={() => applySelectQty()}
            placeholder="เช่น 10"
            className="w-20 px-2 py-1.5 border rounded-lg text-sm"
          />
          <span className="text-gray-500 text-xs">(จากบนลงล่าง)</span>
        </label>
        <button
          type="button"
          onClick={selectAll}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
        >
          เลือกทั้งหมด
        </button>
        <button
          type="button"
          onClick={clearSelection}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
        >
          ล้างการเลือก
        </button>
        <span className="text-sm text-gray-600">
          เลือกแล้ว {selectedIds.size} รายการ
        </span>
        <button
          type="button"
          onClick={handleCreateWorkOrder}
          disabled={creating || selectedIds.size === 0}
          className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
        >
          {creating ? 'กำลังสร้าง...' : `สร้างใบงาน (${selectedIds.size} รายการที่เลือก)`}
        </button>
      </div>

      {/* รายการบิล: ชื่อช่องทาง = or_orders.customer_name, ชื่อลูกค้า = or_orders.recipient_name */}
      {filteredOrders.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          {orders.length === 0 ? 'ไม่พบบิลรอสร้างใบงาน' : `ไม่พบบิลในช่องทาง ${pillChannel}`}
        </div>
      ) : (
        <div className="bg-white rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm table-auto">
              <thead>
                <tr className="bg-gray-100 border-b">
                  <th className="w-10 p-2 text-left whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={selectedIds.size === filteredOrders.length && filteredOrders.length > 0}
                      onChange={(e) => (e.target.checked ? selectAll() : clearSelection())}
                      className="rounded border-gray-300"
                    />
                  </th>
                  <th className="p-2 text-left font-medium min-w-[130px] whitespace-nowrap">เลขบิล</th>
                  <th className="p-2 text-left font-medium min-w-[180px] whitespace-nowrap">ชื่อลูกค้า</th>
                  <th className="p-2 text-left font-medium min-w-[160px] whitespace-nowrap">ชื่อช่องทาง</th>
                  <th className="p-2 text-left font-medium min-w-[160px] whitespace-nowrap">เลขคำสั่งซื้อ</th>
                  <th className="p-2 text-left font-medium min-w-[140px] whitespace-nowrap">ผู้สร้างบิล</th>
                  <th className="p-2 text-left font-medium min-w-[170px] whitespace-nowrap">เลขพัสดุ</th>
                  <th className="p-2 text-left font-medium min-w-[160px] whitespace-nowrap">วันที่ เวลา นัดรับ</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((order) => (
                  <tr
                    key={order.id}
                    className={`border-b border-gray-100 select-none ${selectedIds.has(order.id) ? 'bg-blue-50' : 'bg-white'} cursor-default`}
                  >
                    <td className="p-2 align-middle">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(order.id)}
                        onChange={() => toggleSelect(order.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded border-gray-300 cursor-pointer"
                      />
                    </td>
                    <td className="p-2 align-middle whitespace-nowrap">
                      <button type="button" onClick={(e) => { e.stopPropagation(); setDetailOrder(order) }} className="text-blue-600 font-medium hover:text-blue-800 hover:underline transition-colors">
                        {order.bill_no}
                      </button>
                      <UrgencyBadge order={order} className="ml-1.5" />
                    </td>
                    <td className="p-2 align-middle text-gray-700 max-w-[220px] truncate" title={order.recipient_name ?? ''}>
                      {order.recipient_name ?? '-'}
                    </td>
                    <td className="p-2 align-middle text-gray-700 max-w-[200px] truncate" title={order.customer_name ?? ''}>
                      {order.customer_name ?? '-'}
                    </td>
                    <td className="p-2 align-middle text-gray-700 max-w-[180px] truncate" title={order.channel_order_no ?? ''}>
                      {order.channel_order_no ?? '-'}
                    </td>
                    <td className="p-2 align-middle text-gray-700 max-w-[160px] truncate" title={order.admin_user ?? ''}>
                      {order.admin_user ?? '-'}
                    </td>
                    <td className="p-2 align-middle text-gray-700 max-w-[220px] truncate" title={order.tracking_number ?? ''}>
                      {order.tracking_number ?? '-'}
                    </td>
                    <td className="p-2 align-middle text-gray-700 whitespace-nowrap">
                      {(() => {
                        const sp = (order as Order & { scheduled_pickup_at?: string | null }).scheduled_pickup_at
                        if (!sp) return '-'
                        const d = new Date(sp)
                        if (isNaN(d.getTime())) return '-'
                        const day = String(d.getDate()).padStart(2, '0')
                        const month = String(d.getMonth() + 1).padStart(2, '0')
                        const year = d.getFullYear() + 543
                        const h = String(d.getHours()).padStart(2, '0')
                        const m = String(d.getMinutes()).padStart(2, '0')
                        return `${day}/${month}/${year} ${h}:${m} น.`
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Popup แจ้งผลสร้างใบงาน (ครั้งเดียว) */}
      {successPopup && (
        <Modal
          open
          onClose={() => setSuccessPopup(null)}
          closeOnBackdropClick
          contentClassName="max-w-sm w-full"
        >
          <div className="p-6 text-center">
            <div className="text-green-600 text-4xl mb-3">✓</div>
            <h3 className="text-lg font-bold text-gray-900 mb-1">สร้างใบงานสำเร็จ</h3>
            <p className="text-gray-600 text-sm mb-6">สร้าง {successPopup.count} ใบงานแล้ว — ดูได้ที่เมนู ใบงาน</p>
            <button
              type="button"
              onClick={() => setSuccessPopup(null)}
              className="w-full px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 font-medium"
            >
              ตกลง
            </button>
          </div>
        </Modal>
      )}

      {/* Detail Modal */}
      <Modal open={!!detailOrder} onClose={() => setDetailOrder(null)} contentClassName="max-w-6xl w-full">
        {detailOrder && <OrderDetailView order={detailOrder} onClose={() => setDetailOrder(null)} />}
      </Modal>
    </div>
  )
}
