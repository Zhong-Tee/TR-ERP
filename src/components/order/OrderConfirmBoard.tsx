import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FiMessageCircle } from 'react-icons/fi'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import { getChatEnterToSendPref, setChatEnterToSendPref } from '../../lib/chatEnterToSendPrefs'
import { formatDateTime, getBangkokCalendarDayUtcBoundsISO } from '../../lib/utils'
import { buildBillLineItemsExportMulti, buildProductionLikeExportMulti } from '../../lib/orderProductionExcel'
import { Order, OrderStatus, OrderChatLog } from '../../types'
import Modal from '../ui/Modal'
import { useAuthContext } from '../../contexts/AuthContext'
import { isSalesPumpOwnerScopedRole, isSalesTrTeamRole } from '../../config/accessPolicy'
import { fetchSalesTrTeamAdminValues } from '../../lib/salesTrTeam'
import { orderQualifiesForConfirmBoard } from '../../lib/pumpConfirmRouting'
import OrderDetailView from './OrderDetailView'

/** ใช้ให้สอดคล้อง RPC unread: username / email ใน us_users + อีเมล JWT (ถ้ามี) — ไม่สนตัวพิมพ์ */
function salesPumpAdminMatchesUser(
  adminUser: string | null | undefined,
  u: { username?: string | null; email?: string | null },
  jwtEmailLower: string
): boolean {
  const au = (adminUser || '').trim().toLowerCase()
  if (!au) return false
  const un = (u.username || '').trim().toLowerCase()
  const em = (u.email || '').trim().toLowerCase()
  return au === un || (!!em && au === em) || (!!jwtEmailLower && au === jwtEmailLower)
}

/* ─────────────────────── Types & Constants ─────────────────────── */

type ConfirmColumnKey = 'new' | 'noDesign' | 'design' | 'designed' | 'waiting' | 'confirmed' | 'completed'

type ViewMode = 'default' | 'new' | 'noDesign' | 'completed'

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

/** คอลัมน์ "ไม่ต้องออกแบบ" — ข้ามขั้นตอนออกแบบ ไปคอนเฟิร์ม/ผลิตได้โดยตรง */
const NO_DESIGN_COLUMN: ConfirmColumn = {
  key: 'noDesign',
  title: 'ไม่ต้องออกแบบ',
  status: 'ไม่ต้องออกแบบ',
  actionLabel: 'เปลี่ยนสถานะ',
  actionTargetStatus: 'คอนเฟิร์มแล้ว',
  headerGradient: 'bg-gradient-to-r from-orange-500 to-orange-600',
  countBadge: 'bg-orange-50 text-orange-800 ring-1 ring-orange-200',
  actionBtn:
    'bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white shadow-sm',
}

/** คอลัมน์ "เสร็จสิ้น" (completed view) — ไม่มีปุ่มเปลี่ยนสถานะ */
const COMPLETED_COLUMN: ConfirmColumn = {
  key: 'completed',
  title: 'เสร็จสิ้น',
  status: 'เสร็จสิ้น',
  headerGradient: 'bg-gradient-to-r from-teal-500 to-cyan-600',
  countBadge: 'bg-teal-50 text-teal-700 ring-1 ring-teal-200',
}

/** สอดคล้อง RPC get_unread_chat_count / list_unread_order_chat_summaries (sales-tr, production) */
const CONFIRM_PIPELINE_STATUSES_ORDER_UNREAD: OrderStatus[] = [
  'ตรวจสอบแล้ว',
  'ไม่ต้องออกแบบ',
  'รอออกแบบ',
  'ออกแบบแล้ว',
  'รอคอนเฟิร์ม',
  'คอนเฟิร์มแล้ว',
]

function orderBillingPhone(o: Order): string {
  const b = o.billing_details
  const p = (b?.mobile_phone || b?.tax_customer_phone || '').trim()
  return p || '—'
}

const STATUS_OPTIONS: Array<{ label: string; value: OrderStatus }> = [
  { label: 'Order ใหม่', value: 'ตรวจสอบแล้ว' },
  { label: 'รอออกแบบ', value: 'รอออกแบบ' },
  { label: 'ไม่ต้องออกแบบ', value: 'ไม่ต้องออกแบบ' },
  { label: 'ออกแบบแล้ว', value: 'ออกแบบแล้ว' },
  { label: 'รอคอนเฟิร์มแบบ', value: 'รอคอนเฟิร์ม' },
  { label: 'คอนเฟิร์มแล้ว', value: 'คอนเฟิร์มแล้ว' },
  { label: 'เสร็จสิ้น', value: 'เสร็จสิ้น' },
]

