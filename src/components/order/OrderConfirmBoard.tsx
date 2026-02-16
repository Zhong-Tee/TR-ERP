import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { formatDateTime } from '../../lib/utils'
import { Order, OrderStatus, OrderChatLog } from '../../types'
import Modal from '../ui/Modal'
import { useAuthContext } from '../../contexts/AuthContext'
import OrderDetailView from './OrderDetailView'

/* ─────────────────────── Types & Constants ─────────────────────── */

type ConfirmColumnKey = 'new' | 'design' | 'designed' | 'waiting' | 'confirmed' | 'completed'

type ViewMode = 'default' | 'new' | 'completed'

interface ConfirmColumn {
  key: ConfirmColumnKey
  title: string
  status: OrderStatus
  actionLabel?: string
  actionTargetStatus?: OrderStatus
  headerGradient: string
  countBadge: string
  actionBtn?: string
}

/** คอลัมน์ปกติ (default view): รอออกแบบ, ออกแบบแล้ว, รอคอนเฟิร์มแบบ, คอนเฟิร์มแล้ว */
const DEFAULT_COLUMNS: ConfirmColumn[] = [
  {
    key: 'design',
    title: 'รอออกแบบ',
    status: 'รอออกแบบ',
    actionLabel: 'เปลี่ยนสถานะ',
    actionTargetStatus: 'ออกแบบแล้ว',
    headerGradient: 'bg-gradient-to-r from-violet-500 to-purple-600',
    countBadge: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
    actionBtn:
      'bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 text-white shadow-sm',
  },
  {
    key: 'designed',
    title: 'ออกแบบแล้ว',
    status: 'ออกแบบแล้ว',
    actionLabel: 'เปลี่ยนสถานะ',
    actionTargetStatus: 'รอคอนเฟิร์ม',
    headerGradient: 'bg-gradient-to-r from-indigo-500 to-blue-600',
    countBadge: 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200',
    actionBtn:
      'bg-gradient-to-r from-indigo-500 to-blue-600 hover:from-indigo-600 hover:to-blue-700 text-white shadow-sm',
  },
  {
    key: 'waiting',
    title: 'รอคอนเฟิร์มแบบ',
    status: 'รอคอนเฟิร์ม',
    actionLabel: 'คอนเฟิร์มแล้ว',
    actionTargetStatus: 'คอนเฟิร์มแล้ว',
    headerGradient: 'bg-gradient-to-r from-amber-500 to-orange-500',
    countBadge: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
    actionBtn:
      'bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white shadow-sm',
  },
  {
    key: 'confirmed',
    title: 'คอนเฟิร์มแล้ว',
    status: 'คอนเฟิร์มแล้ว',
    actionLabel: 'เสร็จสิ้น',
    actionTargetStatus: 'เสร็จสิ้น',
    headerGradient: 'bg-gradient-to-r from-emerald-500 to-green-600',
    countBadge: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    actionBtn:
      'bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700 text-white shadow-sm',
  },
]

/** คอลัมน์ "งานใหม่" (new view) */
const NEW_COLUMN: ConfirmColumn = {
  key: 'new',
  title: 'รายการ Order ใหม่',
  status: 'ตรวจสอบแล้ว',
  actionLabel: 'เปลี่ยนสถานะ',
  actionTargetStatus: 'รอออกแบบ',
  headerGradient: 'bg-gradient-to-r from-blue-500 to-blue-600',
  countBadge: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  actionBtn:
    'bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white shadow-sm',
}

/** คอลัมน์ "เสร็จสิ้น" (completed view) — ไม่มีปุ่มเปลี่ยนสถานะ */
const COMPLETED_COLUMN: ConfirmColumn = {
  key: 'completed',
  title: 'เสร็จสิ้น',
  status: 'เสร็จสิ้น',
  headerGradient: 'bg-gradient-to-r from-teal-500 to-cyan-600',
  countBadge: 'bg-teal-50 text-teal-700 ring-1 ring-teal-200',
}

const CHANNEL_CODE = 'PUMP'

