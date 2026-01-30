import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { Order } from '../../types'
import Modal from '../ui/Modal'

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
        .select('id, bill_no, customer_name, admin_user, tracking_number, channel_code')
        .eq('status', 'ใบสั่งงาน')
        .is('work_order_name', null)
        .order('created_at', { ascending: false })

      if (searchTerm) {
        query = query.or(
          `bill_no.ilike.%${searchTerm}%,customer_name.ilike.%${searchTerm}%,admin_user.ilike.%${searchTerm}%,tracking_number.ilike.%${searchTerm}%`
        )
      }
      if (channelFilter) {
        query = query.eq('channel_code', channelFilter)
      }

      const { data, error } = await query.limit(500)
      if (error) throw error
      const list = (data || []) as Order[]
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

  const channelCounts = orders.reduce<Record<string, number>>((acc, o) => {
    const ch = o.channel_code || 'N/A'
    acc[ch] = (acc[ch] || 0) + 1
    return acc
  }, {})
  const channelList = Object.entries(channelCounts).sort(([a], [b]) => a.localeCompare(b))
  const filteredOrders = pillChannel ? orders.filter((o) => o.channel_code === pillChannel) : orders

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
    const topN = orders.slice(0, n).map((o) => o.id)
    setSelectedIds(new Set(topN))
  }

  useEffect(() => {
    if (selectQty === '') {
      setSelectedIds(new Set())
      return
    }
    const list = pillChannel ? orders.filter((o) => o.channel_code === pillChannel) : orders
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

  async function handleCreateWorkOrder() {
    if (selectedOrders.length === 0) {
      alert('กรุณาเลือกรายการบิลอย่างน้อย 1 รายการ')
      return
    }

    setCreating(true)
    try {
      const byChannel = selectedOrders.reduce<Record<string, Order[]>>((acc, o) => {
        const ch = o.channel_code || 'N/A'
        if (!acc[ch]) acc[ch] = []
        acc[ch].push(o)
        return acc
      }, {})

      const today = new Date()
      const datePart = today.toLocaleDateString('th-TH', { year: '2-digit', month: '2-digit', day: '2-digit' }).replace(/\//g, '')

      for (const [channelCode, channelOrders] of Object.entries(byChannel)) {
        const { data: existing } = await supabase
          .from('or_work_orders')
          .select('work_order_name')
          .like('work_order_name', `${channelCode}-${datePart}-%`)
          .order('work_order_name', { ascending: false })
          .limit(1)

        const lastName = (existing && existing[0]?.work_order_name) || ''
        const match = lastName.match(new RegExp(`${channelCode}-${datePart}-R(\\d+)`))
        const nextBatch = match ? parseInt(match[1], 10) + 1 : 1
        const workOrderName = `${channelCode}-${datePart}-R${nextBatch}`

        const { error: insertError } = await supabase.from('or_work_orders').insert({
          work_order_name: workOrderName,
          status: 'กำลังผลิต',
          order_count: channelOrders.length,
        })
        if (insertError) throw insertError

        const orderIds = channelOrders.map((o) => o.id)
        const { error: updateError } = await supabase
          .from('or_orders')
          .update({ work_order_name: workOrderName })
          .in('id', orderIds)
        if (updateError) throw updateError
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

      {/* รายการบิล: บรรทัดเดียว เลขบิล | ชื่อลูกค้า | ผู้ลงข้อมูล | เลขพัสดุ + checkbox (ไม่ให้คลิกแถว) */}
      {filteredOrders.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          {orders.length === 0 ? 'ไม่พบบิลรอสร้างใบงาน' : `ไม่พบบิลในช่องทาง ${pillChannel}`}
        </div>
      ) : (
        <div className="bg-white rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-100 border-b">
                  <th className="w-10 p-2 text-left">
                    <input
                      type="checkbox"
                      checked={selectedIds.size === filteredOrders.length && filteredOrders.length > 0}
                      onChange={(e) => (e.target.checked ? selectAll() : clearSelection())}
                      className="rounded border-gray-300"
                    />
                  </th>
                  <th className="p-2 text-left font-medium w-32">เลขบิล</th>
                  <th className="p-2 text-left font-medium min-w-[140px]">ชื่อลูกค้า</th>
                  <th className="p-2 text-left font-medium w-28">ผู้ลงข้อมูล</th>
                  <th className="w-16 shrink-0" aria-hidden="true" />
                  <th className="p-2 text-left font-medium min-w-[120px] w-40">เลขพัสดุ</th>
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
                    <td className="p-2 align-middle">
                      <span className="text-blue-600 font-medium">{order.bill_no}</span>
                    </td>
                    <td className="p-2 align-middle text-gray-700 max-w-[200px] truncate" title={(order as Order).customer_name ?? ''}>
                      {(order as Order).customer_name ?? '-'}
                    </td>
                    <td className="p-2 align-middle text-gray-700">{order.admin_user ?? '-'}</td>
                    <td className="w-16 shrink-0" aria-hidden="true" />
                    <td className="p-2 align-middle text-gray-700">{order.tracking_number ?? '-'}</td>
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
    </div>
  )
}
