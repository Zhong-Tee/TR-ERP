import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { formatDateTime } from '../../lib/utils'
import { Order, OrderStatus, OrderChatLog } from '../../types'
import Modal from '../ui/Modal'
import OrderForm from './OrderForm'
import { useAuthContext } from '../../contexts/AuthContext'

type ConfirmColumn = {
  key: 'new' | 'waiting' | 'confirmed' | 'all'
  title: string
  status: OrderStatus
  actionLabel?: string
  actionTargetStatus?: OrderStatus
  showWorkOrderCreated?: boolean
}

const COLUMNS: ConfirmColumn[] = [
  {
    key: 'new',
    title: 'รายการ Order ใหม่',
    status: 'ตรวจสอบแล้ว',
    actionLabel: 'ย้ายไปรอคอนเฟิร์ม',
    actionTargetStatus: 'รอคอนเฟิร์ม',
  },
  {
    key: 'waiting',
    title: 'รอคอนเฟิร์มแบบ',
    status: 'รอคอนเฟิร์ม',
    actionLabel: 'คอนเฟิร์มแล้ว',
    actionTargetStatus: 'คอนเฟิร์มแล้ว',
  },
  {
    key: 'confirmed',
    title: 'คอนเฟิร์มแล้ว',
    status: 'คอนเฟิร์มแล้ว',
  },
  {
    key: 'all',
    title: 'ทั้งหมด',
    status: 'คอนเฟิร์มแล้ว',
    showWorkOrderCreated: true,
  },
]

const CHANNEL_CODE = 'PUMP'
const STATUS_OPTIONS: Array<{ label: string; value: OrderStatus }> = [
  { label: 'Order ใหม่', value: 'ตรวจสอบแล้ว' },
  { label: 'รอคอนเฟิร์มแบบ', value: 'รอคอนเฟิร์ม' },
  { label: 'คอนเฟิร์มแล้ว', value: 'คอนเฟิร์มแล้ว' },
]