const STATUS_OPTIONS: Array<{ label: string; value: OrderStatus }> = [
  { label: 'Order ใหม่', value: 'ตรวจสอบแล้ว' },
  { label: 'รอออกแบบ', value: 'รอออกแบบ' },
  { label: 'ออกแบบแล้ว', value: 'ออกแบบแล้ว' },
  { label: 'รอคอนเฟิร์มแบบ', value: 'รอคอนเฟิร์ม' },
  { label: 'คอนเฟิร์มแล้ว', value: 'คอนเฟิร์มแล้ว' },
  { label: 'เสร็จสิ้น', value: 'เสร็จสิ้น' },
]

/* ─────────────────────── Column Icon ─────────────────────── */

function ColumnIcon({ columnKey }: { columnKey: ConfirmColumnKey }) {
  const cls = 'w-5 h-5 shrink-0'
  switch (columnKey) {
    case 'new':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      )
    case 'design':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
        </svg>
      )
    case 'designed':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      )
    case 'waiting':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )
    case 'confirmed':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )
    case 'completed':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
      )
  }
}

/* ─────────────────────── Component ─────────────────────── */

interface OrderConfirmBoardProps {
  onCountChange?: (count: number) => void
}

export default function OrderConfirmBoard({ onCountChange }: OrderConfirmBoardProps) {
  const { user } = useAuthContext()
  const [ordersByKey, setOrdersByKey] = useState<Record<ConfirmColumnKey, Order[]>>({
    new: [],
    design: [],
    designed: [],
    waiting: [],
    confirmed: [],
    completed: [],
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
  const [fromDate, setFromDate] = useState(() => new Date().toISOString().split('T')[0])
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0])
  const [viewMode, setViewMode] = useState<ViewMode>('default')
  const [sendOnEnter, setSendOnEnter] = useState(false)
  const [unreadByOrder, setUnreadByOrder] = useState<Record<string, number>>({})

  /* ── Data Loading ── */

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, fromDate, toDate])

  // Realtime subscription for order chat logs → update unread counts
  useEffect(() => {
    const channel = supabase
      .channel('confirm-board-chat')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'or_order_chat_logs' }, (payload) => {
        const row = payload.new as OrderChatLog
        // ถ้า chat เปิดอยู่สำหรับ order นี้ → เพิ่ม message เข้า log ทันที + mark read
        if (chatOrder && chatOrder.id === row.order_id) {
          setChatLogs((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]))
          if (user && !(user.role === 'superadmin' || user.role === 'admin')) {
            supabase.from('or_order_chat_reads').upsert({
              order_id: row.order_id,
              user_id: user.id,
              last_read_at: new Date().toISOString(),
            })
          }
        } else {
          // chat ไม่ได้เปิด → เพิ่ม unread count
          setUnreadByOrder((prev) => ({ ...prev, [row.order_id]: (prev[row.order_id] || 0) + 1 }))
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [chatOrder, user])

  // Load unread counts เมื่อ orders เปลี่ยน
  useEffect(() => {
    if (!user) return
    const allOrders = Object.values(ordersByKey).flat()
    const orderIds = allOrders.map((o) => o.id).filter(Boolean)
    if (orderIds.length === 0) return
    loadOrderUnreadCounts(orderIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordersByKey, user])

  async function loadOrderUnreadCounts(orderIds: string[]) {
    if (!user || orderIds.length === 0) {
      setUnreadByOrder({})
      return
    }
    try {
      const [{ data: reads }, { data: messages }] = await Promise.all([
        supabase.from('or_order_chat_reads').select('order_id, last_read_at').eq('user_id', user.id),
        supabase.from('or_order_chat_logs').select('order_id, created_at').eq('is_hidden', false).in('order_id', orderIds),
      ])
      const readMap = new Map(
        (reads || []).map((r: any) => [r.order_id, new Date(r.last_read_at).getTime()])
      )
      const counts: Record<string, number> = {}
      ;(messages || []).forEach((m: { order_id: string; created_at: string }) => {
        const lastRead = readMap.get(m.order_id) ?? 0
        const msgTime = new Date(m.created_at).getTime()
        if (msgTime > lastRead) {
          counts[m.order_id] = (counts[m.order_id] || 0) + 1
        }
      })
      setUnreadByOrder(counts)
    } catch (error) {
      console.error('Error loading order unread counts:', error)
    }
  }

  async function loadAll() {
    setLoading(true)
    try {
      const [newOrders, designOrders, designedOrders, waitingOrders, confirmedOrders, completedOrders] =
        await Promise.all([
          loadOrdersByStatus('ตรวจสอบแล้ว'),
          loadOrdersByStatus('รอออกแบบ'),
          loadOrdersByStatus('ออกแบบแล้ว'),
          loadOrdersByStatus('รอคอนเฟิร์ม'),
          loadOrdersByStatus('คอนเฟิร์มแล้ว'),
          loadOrdersByStatus('เสร็จสิ้น'),
        ])
      setOrdersByKey({
        new: newOrders,
        design: designOrders,
        designed: designedOrders,
        waiting: waitingOrders,
        confirmed: confirmedOrders,
        completed: completedOrders,
      })
      // รายงานจำนวนจริงกลับไปที่ tab (ไม่รวมเสร็จสิ้น)
      onCountChange?.(newOrders.length + designOrders.length + designedOrders.length + waitingOrders.length + confirmedOrders.length)
    } catch (error) {
      console.error('Error loading confirm orders:', error)
    } finally {
      setLoading(false)
    }
  }

  async function loadOrdersByStatus(status: OrderStatus): Promise<Order[]> {
    let query = supabase
      .from('or_orders')
      .select('*, or_order_items(*)')
      .eq('channel_code', CHANNEL_CODE)
      .eq('status', status)
      .order('created_at', { ascending: false })

    if (fromDate) query = query.gte('created_at', `${fromDate}T00:00:00.000Z`)
    if (toDate) query = query.lte('created_at', `${toDate}T23:59:59.999Z`)

    const { data, error } = await query
    if (error) throw error

    return (data || []) as Order[]
  }

  /* ── Event Handlers ── */

  function openStatusModal(order: Order, targetStatus: OrderStatus, label: string) {
    setNoteText(order.confirm_note || '')
    setStatusModal({ order, targetStatus, label })
  }

  const isAdminRole = user?.role === 'superadmin' || user?.role === 'admin'

  async function openChat(order: Order) {
    setChatOrder(order)
    setChatMessage('')
    setChatLogs([])
    setChatLoading(true)
    try {
      // Mark as read (ข้าม superadmin/admin เพื่อไม่ให้ badge ลด)
      if (user && !isAdminRole) {
        await supabase.from('or_order_chat_reads').upsert({
          order_id: order.id,
          user_id: user.id,
          last_read_at: new Date().toISOString(),
        })
        setUnreadByOrder((prev) => ({ ...prev, [order.id]: 0 }))
        window.dispatchEvent(new Event('order-chat-read'))
      }
      const { data, error } = await supabase
        .from('or_order_chat_logs')
        .select('*')
        .eq('order_id', order.id)
        .eq('is_hidden', false)
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
      if (data) setChatLogs((prev) => [...prev, data as OrderChatLog])
      setChatMessage('')
      // Mark as read after sending (ข้าม superadmin/admin)
      if (!isAdminRole) {
        await supabase.from('or_order_chat_reads').upsert({
          order_id: chatOrder.id,
          user_id: user.id,
          last_read_at: new Date().toISOString(),
        })
      }
    } catch (error: any) {
      console.error('Error sending chat:', error)
      alert('เกิดข้อผิดพลาด: ' + (error?.message || error))
    } finally {
      setChatSending(false)
    }
  }

  async function handleHideChat(chatId: string) {
    try {
      const { error } = await supabase
        .from('or_order_chat_logs')
        .update({ is_hidden: true })
        .eq('id', chatId)
      if (error) throw error
      // ลบออกจาก state ทันที
      setChatLogs((prev) => prev.filter((log) => log.id !== chatId))
    } catch (error: any) {
      console.error('Error hiding chat:', error)
      alert('เกิดข้อผิดพลาด: ' + (error?.message || error))
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

  /* ── Derived ── */

  let visibleColumns: ConfirmColumn[]
  let gridCols: string
  if (viewMode === 'new') {
    visibleColumns = [NEW_COLUMN]
    gridCols = 'lg:grid-cols-1 max-w-2xl'
  } else if (viewMode === 'completed') {
    visibleColumns = [COMPLETED_COLUMN]
    gridCols = 'lg:grid-cols-1 max-w-2xl'
  } else {
    visibleColumns = DEFAULT_COLUMNS
    gridCols = 'lg:grid-cols-4'
  }

  /* ── Loading ── */

  if (loading) {
    return (
      <div className="flex justify-center items-center py-16">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-blue-200 border-t-blue-500" />
      </div>
    )
  }

  /* ── Render ── */

  return (
    <div className="space-y-4">
      {/* ── Filter Bar ── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-wrap items-center gap-3">
        <svg className="w-5 h-5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>

        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-600">จากวันที่</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none transition-all"
          />
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-600">ถึงวันที่</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none transition-all"
          />
        </div>

        <div className="flex-1" />

        {/* งานใหม่ button */}
        <button
          type="button"
          onClick={() => setViewMode((v) => (v === 'new' ? 'default' : 'new'))}
          className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition-all ${
            viewMode === 'new'
              ? 'bg-gradient-to-r from-blue-500 to-blue-600 text-white shadow-md ring-2 ring-blue-300'
              : 'bg-white text-blue-600 hover:bg-blue-50 border border-blue-300 shadow-sm'
          }`}
        >
          <ColumnIcon columnKey="new" />
          งานใหม่
          <span
            className={`px-2 py-0.5 rounded-full text-xs font-bold ${
              viewMode === 'new' ? 'bg-white/20 text-white' : 'bg-blue-100 text-blue-600'
            }`}
          >
            {ordersByKey.new.length}
          </span>
        </button>

        {/* เสร็จสิ้น button */}
        <button
          type="button"
          onClick={() => setViewMode((v) => (v === 'completed' ? 'default' : 'completed'))}
          className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition-all ${
            viewMode === 'completed'
              ? 'bg-gradient-to-r from-teal-500 to-cyan-600 text-white shadow-md ring-2 ring-teal-300'
              : 'bg-white text-teal-600 hover:bg-teal-50 border border-teal-300 shadow-sm'
          }`}
        >
          <ColumnIcon columnKey="completed" />
          เสร็จสิ้น
          <span
            className={`px-2 py-0.5 rounded-full text-xs font-bold ${
              viewMode === 'completed' ? 'bg-white/20 text-white' : 'bg-teal-100 text-teal-600'
            }`}
          >
            {ordersByKey.completed.length}
          </span>
        </button>
      </div>

      {/* ── Columns Grid ── */}
      <div className={`grid grid-cols-1 ${gridCols} gap-4 min-h-0`}>
        {visibleColumns.map((column) => {
          const orders = ordersByKey[column.key] || []
          return (
            <div
              key={column.key}
              className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col min-h-0"
            >
              {/* Column Header */}
              <div className={`p-4 ${column.headerGradient} text-white shrink-0`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <ColumnIcon columnKey={column.key} />
                    <h2 className="text-sm font-bold truncate">{column.title}</h2>
                  </div>
                  <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${column.countBadge}`}>
                    {orders.length}
                  </span>
                </div>
                <p className="text-xs text-white/70 mt-1">ช่องทาง: {CHANNEL_CODE}</p>
              </div>

              {/* Column Body */}
              <div className="flex-1 overflow-y-auto min-h-0 p-2 space-y-2 bg-gray-50/50">
                {orders.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-gray-400">
                    <svg className="w-10 h-10 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                    </svg>
                    <p className="text-sm">ไม่พบรายการ</p>
                  </div>
                ) : (
                  orders.map((order) => (
                    <div
                      key={order.id}
                      className="bg-white rounded-lg p-3 border border-gray-100 hover:border-gray-300 hover:shadow-sm transition-all"
                    >
                      {/* Order Info */}
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div className="min-w-0">
                          <div className="font-semibold text-blue-600 text-sm truncate">{order.bill_no}</div>
                          <div className="text-xs text-gray-500 truncate">{order.customer_name}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-bold text-emerald-600 text-sm">
                            ฿{Number(order.total_amount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                          <div className="text-[11px] text-gray-400">{formatDateTime(order.created_at)}</div>
                        </div>
                      </div>

                      {/* Note */}
                      {order.confirm_note && (
                        <div className="mt-1.5 text-xs text-gray-600 bg-amber-50 border border-amber-100 rounded-md px-2 py-1.5">
                          <span className="font-medium text-amber-700">หมายเหตุ:</span> {order.confirm_note}
                        </div>
                      )}

                      {/* Action Buttons */}
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {/* ดูรายละเอียด */}
                        <button
                          type="button"
                          onClick={() => setDetailOrder(order)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-colors"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                          ดูรายละเอียด
                        </button>

                        {/* Column action button */}
                        {column.actionTargetStatus && column.actionLabel && (
                          <button
                            type="button"
                            onClick={() => openStatusModal(order, column.actionTargetStatus as OrderStatus, column.actionLabel as string)}
                            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${column.actionBtn}`}
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                            </svg>
                            {column.actionLabel}
                          </button>
                        )}

                        {/* Change status (confirmed column) */}
                        {column.key === 'confirmed' && (
                          <button
                            type="button"
                            onClick={() => openStatusModal(order, 'รอคอนเฟิร์ม', 'เปลี่ยนสถานะ')}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-500 hover:to-amber-600 text-white rounded-lg text-xs font-medium shadow-sm transition-all"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            เปลี่ยนสถานะ
                          </button>
                        )}

                        {/* File attachment */}
                        {['design', 'designed', 'waiting', 'confirmed'].includes(column.key) && (() => {
                          const orderItems = ((order as any).or_order_items || []) as Array<{ file_attachment?: string | null }>
                          const fileLinks = orderItems.map((i) => i.file_attachment).filter((f): f is string => !!f && f.trim() !== '')
                          if (fileLinks.length === 0) return null
                          return fileLinks.map((link, fi) => (
                            <button
                              key={fi}
                              type="button"
                              onClick={() => window.open(link, '_blank')}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 text-white rounded-lg text-xs font-medium shadow-sm transition-all"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                              </svg>
                              ไฟล์{fileLinks.length > 1 ? ` ${fi + 1}` : ''}
                            </button>
                          ))
                        })()}

                        {/* Chat */}
                        {column.key !== 'new' && (
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openChat(order)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-gradient-to-r from-gray-600 to-gray-700 hover:from-gray-700 hover:to-gray-800 text-white rounded-lg text-xs font-medium shadow-sm transition-all"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                              </svg>
                              Chat
                            </button>
                            {(unreadByOrder[order.id] || 0) > 0 && (
                              <span className="min-w-[1.2rem] h-5 px-1.5 flex items-center justify-center rounded-full text-[10px] font-bold bg-red-500 text-white animate-pulse">
                                {unreadByOrder[order.id]}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Status Update Modal ── */}
      <Modal
        open={!!statusModal}
        onClose={() => { if (!updating) setStatusModal(null) }}
        contentClassName="max-w-lg w-full"
      >
        {statusModal && (
          <div className="p-6 space-y-5">
            <div>
              <h3 className="text-lg font-bold text-gray-900">อัปเดตสถานะ</h3>
              <p className="text-sm text-gray-500 mt-1">
                {statusModal.label}: <span className="font-semibold text-blue-600">{statusModal.order.bill_no}</span>
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">สถานะ</label>
              <select
                value={statusModal.targetStatus}
                onChange={(e) => setStatusModal((prev) => prev ? { ...prev, targetStatus: e.target.value as OrderStatus } : prev)}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-200 focus:border-blue-400 text-sm outline-none transition-all"
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">หมายเหตุ</label>
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                rows={4}
                placeholder="กรอกหมายเหตุเพิ่มเติม..."
                className="w-full px-3 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-200 focus:border-blue-400 text-sm outline-none transition-all resize-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setStatusModal(null)} disabled={updating} className="px-4 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors">
                ยกเลิก
              </button>
              <button type="button" onClick={handleStatusUpdate} disabled={updating} className="px-5 py-2.5 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50 shadow-sm transition-all">
                {updating ? 'กำลังบันทึก...' : 'บันทึก'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Detail Modal ── */}
      <Modal open={!!detailOrder} onClose={() => setDetailOrder(null)} contentClassName="max-w-6xl w-full">
        {detailOrder && <OrderDetailView order={detailOrder} onClose={() => setDetailOrder(null)} />}
      </Modal>

      {/* ── Chat Modal ── */}
      <Modal
        open={!!chatOrder}
        onClose={() => { if (!chatSending) setChatOrder(null) }}
        contentClassName="max-w-2xl w-full"
      >
        {chatOrder && (
          <div className="flex flex-col max-h-[80vh]">
            <div className="p-4 border-b bg-gradient-to-r from-gray-700 to-gray-800 text-white flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold">Chat</h3>
                <p className="text-sm text-gray-300">บิล {chatOrder.bill_no}</p>
              </div>
              <button type="button" onClick={() => setChatOrder(null)} className="px-3 py-1.5 border border-gray-500 rounded-lg text-sm font-medium text-white hover:bg-gray-600 transition-colors">
                ปิดหน้าต่าง
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50">
              {chatLoading ? (
                <div className="flex justify-center items-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-4 border-blue-200 border-t-blue-500" />
                </div>
              ) : chatLogs.length === 0 ? (
                <div className="flex flex-col items-center py-8 text-gray-400">
                  <svg className="w-10 h-10 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  <p className="text-sm">ยังไม่มีข้อความ</p>
                </div>
              ) : (
                chatLogs.map((log) => (
                  <div key={log.id} className="bg-white border border-gray-200 rounded-xl p-3 shadow-sm group">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-gray-900">{log.sender_name}</div>
                      <div className="flex items-center gap-2">
                        <div className="text-xs text-gray-400">{formatDateTime(log.created_at)}</div>
                        <button
                          type="button"
                          onClick={() => handleHideChat(log.id)}
                          title="ซ่อนข้อความนี้"
                          className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 transition-all"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    <div className="mt-1.5 text-sm text-gray-700 whitespace-pre-wrap">{log.message}</div>
                  </div>
                ))
              )}
            </div>
            <div className="p-4 border-t bg-white space-y-3">
              <textarea
                value={chatMessage}
                onChange={(e) => setChatMessage(e.target.value)}
                onKeyDown={(e) => {
                  // ข้ามระหว่าง IME composition (พิมพ์ภาษาไทย)
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return

                  if (e.key === 'Enter') {
                    if (sendOnEnter && !e.shiftKey) {
                      e.preventDefault()
                      if (chatMessage.trim() && !chatSending) handleSendChat()
                    } else {
                      // แทรก \n เอง เพื่อแก้ปัญหา Thai IME บน Windows
                      e.preventDefault()
                      const ta = e.target as HTMLTextAreaElement
                      const start = ta.selectionStart
                      const end = ta.selectionEnd
                      const newVal = chatMessage.substring(0, start) + '\n' + chatMessage.substring(end)
                      setChatMessage(newVal)
                      requestAnimationFrame(() => {
                        ta.selectionStart = ta.selectionEnd = start + 1
                      })
                    }
                  }
                }}
                rows={3}
                placeholder={sendOnEnter ? 'พิมพ์ข้อความ... (Enter ส่ง, Shift+Enter ขึ้นบรรทัดใหม่)' : 'พิมพ์ข้อความ...'}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-200 focus:border-blue-400 text-sm outline-none transition-all"
              />
              <div className="flex items-center justify-between">
                <label className="inline-flex items-center gap-2 cursor-pointer select-none group">
                  <input
                    type="checkbox"
                    checked={sendOnEnter}
                    onChange={(e) => setSendOnEnter(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 group-hover:text-gray-700 transition-colors">Enter เพื่อส่งข้อความ</span>
                  {sendOnEnter && (
                    <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">Shift+Enter ขึ้นบรรทัดใหม่</span>
                  )}
                </label>
                <button
                  type="button"
                  onClick={handleSendChat}
                  disabled={chatSending || chatMessage.trim() === ''}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50 shadow-sm transition-all"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                  {chatSending ? 'กำลังส่ง...' : 'ส่งข้อความ'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