const PRODUCTION_ALLOWED_CONFIRM_STATUSES: OrderStatus[] = [
  'ตรวจสอบแล้ว',
  'รอออกแบบ',
  'ออกแบบแล้ว',
  'ไม่ต้องออกแบบ',
  'คอนเฟิร์มแล้ว',
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
    case 'noDesign':
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
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
  const isProduction = user?.role === 'production'
  const canProductionChangeStatus = (status: OrderStatus) => PRODUCTION_ALLOWED_CONFIRM_STATUSES.includes(status)
  const [ordersByKey, setOrdersByKey] = useState<Record<ConfirmColumnKey, Order[]>>({
    new: [],
    noDesign: [],
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
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const [fromDate, setFromDate] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  })
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0])
  const [viewMode, setViewMode] = useState<ViewMode>('default')
  const [sendOnEnter, setSendOnEnter] = useState(false)
  const [unreadByOrder, setUnreadByOrder] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!user?.id) {
      setSendOnEnter(false)
      return
    }
    setSendOnEnter(getChatEnterToSendPref(user.id, 'order-confirm'))
  }, [user?.id])
  const [selectedNoDesignIds, setSelectedNoDesignIds] = useState<Set<string>>(new Set())
  const [selectedCompletedIds, setSelectedCompletedIds] = useState<Set<string>>(new Set())
  const [confirmTableSearch, setConfirmTableSearch] = useState('')
  const [exportingNoDesign, setExportingNoDesign] = useState(false)
  const [exportingCompleted, setExportingCompleted] = useState(false)
  const [copyingAllNew, setCopyingAllNew] = useState(false)
  const [copyFeedbackModal, setCopyFeedbackModal] = useState<{ open: boolean; title: string; message: string }>({
    open: false,
    title: '',
    message: '',
  })
  const ordersByKeyRef = useRef(ordersByKey)
  ordersByKeyRef.current = ordersByKey

  const [salesTrTeamAdminValues, setSalesTrTeamAdminValues] = useState<string[]>([])
  const [salesTrTeamScopeReady, setSalesTrTeamScopeReady] = useState(true)
  const salesTrTeamSetRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    salesTrTeamSetRef.current = new Set(
      salesTrTeamAdminValues.map((s) => s.trim()).filter(Boolean),
    )
  }, [salesTrTeamAdminValues])

  useEffect(() => {
    if (!user?.role) {
      setSalesTrTeamAdminValues([])
      setSalesTrTeamScopeReady(true)
      return
    }
    if (!isSalesTrTeamRole(user.role)) {
      setSalesTrTeamAdminValues([])
      setSalesTrTeamScopeReady(true)
      return
    }
    setSalesTrTeamScopeReady(false)
    let cancelled = false
    ;(async () => {
      try {
        const vals = await fetchSalesTrTeamAdminValues(supabase)
        if (!cancelled) {
          setSalesTrTeamAdminValues(vals)
          setSalesTrTeamScopeReady(true)
        }
      } catch (e) {
        console.error('OrderConfirmBoard sales-tr team:', e)
        if (!cancelled) {
          setSalesTrTeamAdminValues([])
          setSalesTrTeamScopeReady(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user?.role])

  const isTableConfirmView = viewMode === 'noDesign' || viewMode === 'completed'

  const filteredTableOrders = useMemo(() => {
    const raw =
      viewMode === 'noDesign' ? ordersByKey.noDesign : viewMode === 'completed' ? ordersByKey.completed : []
    const q = confirmTableSearch.trim().toLowerCase()
    if (!q) return raw
    return raw.filter((o) => {
      const bill = (o.bill_no || '').toLowerCase()
      const cn = (o.customer_name || '').toLowerCase()
      const rn = (o.recipient_name || '').toLowerCase()
      return bill.includes(q) || cn.includes(q) || rn.includes(q)
    })
  }, [viewMode, ordersByKey.noDesign, ordersByKey.completed, confirmTableSearch])

  useEffect(() => {
    setSelectedNoDesignIds(new Set())
    setSelectedCompletedIds(new Set())
  }, [fromDate, toDate, refreshKey, viewMode])

  /* ── Data Loading ── */

  useEffect(() => {
    if (!salesTrTeamScopeReady) return
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, fromDate, toDate, salesTrTeamScopeReady, salesTrTeamAdminValues])

  // Realtime subscription: reload board when or_orders changes
  useEffect(() => {
    const channel = supabase
      .channel('confirm-board-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, () => {
        loadAll()
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDate, toDate])

  // Realtime subscription for order chat logs → update unread counts
  useEffect(() => {
    const channel = supabase
      .channel('confirm-board-chat')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'or_order_chat_logs' }, (payload) => {
        void (async () => {
          const row = payload.new as OrderChatLog
          if (user && row.sender_id === user.id) return
          // ถ้า chat เปิดอยู่สำหรับ order นี้ → เพิ่ม message เข้า log ทันที + mark read
          if (chatOrder && chatOrder.id === row.order_id) {
            setChatLogs((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]))
            if (user) {
              await supabase.from('or_order_chat_reads').upsert({
                order_id: row.order_id,
                user_id: user.id,
                last_read_at: new Date().toISOString(),
              })
            }
            return
          }
          if (user && isSalesPumpOwnerScopedRole(user.role)) {
            const { data: { session } } = await supabase.auth.getSession()
            const jwtLo = session?.user?.email?.trim().toLowerCase() || ''
            const all = Object.values(ordersByKeyRef.current).flat()
            let ord = all.find((o) => o.id === row.order_id)
            let adminUser = ord?.admin_user
            if (!ord) {
              const { data: o } = await supabase.from('or_orders').select('admin_user').eq('id', row.order_id).maybeSingle()
              adminUser = o?.admin_user ?? undefined
            }
            if (!salesPumpAdminMatchesUser(adminUser, user, jwtLo)) {
              const { data: prior } = await supabase
                .from('or_order_chat_logs')
                .select('id')
                .eq('order_id', row.order_id)
                .eq('sender_id', user.id)
                .eq('is_hidden', false)
                .limit(1)
                .maybeSingle()
              if (!prior) return
            }
          }
          if (user && isSalesTrTeamRole(user.role)) {
            const all = Object.values(ordersByKeyRef.current).flat()
            let ord = all.find((o) => o.id === row.order_id)
            let adminUser = ord?.admin_user
            let channelCode = ord?.channel_code
            let orderStatus = ord?.status as OrderStatus | undefined
            let requiresDesign = ord?.requires_confirm_design
            if (!ord) {
              const { data: o } = await supabase
                .from('or_orders')
                .select('admin_user, channel_code, status, requires_confirm_design')
                .eq('id', row.order_id)
                .maybeSingle()
              adminUser = o?.admin_user ?? undefined
              channelCode = o?.channel_code ?? undefined
              orderStatus = o?.status as OrderStatus | undefined
              requiresDesign = o?.requires_confirm_design
            }
            const teamOk = salesTrTeamSetRef.current.has((adminUser || '').trim())
            const inConfirmPipeline =
              !!orderStatus &&
              CONFIRM_PIPELINE_STATUSES_ORDER_UNREAD.includes(orderStatus) &&
              orderQualifiesForConfirmBoard(channelCode, requiresDesign)
            if (!teamOk || !inConfirmPipeline) return
          }
          setUnreadByOrder((prev) => ({ ...prev, [row.order_id]: (prev[row.order_id] || 0) + 1 }))
        })()
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [chatOrder, user])

  // Load unread counts เมื่อ orders เปลี่ยน
  useEffect(() => {
    if (!user) return
    void (async () => {
      const allOrders = Object.values(ordersByKey).flat()
      let scopedIds = allOrders.map((o) => o.id).filter(Boolean)
      if (isSalesPumpOwnerScopedRole(user.role)) {
        const { data: { session } } = await supabase.auth.getSession()
        const jwtLo = session?.user?.email?.trim().toLowerCase() || ''
        const ownedIds = allOrders
          .filter((o) => salesPumpAdminMatchesUser(o.admin_user, user, jwtLo))
          .map((o) => o.id)
          .filter(Boolean)
        const { data: participated } = await supabase
          .from('or_order_chat_logs')
          .select('order_id')
          .eq('sender_id', user.id)
          .eq('is_hidden', false)
        const fromChats = [...new Set((participated || []).map((r: { order_id: string }) => r.order_id).filter(Boolean))]
        scopedIds = [...new Set([...ownedIds, ...fromChats])]
      }
      if (scopedIds.length === 0) {
        setUnreadByOrder({})
        return
      }
      loadOrderUnreadCounts(scopedIds)
    })()
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
        supabase.from('or_order_chat_logs').select('order_id, created_at, sender_id').eq('is_hidden', false).in('order_id', orderIds),
      ])
      const readMap = new Map(
        (reads || []).map((r: any) => [r.order_id, new Date(r.last_read_at).getTime()])
      )
      const counts: Record<string, number> = {}
      ;(messages || []).forEach((m: { order_id: string; created_at: string; sender_id: string }) => {
        if (user && m.sender_id === user.id) return
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

  async function autoCompleteShippedOrders(shippedOrders: Order[]): Promise<Order[]> {
    if (shippedOrders.length === 0) return []
    const ids = shippedOrders.map((o) => o.id)
    try {
      const { error } = await supabase
        .from('or_orders')
        .update({ status: 'เสร็จสิ้น' })
        .in('id', ids)
      if (error) throw error
      return shippedOrders.map((o) => ({ ...o, status: 'เสร็จสิ้น' as any }))
    } catch (err) {
      console.error('Error auto-completing shipped orders:', err)
      return []
    }
  }

  async function loadAll() {
    setLoading(true)
    try {
      const [
        newOrders,
        noDesignOrders,
        designOrders,
        designedOrders,
        waitingOrders,
        confirmedOrders,
        shippedOrders,
        completedOrders,
      ] =
        await Promise.all([
          loadOrdersByStatus('ตรวจสอบแล้ว'),
          loadOrdersByStatus('ไม่ต้องออกแบบ'),
          loadOrdersByStatus('รอออกแบบ'),
          loadOrdersByStatus('ออกแบบแล้ว'),
          loadOrdersByStatus('รอคอนเฟิร์ม'),
          loadOrdersByStatus('คอนเฟิร์มแล้ว'),
          loadOrdersByStatus('จัดส่งแล้ว'),
          loadOrdersByStatus('เสร็จสิ้น'),
        ])

      const movedToComplete = await autoCompleteShippedOrders(shippedOrders)
      const actualCompleted = [...movedToComplete, ...completedOrders]

      setOrdersByKey({
        new: newOrders,
        noDesign: noDesignOrders,
        design: designOrders,
        designed: designedOrders,
        waiting: waitingOrders,
        confirmed: confirmedOrders,
        completed: actualCompleted,
      })
      const { startIso: tabDayStart, endIso: tabDayEnd } = getBangkokCalendarDayUtcBoundsISO()
      const t0 = new Date(tabDayStart).getTime()
      const t1 = new Date(tabDayEnd).getTime()
      const inBangkokToday = (o: Order) => {
        const t = new Date(o.created_at).getTime()
        return t >= t0 && t <= t1
      }
      onCountChange?.(
        newOrders.filter(inBangkokToday).length +
          noDesignOrders.filter(inBangkokToday).length +
          designOrders.filter(inBangkokToday).length +
          designedOrders.filter(inBangkokToday).length +
          waitingOrders.filter(inBangkokToday).length +
          confirmedOrders.filter(inBangkokToday).length
      )
    } catch (error) {
      console.error('Error loading confirm orders:', error)
    } finally {
      setLoading(false)
    }
  }

  async function loadOrdersByStatus(status: OrderStatus): Promise<Order[]> {
    const buildQuery = (pumpOnly: boolean) => {
      let q = supabase.from('or_orders').select('*, or_order_items(*)').eq('status', status)
      if (pumpOnly) {
        q = q.eq('channel_code', 'PUMP')
      } else {
        q = q.eq('requires_confirm_design', true).neq('channel_code', 'PUMP')
      }
      if (fromDate) q = q.gte('created_at', `${fromDate}T00:00:00.000Z`)
      if (toDate) q = q.lte('created_at', `${toDate}T23:59:59.999Z`)
      if (isSalesTrTeamRole(user?.role)) {
        if (salesTrTeamAdminValues.length === 0) {
          q = q.eq('admin_user', '__no_sales_tr_team__')
        } else {
          q = q.in('admin_user', salesTrTeamAdminValues)
        }
      }
      return q
    }

    const [{ data: pumpRows, error: pumpErr }, { data: otherRows, error: otherErr }] = await Promise.all([
      buildQuery(true),
      buildQuery(false),
    ])
    if (pumpErr) throw pumpErr
    if (otherErr) throw otherErr

    const map = new Map<string, Order>()
    for (const o of [...(pumpRows || []), ...(otherRows || [])] as Order[]) {
      map.set(o.id, o)
    }
    return [...map.values()].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )
  }

  /* ── Event Handlers ── */

  function openStatusModal(order: Order, targetStatus: OrderStatus, label: string) {
    setNoteText(order.confirm_note || '')
    setStatusModal({ order, targetStatus, label })
  }

  async function moveOrderToNoDesign(order: Order) {
    if (isProduction && !canProductionChangeStatus(order.status as OrderStatus)) {
      alert('สิทธิ์ production ไม่สามารถดำเนินการกับสถานะนี้ได้')
      return
    }
    try {
      const { error } = await supabase
        .from('or_orders')
        .update({ status: 'ไม่ต้องออกแบบ' })
        .eq('id', order.id)
      if (error) throw error
      setRefreshKey((k) => k + 1)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('moveOrderToNoDesign:', error)
      alert('เกิดข้อผิดพลาด: ' + msg)
    }
  }

  function toggleNoDesignSelect(id: string) {
    setSelectedNoDesignIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleCompletedSelect(id: string) {
    setSelectedCompletedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleExportSelectedNoDesign() {
    const list = ordersByKey.noDesign.filter((o) => selectedNoDesignIds.has(o.id))
    if (list.length === 0) {
      alert('กรุณาเลือกบิลที่ต้องการ Export')
      return
    }
    setExportingNoDesign(true)
    try {
      const { headers, dataRows } = await buildProductionLikeExportMulti(supabase, list)
      const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'ProductionData')
      const stamp = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `Confirm_ไม่ต้องออกแบบ_${stamp}.xlsx`)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('Export no-design:', error)
      alert('Export ไม่สำเร็จ: ' + msg)
    } finally {
      setExportingNoDesign(false)
    }
  }

  async function handleExportCompletedLines() {
    const list = ordersByKey.completed.filter((o) => selectedCompletedIds.has(o.id))
    if (list.length === 0) {
      alert('กรุณาเลือกบิลที่ต้องการ Export')
      return
    }
    setExportingCompleted(true)
    try {
      const { headers, dataRows } = await buildBillLineItemsExportMulti(supabase, list)
      const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'รายการบิล')
      const stamp = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `Confirm_เสร็จสิ้น_รายการสินค้า_${stamp}.xlsx`)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('Export completed:', error)
      alert('Export ไม่สำเร็จ: ' + msg)
    } finally {
      setExportingCompleted(false)
    }
  }

  async function handleCopyAllNewOrders() {
    if (copyingAllNew) return
    if (ordersByKey.new.length === 0) {
      setCopyFeedbackModal({
        open: true,
        title: 'ไม่พบข้อมูล',
        message: 'ไม่มีบิลในแท็บงานใหม่สำหรับคัดลอก',
      })
      return
    }
    setCopyingAllNew(true)
    try {
      const { dataRows } = await buildProductionLikeExportMulti(supabase, ordersByKey.new)
      const clipboardText = dataRows
        .map((row) => row.map((value) => String(value ?? '').replace(/\r?\n/g, ' ').replace(/\t/g, ' ')).join('\t'))
        .join('\n')
      await navigator.clipboard.writeText(clipboardText)
      setCopyFeedbackModal({
        open: true,
        title: 'คัดลอกสำเร็จ',
        message: `คัดลอกข้อมูลเรียบร้อย ${dataRows.length} แถว จาก ${ordersByKey.new.length} บิล (ไม่รวมหัวตาราง)`,
      })
    } catch (error: any) {
      console.error('Error copying new orders data:', error)
      setCopyFeedbackModal({
        open: true,
        title: 'คัดลอกไม่สำเร็จ',
        message: 'คัดลอกไม่สำเร็จ: ' + (error?.message || error),
      })
    } finally {
      setCopyingAllNew(false)
    }
  }

  const openChat = useCallback(
    async (order: Order) => {
      setChatOrder(order)
      setChatMessage('')
      setChatLogs([])
      setChatLoading(true)
      try {
        if (user) {
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
    },
    [user]
  )

  useLayoutEffect(() => {
    if (!chatOrder || chatLoading || chatLogs.length === 0) return
    chatEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [chatOrder?.id, chatLoading, chatLogs])

  useEffect(() => {
    const onOpenChatFromNav = (e: Event) => {
      const orderId = (e as CustomEvent<{ orderId?: string }>).detail?.orderId
      if (!orderId || !user) return
      const all = Object.values(ordersByKey).flat()
      const found = all.find((o) => o.id === orderId)
      if (found) {
        void openChat(found)
        return
      }
      void (async () => {
        const { data, error } = await supabase.from('or_orders').select('*').eq('id', orderId).maybeSingle()
        if (!error && data) void openChat(data as Order)
      })()
    }
    window.addEventListener('open-confirm-order-chat', onOpenChatFromNav)
    return () => window.removeEventListener('open-confirm-order-chat', onOpenChatFromNav)
  }, [ordersByKey, user, openChat])

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
      await supabase.from('or_order_chat_reads').upsert({
        order_id: chatOrder.id,
        user_id: user.id,
        last_read_at: new Date().toISOString(),
      })
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
    if (isProduction) {
      const currentStatus = statusModal.order.status as OrderStatus
      const nextStatus = statusModal.targetStatus
      if (!canProductionChangeStatus(currentStatus) || !canProductionChangeStatus(nextStatus)) {
        alert('สิทธิ์ production เปลี่ยนสถานะได้เฉพาะ Order ใหม่, รอออกแบบ, ออกแบบแล้ว, ไม่ต้องออกแบบ, คอนเฟิร์มแล้ว')
        return
      }
    }
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
    gridCols = 'lg:grid-cols-1 w-full max-w-none'
  } else if (viewMode === 'noDesign') {
    visibleColumns = [NO_DESIGN_COLUMN]
    gridCols = 'lg:grid-cols-1 w-full max-w-none'
  } else if (viewMode === 'completed') {
    visibleColumns = [COMPLETED_COLUMN]
    gridCols = 'lg:grid-cols-1 w-full max-w-none'
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

  const tableColumn = isTableConfirmView
    ? (viewMode === 'noDesign' ? NO_DESIGN_COLUMN : COMPLETED_COLUMN)
    : null

  /* ── Render ── */

  return (
    <div className="space-y-4 w-full min-w-0 max-w-full">
      {/* ── Filter bar + แท็บ (แถวเดียวกันเมื่อมุมมองตาราง) ── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 sm:p-4 flex flex-wrap items-center gap-3 w-full min-w-0">
        {isTableConfirmView ? (
          <>
            <div className="flex flex-wrap items-center gap-2 sm:gap-3 flex-1 min-w-0 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 shadow-sm">
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-sm font-medium text-gray-600 whitespace-nowrap">จากวันที่</span>
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="h-10 box-border px-2 sm:px-3 border border-gray-300 rounded-lg bg-white text-sm min-w-0"
                />
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-sm font-medium text-gray-600 whitespace-nowrap">ถึงวันที่</span>
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="h-10 box-border px-2 sm:px-3 border border-gray-300 rounded-lg bg-white text-sm min-w-0"
                />
              </div>
              <div className="flex items-center gap-2 min-w-[8rem] flex-1 max-w-xs">
                <span className="text-sm font-medium text-gray-600 whitespace-nowrap shrink-0">ค้นหาชื่อ</span>
                <input
                  type="text"
                  value={confirmTableSearch}
                  onChange={(e) => setConfirmTableSearch(e.target.value)}
                  placeholder="พิมพ์บางส่วนของชื่อ"
                  className="h-10 box-border w-full px-2 sm:px-3 border border-gray-300 rounded-lg bg-white text-sm"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  setConfirmTableSearch('')
                  const now = new Date()
                  setFromDate(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`)
                  setToDate(new Date().toISOString().split('T')[0])
                }}
                className="shrink-0 inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-gray-100 px-3 text-sm font-medium text-gray-700 hover:bg-gray-200"
              >
                ล้างตัวกรอง
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0 ml-auto">
              {/* งานใหม่ */}
              <button
                type="button"
                onClick={() => setViewMode((v) => (v === 'new' ? 'default' : 'new'))}
                className={`inline-flex h-10 box-border items-center justify-center gap-2 px-3 sm:px-4 rounded-xl font-semibold text-sm transition-all ${
                  'bg-white text-blue-600 hover:bg-blue-50 border-2 border-blue-300 shadow-sm'
                }`}
              >
                <ColumnIcon columnKey="new" />
                งานใหม่
                <span
                  className={`inline-flex min-h-6 min-w-6 items-center justify-center rounded-full px-2 text-xs font-bold ${
                    'bg-blue-100 text-blue-600'
                  }`}
                >
                  {ordersByKey.new.length}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode((v) => (v === 'noDesign' ? 'default' : 'noDesign'))}
                className={`inline-flex h-10 box-border items-center justify-center gap-2 px-3 sm:px-4 rounded-xl font-semibold text-sm transition-all ${
                  viewMode === 'noDesign'
                    ? 'border-2 border-transparent bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-md'
                    : 'border-2 border-orange-300 bg-white text-orange-600 shadow-sm hover:bg-orange-50'
                }`}
              >
                <ColumnIcon columnKey="noDesign" />
                ไม่ต้องออกแบบ
                <span
                  className={`inline-flex min-h-6 min-w-6 items-center justify-center rounded-full px-2 text-xs font-bold ${
                    viewMode === 'noDesign' ? 'bg-white/20 text-white' : 'bg-orange-100 text-orange-600'
                  }`}
                >
                  {ordersByKey.noDesign.length}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode((v) => (v === 'completed' ? 'default' : 'completed'))}
                className={`inline-flex h-10 box-border items-center justify-center gap-2 px-3 sm:px-4 rounded-xl font-semibold text-sm transition-all ${
                  viewMode === 'completed'
                    ? 'border-2 border-transparent bg-gradient-to-r from-teal-500 to-cyan-600 text-white shadow-md'
                    : 'border-2 border-teal-300 bg-white text-teal-600 shadow-sm hover:bg-teal-50'
                }`}
              >
                <ColumnIcon columnKey="completed" />
                เสร็จสิ้น
                <span
                  className={`inline-flex min-h-6 min-w-6 items-center justify-center rounded-full px-2 text-xs font-bold ${
                    'bg-teal-100 text-teal-600'
                  }`}
                >
                  {ordersByKey.completed.length}
                </span>
              </button>
            </div>
          </>
        ) : (
          <>
            <svg className="w-5 h-5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>

            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-gray-600">จากวันที่</label>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="h-10 box-border px-3 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none transition-all"
              />
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-gray-600">ถึงวันที่</label>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="h-10 box-border px-3 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none transition-all"
              />
            </div>

            {viewMode === 'new' && (
              <button
                type="button"
                onClick={() => void handleCopyAllNewOrders()}
                disabled={copyingAllNew || ordersByKey.new.length === 0}
                className="inline-flex h-10 box-border items-center justify-center gap-2 px-4 rounded-xl font-semibold text-sm bg-white text-blue-700 hover:bg-blue-50 border-2 border-blue-300 shadow-sm disabled:opacity-50"
              >
                {copyingAllNew ? 'กำลังคัดลอก...' : 'คัดลอก'}
              </button>
            )}

            <div className="flex-1" />

            <button
              type="button"
              onClick={() => setViewMode((v) => (v === 'new' ? 'default' : 'new'))}
              className={`inline-flex h-10 box-border items-center justify-center gap-2 px-4 rounded-xl font-semibold text-sm transition-all ${
                viewMode === 'new'
                  ? 'border-2 border-transparent bg-gradient-to-r from-blue-500 to-blue-600 text-white shadow-md'
                  : 'border-2 border-blue-300 bg-white text-blue-600 shadow-sm hover:bg-blue-50'
              }`}
            >
              <ColumnIcon columnKey="new" />
              งานใหม่
              <span
                className={`inline-flex min-h-6 min-w-6 items-center justify-center rounded-full px-2 text-xs font-bold ${
                  viewMode === 'new' ? 'bg-white/20 text-white' : 'bg-blue-100 text-blue-600'
                }`}
              >
                {ordersByKey.new.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setViewMode((v) => (v === 'noDesign' ? 'default' : 'noDesign'))}
              className="inline-flex h-10 box-border items-center justify-center gap-2 border-2 border-orange-300 bg-white px-4 rounded-xl font-semibold text-sm text-orange-600 shadow-sm transition-all hover:bg-orange-50"
            >
              <ColumnIcon columnKey="noDesign" />
              ไม่ต้องออกแบบ
              <span className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-full bg-orange-100 px-2 text-xs font-bold text-orange-600">
                {ordersByKey.noDesign.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setViewMode((v) => (v === 'completed' ? 'default' : 'completed'))}
              className="inline-flex h-10 box-border items-center justify-center gap-2 border-2 border-teal-300 bg-white px-4 rounded-xl font-semibold text-sm text-teal-600 shadow-sm transition-all hover:bg-teal-50"
            >
              <ColumnIcon columnKey="completed" />
              เสร็จสิ้น
              <span className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-full bg-teal-100 px-2 text-xs font-bold text-teal-600">
                {ordersByKey.completed.length}
              </span>
            </button>
          </>
        )}
      </div>

      {/* ── Columns Grid ── */}
      <div className={`grid grid-cols-1 gap-4 min-h-0 w-full min-w-0 ${gridCols}`}>
        {viewMode === 'new' ? (
          <section className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden w-full min-w-0">
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              {ordersByKey.new.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-gray-400 bg-white">
                  <svg className="w-10 h-10 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                  </svg>
                  <p className="text-base text-gray-500">ไม่พบรายการ</p>
                </div>
              ) : (
                <table className="min-w-full text-base">
                  <thead className="bg-blue-600 text-white sticky top-0">
                    <tr>
                      <th className="p-4 text-left font-semibold whitespace-nowrap">วันที่</th>
                      <th className="p-4 text-left font-semibold whitespace-nowrap">เลขบิล</th>
                      <th className="p-4 text-left font-semibold">ชื่อลูกค้า</th>
                      <th className="p-4 text-left font-semibold">ชื่อผู้รับ</th>
                      <th className="p-4 text-left font-semibold min-w-[10rem]">ที่อยู่</th>
                      <th className="p-4 text-left font-semibold whitespace-nowrap">เบอร์โทร</th>
                      <th className="p-4 text-left font-semibold whitespace-nowrap">การทำงาน</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordersByKey.new.map((order, idx) => (
                      <tr
                        key={order.id}
                        className={`border-b border-gray-200 hover:bg-blue-50 transition-colors ${
                          idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'
                        }`}
                      >
                        <td className="p-4 text-gray-700 whitespace-nowrap align-top">
                          {formatDateTime(order.created_at)}
                        </td>
                        <td className="p-4 align-top whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => setDetailOrder(order)}
                            className="font-semibold text-blue-600 hover:text-blue-800 hover:underline text-left"
                          >
                            {order.bill_no}
                          </button>
                        </td>
                        <td className="p-4 text-gray-900 align-top max-w-[12rem] break-words">
                          {order.customer_name}
                        </td>
                        <td className="p-4 text-gray-800 align-top max-w-[10rem] break-words">
                          {order.recipient_name || '—'}
                        </td>
                        <td className="p-4 text-gray-700 text-sm align-top max-w-[14rem] break-words">
                          {(order.customer_address || '').slice(0, 200)}
                          {(order.customer_address || '').length > 200 ? '…' : ''}
                        </td>
                        <td className="p-4 text-gray-800 whitespace-nowrap text-sm align-top">
                          {orderBillingPhone(order)}
                        </td>
                        <td className="p-4 align-top">
                          <div className="flex flex-wrap gap-1">
                            <button
                              type="button"
                              onClick={() => setDetailOrder(order)}
                              className="inline-flex items-center px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs font-medium text-gray-800 hover:bg-gray-50"
                            >
                              รายละเอียด
                            </button>
                            {NEW_COLUMN.actionTargetStatus && NEW_COLUMN.actionLabel && !isProduction && (
                              <button
                                type="button"
                                onClick={() =>
                                  openStatusModal(
                                    order,
                                    NEW_COLUMN.actionTargetStatus as OrderStatus,
                                    NEW_COLUMN.actionLabel as string
                                  )
                                }
                                className={`inline-flex items-center px-2.5 py-1.5 rounded-lg text-xs font-semibold text-white ${NEW_COLUMN.actionBtn}`}
                              >
                                {NEW_COLUMN.actionLabel}
                              </button>
                            )}
                            {isProduction && canProductionChangeStatus(order.status as OrderStatus) && (
                              <button
                                type="button"
                                onClick={() => openStatusModal(order, order.status as OrderStatus, 'เปลี่ยนสถานะ')}
                                className="inline-flex items-center px-2.5 py-1.5 bg-gradient-to-r from-violet-500 to-indigo-600 text-white rounded-lg text-xs font-semibold"
                              >
                                เปลี่ยนสถานะ
                              </button>
                            )}
                            {(!isProduction || canProductionChangeStatus(order.status as OrderStatus)) && (
                              <button
                                type="button"
                                onClick={() => moveOrderToNoDesign(order)}
                                className="inline-flex items-center px-2.5 py-1.5 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 border border-orange-600 rounded-lg text-xs font-semibold text-white shadow-sm"
                              >
                                ไม่ต้องออกแบบ
                              </button>
                            )}
                            <div className="inline-flex items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => openChat(order)}
                                className="inline-flex items-center px-2.5 py-1.5 bg-gray-700 text-white rounded-lg text-xs font-semibold hover:bg-gray-800"
                              >
                                Chat
                              </button>
                              {(unreadByOrder[order.id] || 0) > 0 && (
                                <span className="min-w-[1rem] h-4 px-1 flex items-center justify-center rounded-full text-[9px] font-bold bg-red-500 text-white">
                                  {unreadByOrder[order.id]}
                                </span>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        ) : isTableConfirmView && tableColumn ? (
          <section className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden flex flex-col min-h-0 w-full min-w-0">
            <div className="p-4 space-y-4 w-full min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (viewMode === 'noDesign') {
                      setSelectedNoDesignIds(new Set(filteredTableOrders.map((o) => o.id)))
                    } else {
                      setSelectedCompletedIds(new Set(filteredTableOrders.map((o) => o.id)))
                    }
                  }}
                  disabled={filteredTableOrders.length === 0}
                  className="rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                >
                  เลือกทั้งหมด
                </button>
                <button
                  type="button"
                  onClick={viewMode === 'noDesign' ? handleExportSelectedNoDesign : handleExportCompletedLines}
                  disabled={
                    viewMode === 'noDesign'
                      ? exportingNoDesign || selectedNoDesignIds.size === 0
                      : exportingCompleted || selectedCompletedIds.size === 0
                  }
                  className={
                    viewMode === 'noDesign'
                      ? 'rounded-xl bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-40'
                      : 'rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-40'
                  }
                >
                  {viewMode === 'noDesign'
                    ? exportingNoDesign
                      ? 'กำลังสร้างไฟล์...'
                      : 'Export Excel'
                    : exportingCompleted
                      ? 'กำลังสร้างไฟล์...'
                      : 'Export Excel'}
                </button>
              </div>

              <div className="overflow-x-auto rounded-xl border border-gray-200">
                {filteredTableOrders.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-gray-400 bg-white">
                    <svg className="w-10 h-10 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                    </svg>
                    <p className="text-base text-gray-500">ไม่พบรายการ</p>
                  </div>
                ) : (
                  <table className="min-w-full text-base">
                    <thead className="bg-blue-600 text-white sticky top-0">
                      <tr>
                        <th className="p-4 text-left font-semibold w-12"> </th>
                        <th className="p-4 text-left font-semibold whitespace-nowrap">วันที่</th>
                        <th className="p-4 text-left font-semibold whitespace-nowrap">เลขบิล</th>
                        <th className="p-4 text-left font-semibold">ชื่อลูกค้า</th>
                        <th className="p-4 text-left font-semibold">ชื่อผู้รับ</th>
                        <th className="p-4 text-left font-semibold min-w-[10rem]">ที่อยู่</th>
                        <th className="p-4 text-left font-semibold whitespace-nowrap">เบอร์โทร</th>
                        <th className="p-4 text-left font-semibold whitespace-nowrap">การทำงาน</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTableOrders.map((order, idx) => (
                        <tr
                          key={order.id}
                          className={`border-b border-gray-200 hover:bg-blue-50 transition-colors ${
                            idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'
                          }`}
                        >
                          <td className="p-4 align-top">
                            <input
                              type="checkbox"
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                              checked={
                                viewMode === 'noDesign'
                                  ? selectedNoDesignIds.has(order.id)
                                  : selectedCompletedIds.has(order.id)
                              }
                              onChange={() =>
                                viewMode === 'noDesign'
                                  ? toggleNoDesignSelect(order.id)
                                  : toggleCompletedSelect(order.id)
                              }
                            />
                          </td>
                          <td className="p-4 text-gray-700 whitespace-nowrap align-top">
                            {formatDateTime(order.created_at)}
                          </td>
                          <td className="p-4 font-semibold text-blue-600 whitespace-nowrap align-top">
                            {order.bill_no}
                          </td>
                          <td className="p-4 text-gray-900 align-top max-w-[12rem] break-words">
                            {order.customer_name}
                          </td>
                          <td className="p-4 text-gray-800 align-top max-w-[10rem] break-words">
                            {order.recipient_name || '—'}
                          </td>
                          <td className="p-4 text-gray-700 text-sm align-top max-w-[14rem] break-words">
                            {(order.customer_address || '').slice(0, 200)}
                            {(order.customer_address || '').length > 200 ? '…' : ''}
                          </td>
                          <td className="p-4 text-gray-800 whitespace-nowrap text-sm align-top">
                            {orderBillingPhone(order)}
                          </td>
                          <td className="p-4 align-top">
                            <div className="flex flex-wrap gap-1">
                              <button
                                type="button"
                                onClick={() => setDetailOrder(order)}
                                className="inline-flex items-center px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50"
                              >
                                รายละเอียด
                              </button>
                              {viewMode === 'noDesign' &&
                                tableColumn.actionTargetStatus &&
                                tableColumn.actionLabel &&
                                !isProduction && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      openStatusModal(
                                        order,
                                        tableColumn.actionTargetStatus as OrderStatus,
                                        tableColumn.actionLabel as string
                                      )
                                    }
                                    className={`inline-flex items-center px-2.5 py-1.5 rounded-lg text-xs font-semibold text-white ${tableColumn.actionBtn}`}
                                  >
                                    {tableColumn.actionLabel}
                                  </button>
                                )}
                              {viewMode === 'noDesign' &&
                                isProduction &&
                                canProductionChangeStatus(order.status as OrderStatus) && (
                                  <button
                                    type="button"
                                    onClick={() => openStatusModal(order, order.status as OrderStatus, 'เปลี่ยนสถานะ')}
                                    className="inline-flex items-center px-2.5 py-1.5 bg-gradient-to-r from-violet-500 to-indigo-600 text-white rounded-lg text-xs font-semibold"
                                  >
                                    เปลี่ยนสถานะ
                                  </button>
                                )}
                              <div className="inline-flex items-center gap-0.5">
                                <button
                                  type="button"
                                  onClick={() => openChat(order)}
                                  className="inline-flex items-center px-2.5 py-1.5 bg-gray-700 text-white rounded-lg text-xs font-semibold hover:bg-gray-800"
                                >
                                  Chat
                                </button>
                                {(unreadByOrder[order.id] || 0) > 0 && (
                                  <span className="min-w-[1rem] h-4 px-1 flex items-center justify-center rounded-full text-[9px] font-bold bg-red-500 text-white">
                                    {unreadByOrder[order.id]}
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>
        ) : (
        visibleColumns.map((column) => {
          const orders = ordersByKey[column.key] || []
          return (
            <div
              key={column.key}
              className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col min-h-0 w-full min-w-0"
            >
              {/* Column Header */}
              <div className={`p-4 ${column.headerGradient} text-white shrink-0`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <ColumnIcon columnKey={column.key} />
                    <h2 className="text-base font-bold truncate">{column.title}</h2>
                  </div>
                  <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${column.countBadge}`}>
                    {orders.length}
                  </span>
                </div>
                <p className="text-sm font-medium text-white/80 mt-1">ช่องทาง: PUMP + ช่องอื่นที่ติ๊กออกแบบ</p>
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
                          <div className="font-semibold text-blue-600 text-base truncate">{order.bill_no}</div>
                          <div className="text-sm text-gray-500 truncate">{order.customer_name}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-bold text-emerald-600 text-sm">
                            ฿{Number(order.total_amount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                          <div className="text-xs text-gray-400">{formatDateTime(order.created_at)}</div>
                        </div>
                      </div>

                      {/* Note */}
                      {order.confirm_note && (
                        <div className="mt-1.5 text-xs text-gray-600 bg-amber-50 border border-amber-100 rounded-md px-2 py-1.5">
                          <span className="font-medium text-amber-700">หมายเหตุ:</span> {order.confirm_note}
                        </div>
                      )}

                      {/* Action Buttons */}
                      <div className="mt-2 flex flex-wrap gap-1">
                        <button
                          type="button"
                          onClick={() => setDetailOrder(order)}
                          className="inline-flex items-center gap-0.5 px-2.5 py-1.5 bg-white border border-gray-200 rounded-md text-xs font-medium text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-colors"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                          รายละเอียด
                        </button>

                        {column.actionTargetStatus && column.actionLabel && !isProduction && (
                          <button
                            type="button"
                            onClick={() => openStatusModal(order, column.actionTargetStatus as OrderStatus, column.actionLabel as string)}
                            className={`inline-flex items-center gap-0.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${column.actionBtn}`}
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                            </svg>
                            {column.actionLabel}
                          </button>
                        )}

                        {isProduction && canProductionChangeStatus(order.status as OrderStatus) && (
                          <button
                            type="button"
                            onClick={() => openStatusModal(order, order.status as OrderStatus, 'เปลี่ยนสถานะ')}
                            className="inline-flex items-center gap-0.5 px-2.5 py-1.5 bg-gradient-to-r from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700 text-white rounded-md text-xs font-medium shadow-sm transition-all"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                            </svg>
                            เปลี่ยนสถานะ
                          </button>
                        )}

                        {column.key === 'new' && (!isProduction || canProductionChangeStatus(order.status as OrderStatus)) && (
                          <button
                            type="button"
                            onClick={() => moveOrderToNoDesign(order)}
                            className="inline-flex items-center gap-0.5 px-2.5 py-1.5 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 border border-orange-600 rounded-md text-xs font-semibold text-white shadow-sm transition-colors"
                          >
                            ไม่ต้องออกแบบ
                          </button>
                        )}

                        {column.key === 'confirmed' && !isProduction && (
                          <button
                            type="button"
                            onClick={() => openStatusModal(order, 'รอคอนเฟิร์ม', 'เปลี่ยนสถานะ')}
                            className="inline-flex items-center gap-0.5 px-2.5 py-1.5 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-500 hover:to-amber-600 text-white rounded-md text-xs font-medium shadow-sm transition-all"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            ย้อนสถานะ
                          </button>
                        )}

                        {['design', 'designed', 'waiting', 'confirmed'].includes(column.key) && (() => {
                          const orderItems = ((order as any).or_order_items || []) as Array<{ file_attachment?: string | null }>
                          const fileLinks = orderItems.map((i) => i.file_attachment).filter((f): f is string => !!f && f.trim() !== '')
                          if (fileLinks.length === 0) return null
                          return fileLinks.map((link, fi) => (
                            <button
                              key={fi}
                              type="button"
                              onClick={() => window.open(link, '_blank')}
                              className="inline-flex items-center gap-0.5 px-2.5 py-1.5 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 text-white rounded-md text-xs font-medium shadow-sm transition-all"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                              </svg>
                              ไฟล์{fileLinks.length > 1 ? ` ${fi + 1}` : ''}
                            </button>
                          ))
                        })()}

                        {column.key !== 'new' && (
                          <div className="inline-flex items-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => openChat(order)}
                              className="inline-flex items-center gap-0.5 px-2.5 py-1.5 bg-gradient-to-r from-gray-600 to-gray-700 hover:from-gray-700 hover:to-gray-800 text-white rounded-md text-xs font-medium shadow-sm transition-all"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                              </svg>
                              Chat
                            </button>
                            {(unreadByOrder[order.id] || 0) > 0 && (
                              <span className="min-w-[1rem] h-4 px-1 flex items-center justify-center rounded-full text-[9px] font-bold bg-red-500 text-white animate-pulse">
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
        })
        )}
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
                {(isProduction ? STATUS_OPTIONS.filter((opt) => canProductionChangeStatus(opt.value)) : STATUS_OPTIONS).map((opt) => (
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
            <div className="p-4 border-b bg-emerald-600 flex items-center justify-between rounded-t-xl">
              <div>
                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                  <FiMessageCircle className="w-5 h-5" /> Chat
                </h3>
                <p className="text-sm text-emerald-100">บิล {chatOrder.bill_no}</p>
              </div>
              <button type="button" onClick={() => setChatOrder(null)} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition-colors">
                ปิดหน้าต่าง
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3 bg-gradient-to-b from-slate-100 to-slate-50">
              {chatLoading ? (
                <div className="flex justify-center items-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500" />
                </div>
              ) : chatLogs.length === 0 ? (
                <div className="flex flex-col items-center py-8 text-gray-400">
                  <svg className="w-10 h-10 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  <p className="text-sm">ยังไม่มีข้อความ</p>
                </div>
              ) : (
                <>
                  {chatLogs.map((log) => {
                    const isMe = log.sender_id === user?.id
                    return (
                      <div key={log.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'} group`}>
                        <div className={`max-w-[80%] rounded-2xl px-4 py-3 shadow-sm border ${
                          isMe
                            ? 'bg-emerald-500/95 text-white border-emerald-400 rounded-br-sm'
                            : 'bg-blue-50 text-gray-900 border-blue-200 rounded-bl-sm'
                        }`}>
                          <div className={`flex items-center gap-2 mb-1 ${isMe ? 'flex-row-reverse' : ''}`}>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                              isMe ? 'bg-emerald-600/60 text-emerald-100' : 'bg-blue-100 text-blue-700'
                            }`}>
                              {isMe ? 'ผู้ส่ง' : 'ผู้รับ'}
                            </span>
                            <span className={`text-xs font-bold ${isMe ? 'text-emerald-100' : 'text-blue-700'}`}>
                              {log.sender_name}
                            </span>
                            <span className={`text-xs ${isMe ? 'text-emerald-200' : 'text-gray-500'}`}>
                              {formatDateTime(log.created_at)}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleHideChat(log.id)}
                              title="ซ่อนข้อความนี้"
                              className={`opacity-0 group-hover:opacity-100 p-0.5 rounded transition-all ${
                                isMe ? 'text-emerald-100 hover:text-red-200' : 'text-gray-400 hover:text-red-500'
                              }`}
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                          <div className="text-sm whitespace-pre-wrap leading-relaxed">{log.message}</div>
                        </div>
                      </div>
                    )
                  })}
                  <div ref={chatEndRef} className="h-px w-full shrink-0" aria-hidden />
                </>
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
                    onChange={(e) => {
                      const checked = e.target.checked
                      setSendOnEnter(checked)
                      if (user?.id) setChatEnterToSendPref(user.id, 'order-confirm', checked)
                    }}
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
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 font-semibold transition-colors"
                >
                  <FiMessageCircle className="w-4 h-4" />
                  {chatSending ? 'กำลังส่ง...' : 'ส่งข้อความ'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={copyFeedbackModal.open}
        onClose={() => setCopyFeedbackModal({ open: false, title: '', message: '' })}
        contentClassName="max-w-sm"
      >
        <div className="p-6 text-center">
          <h4 className="text-base font-bold text-gray-800 mb-2">{copyFeedbackModal.title}</h4>
          <p className="text-sm text-gray-600 mb-4">{copyFeedbackModal.message}</p>
          <button
            type="button"
            onClick={() => setCopyFeedbackModal({ open: false, title: '', message: '' })}
            className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
          >
            ตกลง
          </button>
        </div>
      </Modal>
    </div>
  )
}