export default function OrderConfirmBoard() {
  const { user } = useAuthContext()
  const [ordersByKey, setOrdersByKey] = useState<Record<ConfirmColumn['key'], Order[]>>({
    new: [],
    waiting: [],
    confirmed: [],
    all: [],
  })
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [detailOrder, setDetailOrder] = useState<Order | null>(null)
  const [statusModal, setStatusModal] = useState<{
    order: Order
    targetStatus: OrderStatus
    label: string
  } | null>(null)
  const [noteText, setNoteText] = useState('')
  const [updating, setUpdating] = useState(false)
  const [chatOrder, setChatOrder] = useState<Order | null>(null)
  const [chatLogs, setChatLogs] = useState<OrderChatLog[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatMessage, setChatMessage] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, fromDate, toDate])

  async function loadAll() {
    setLoading(true)
    try {
      const [newOrders, waitingOrders, confirmedOrders, workOrderCreatedOrders] = await Promise.all([
        loadOrdersByStatus('ตรวจสอบแล้ว'),
        loadOrdersByStatus('รอคอนเฟิร์ม'),
        loadOrdersByStatus('คอนเฟิร์มแล้ว', { workOrderCreatedOnly: false }),
        loadOrdersByStatus('คอนเฟิร์มแล้ว', { workOrderCreatedOnly: true }),
      ])
      setOrdersByKey({
        new: newOrders,
        waiting: waitingOrders,
        confirmed: confirmedOrders,
        all: workOrderCreatedOrders,
      })
    } catch (error) {
      console.error('Error loading confirm orders:', error)
    } finally {
      setLoading(false)
    }
  }

  async function loadOrdersByStatus(
    status: OrderStatus,
    options?: { workOrderCreatedOnly?: boolean }
  ): Promise<Order[]> {
    const workOrderCreatedOnly = options?.workOrderCreatedOnly
    let query = supabase
      .from('or_orders')
      .select('*, or_order_items(*)')
      .eq('channel_code', CHANNEL_CODE)
      .eq('status', status)
      .order('created_at', { ascending: false })

    if (workOrderCreatedOnly === true) {
      query = query.not('work_order_name', 'is', null)
    }
    if (workOrderCreatedOnly === false) {
      query = query.is('work_order_name', null)
    }
    if (fromDate) {
      query = query.gte('created_at', `${fromDate}T00:00:00.000Z`)
    }
    if (toDate) {
      query = query.lte('created_at', `${toDate}T23:59:59.999Z`)
    }

    const { data, error } = await query
    if (error) throw error

    const list = (data || []) as Order[]
    if (list.length === 0) return []

    const orderIds = list.map((o) => o.id).filter(Boolean)
    if (orderIds.length === 0) return []

    const { data: slipRows } = await supabase
      .from('ac_verified_slips')
      .select('order_id')
      .in('order_id', orderIds)
      .eq('is_deleted', false)

    const verifiedSet = new Set((slipRows || []).map((r: { order_id: string }) => r.order_id))
    return list.filter((o) => verifiedSet.has(o.id))
  }

  function openStatusModal(order: Order, targetStatus: OrderStatus, label: string) {
    setNoteText(order.confirm_note || '')
    setStatusModal({ order, targetStatus, label })
  }

  async function openChat(order: Order) {
    setChatOrder(order)
    setChatMessage('')
    setChatLogs([])
    setChatLoading(true)
    try {
      const { data, error } = await supabase
        .from('or_order_chat_logs')
        .select('*')
        .eq('order_id', order.id)
        .order('created_at', { ascending: true })
      if (error) throw error
      setChatLogs((data || []) as OrderChatLog[])
    } catch (error) {
      console.error('Error loading chat logs:', error)
    } finally {
      setChatLoading(false)
    }
  }

  async function handleSendChat() {
    if (!chatOrder || !user) return
    const message = chatMessage.trim()
    if (!message) return
    setChatSending(true)
    try {
      const payload = {
        order_id: chatOrder.id,
        bill_no: chatOrder.bill_no,
        sender_id: user.id,
        sender_name: user.username || user.email || 'ผู้ใช้',
        message,
      }
      const { data, error } = await supabase
        .from('or_order_chat_logs')
        .insert(payload)
        .select('*')
        .single()
      if (error) throw error
      if (data) {
        setChatLogs((prev) => [...prev, data as OrderChatLog])
      }
      setChatMessage('')
    } catch (error: any) {
      console.error('Error sending chat:', error)
      alert('เกิดข้อผิดพลาด: ' + (error?.message || error))
    } finally {
      setChatSending(false)
    }
  }

  async function handleStatusUpdate() {
    if (!statusModal) return
    setUpdating(true)
    try {
      const { error } = await supabase
        .from('or_orders')
        .update({
          status: statusModal.targetStatus,
          confirm_note: noteText.trim() || null,
        })
        .eq('id', statusModal.order.id)

      if (error) throw error
      setStatusModal(null)
      setNoteText('')
      setRefreshKey((k) => k + 1)
    } catch (error: any) {
      console.error('Error updating confirm status:', error)
      alert('เกิดข้อผิดพลาด: ' + (error?.message || error))
    } finally {
      setUpdating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">จากวันที่</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="px-3 py-2 border rounded-lg"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">ถึงวันที่</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="px-3 py-2 border rounded-lg"
          />
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 min-h-0">
      {COLUMNS.map((column) => {
        const orders = ordersByKey[column.key] || []
        return (
          <div key={column.key} className="bg-white rounded-lg shadow overflow-hidden flex flex-col min-h-0">
            <div className="p-4 border-b bg-gray-50 shrink-0">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-bold">{column.title}</h2>
                <span className="text-sm text-gray-600">{orders.length} รายการ</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">ช่องทาง: {CHANNEL_CODE}</p>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 divide-y">
              {orders.length === 0 ? (
                <div className="p-6 text-center text-gray-500">ไม่พบรายการ</div>
              ) : (
                orders.map((order) => (
                  <div key={order.id} className="p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-blue-600 truncate">{order.bill_no}</div>
                        <div className="text-sm text-gray-700 truncate">{order.customer_name}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-semibold text-green-600">
                          ฿{Number(order.total_amount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                        <div className="text-xs text-gray-500">{formatDateTime(order.created_at)}</div>
                      </div>
                    </div>
                    {order.confirm_note && (
                      <div className="mt-2 text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded p-2">
                        หมายเหตุ: {order.confirm_note}
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setDetailOrder(order)}
                        className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
                      >
                        ดูรายละเอียด
                      </button>
                      {column.actionTargetStatus && column.actionLabel && (
                        <button
                          type="button"
                          onClick={() => openStatusModal(order, column.actionTargetStatus as OrderStatus, column.actionLabel)}
                          className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
                        >
                          {column.actionLabel}
                        </button>
                      )}
                      {column.key === 'confirmed' && (
                        <button
                          type="button"
                          onClick={() => openStatusModal(order, 'รอคอนเฟิร์ม', 'เปลี่ยนสถานะ')}
                          className="px-3 py-1.5 bg-amber-500 text-white rounded-lg text-sm hover:bg-amber-600"
                        >
                          เปลี่ยนสถานะ
                        </button>
                      )}
                      {(column.key === 'waiting' || column.key === 'confirmed' || column.key === 'all') && (
                        <button
                          type="button"
                          onClick={() => openChat(order)}
                          className="px-3 py-1.5 bg-gray-700 text-white rounded-lg text-sm hover:bg-gray-800"
                        >
                          Chat
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )
      })}

      <Modal
        open={!!statusModal}
        onClose={() => {
          if (!updating) setStatusModal(null)
        }}
        contentClassName="max-w-lg w-full"
      >
        {statusModal && (
          <div className="p-6 space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">อัปเดตสถานะ</h3>
              <p className="text-sm text-gray-600 mt-1">
                {statusModal.label}: {statusModal.order.bill_no}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">สถานะ</label>
              <select
                value={statusModal.targetStatus}
                onChange={(e) =>
                  setStatusModal((prev) =>
                    prev ? { ...prev, targetStatus: e.target.value as OrderStatus } : prev
                  )
                }
                className="w-full px-3 py-2 border rounded-lg border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">หมายเหตุ</label>
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                rows={4}
                placeholder="กรอกหมายเหตุเพิ่มเติม..."
                className="w-full px-3 py-2 border rounded-lg border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStatusModal(null)}
                disabled={updating}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={handleStatusUpdate}
                disabled={updating}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {updating ? 'กำลังบันทึก...' : 'บันทึก'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!detailOrder}
        onClose={() => setDetailOrder(null)}
        contentClassName="max-w-6xl w-full"
      >
        {detailOrder && (
          <div className="flex flex-col max-h-[85vh]">
            <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">รายละเอียดบิล</h3>
              <button
                type="button"
                onClick={() => setDetailOrder(null)}
                className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
              >
                ปิดหน้าต่าง
              </button>
            </div>
            <div className="p-4 overflow-y-auto">
              <OrderForm
                order={detailOrder}
                onSave={() => {}}
                onCancel={() => setDetailOrder(null)}
                readOnly
                viewOnly
              />
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!chatOrder}
        onClose={() => {
          if (!chatSending) setChatOrder(null)
        }}
        contentClassName="max-w-2xl w-full"
      >
        {chatOrder && (
          <div className="flex flex-col max-h-[80vh]">
            <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Chat</h3>
                <p className="text-sm text-gray-600">บิล {chatOrder.bill_no}</p>
              </div>
              <button
                type="button"
                onClick={() => setChatOrder(null)}
                className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
              >
                ปิดหน้าต่าง
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {chatLoading ? (
                <div className="flex justify-center items-center py-6">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
                </div>
              ) : chatLogs.length === 0 ? (
                <div className="text-center text-gray-500 py-6">ยังไม่มีข้อความ</div>
              ) : (
                chatLogs.map((log) => (
                  <div key={log.id} className="border border-gray-200 rounded-lg p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-gray-900">{log.sender_name}</div>
                      <div className="text-xs text-gray-500">{formatDateTime(log.created_at)}</div>
                    </div>
                    <div className="mt-2 text-sm text-gray-800 whitespace-pre-wrap">{log.message}</div>
                  </div>
                ))
              )}
            </div>
            <div className="p-4 border-t bg-white space-y-3">
              <textarea
                value={chatMessage}
                onChange={(e) => setChatMessage(e.target.value)}
                rows={3}
                placeholder="พิมพ์ข้อความ..."
                className="w-full px-3 py-2 border rounded-lg border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleSendChat}
                  disabled={chatSending || chatMessage.trim() === ''}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {chatSending ? 'กำลังส่ง...' : 'ส่งข้อความ'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>
      </div>
    </div>
  )
}
