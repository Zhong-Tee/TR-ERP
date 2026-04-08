import { useState, useEffect } from 'react'
import { useMenuAccess } from '../contexts/MenuAccessContext'
import { useAuthContext } from '../contexts/AuthContext'
import OrderList from '../components/order/OrderList'
import OrderForm from '../components/order/OrderForm'
import OrderConfirmBoard from '../components/order/OrderConfirmBoard'
import IssueBoard from '../components/order/IssueBoard'
import { Order, OrderStatus } from '../types'
import { supabase } from '../lib/supabase'
import {
  canSeeOfficeChannel,
  isSalesPumpOwnerScopedRole,
  isSalesTrTeamRole,
  resolveSalesPumpOwnerAdminName,
} from '../config/accessPolicy'
import { fetchSalesTrTeamAdminValues, fetchSalesTrTeamRows, flattenSalesTrAdminIdentifiers } from '../lib/salesTrTeam'

type Tab =
  | 'all'
  | 'create'
  | 'waiting'
  | 'complete'
  | 'verified'
  | 'confirm'
  | 'issue'
  | 'data-error'
  | 'shipped'
  | 'cancelled'

const ALL_TABS: Tab[] = ['all', 'create', 'waiting', 'data-error', 'complete', 'verified', 'confirm', 'shipped', 'cancelled', 'issue']

/** แท็บที่ sales-tr มี dropdown + ปุ่มเฉพาะฉัน กรอง admin_user */
const SALES_TR_FILTER_TABS: Tab[] = ['all', 'waiting', 'data-error', 'complete', 'verified', 'shipped', 'issue']
const ALL_STATUS_FILTER_OPTIONS = [
  'รอลงข้อมูล',
  'ลงข้อมูลผิด',
  'ตรวจสอบไม่ผ่าน',
  'ตรวจสอบไม่สำเร็จ',
  'ตรวจสอบแล้ว',
  'รอออกแบบ',
  'ไม่ต้องออกแบบ',
  'ออกแบบแล้ว',
  'รอคอนเฟิร์ม',
  'คอนเฟิร์มแล้ว',
  'ใบสั่งงาน',
  'ย้ายจากใบงาน',
  'ใบงานกำลังผลิต',
  'จัดส่งแล้ว',
  'ยกเลิก',
] as const

export default function Orders() {
  const { hasAccess, menuAccessLoading } = useMenuAccess()
  const { user } = useAuthContext()
  const [activeTab, setActiveTab] = useState<Tab>('create')
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  const [waitingCount, setWaitingCount] = useState(0)
  const [completeCount, setCompleteCount] = useState(0)
  const [verifiedCount, setVerifiedCount] = useState(0)
  const [dataErrorCount, setDataErrorCount] = useState(0)
  const [cancelledCount, setCancelledCount] = useState(0)
  
  const [confirmCount, setConfirmCount] = useState(0)
  const [shippedCount, setShippedCount] = useState(0)
  const [shippedFilteredCount, setShippedFilteredCount] = useState(0)
  const [issueCount, setIssueCount] = useState(0)
  const [allCount, setAllCount] = useState(0)
  const [channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [listRefreshKey, setListRefreshKey] = useState(0)
  const [shippedDateFrom, setShippedDateFrom] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  })
  const [shippedDateTo, setShippedDateTo] = useState(() => new Date().toISOString().split('T')[0])
  const [allDateFrom, setAllDateFrom] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  })
  const [allDateTo, setAllDateTo] = useState(() => new Date().toISOString().split('T')[0])
  const [allStatusFilter, setAllStatusFilter] = useState<OrderStatus | ''>('')
  const [salesTrAdminValues, setSalesTrAdminValues] = useState<string[]>([])
  const [salesTrTeamRows, setSalesTrTeamRows] = useState<{ username?: string | null; email?: string | null }[]>([])
  /** กรองตามสมาชิกทีม ('' = ทั้งทีม) — ใช้ร่วมหลายแท็บ */
  const [salesTrMemberFilter, setSalesTrMemberFilter] = useState('')
  /** แสดงเฉพาะบิลที่ admin_user เป็นตัวเอง (username / email) */
  const [salesTrOnlyMe, setSalesTrOnlyMe] = useState(false)

  useEffect(() => {
    if (menuAccessLoading) return
    if (!hasAccess(`orders-${activeTab}`)) {
      const first = ALL_TABS.find((t) => hasAccess(`orders-${t}`))
      if (first) setActiveTab(first)
    }
  }, [menuAccessLoading])

  useEffect(() => {
    if (user?.role !== 'sales-tr') {
      setSalesTrAdminValues([])
      setSalesTrTeamRows([])
      setSalesTrMemberFilter('')
      setSalesTrOnlyMe(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const rows = await fetchSalesTrTeamRows(supabase)
        if (cancelled) return
        setSalesTrTeamRows(rows)
        setSalesTrAdminValues(flattenSalesTrAdminIdentifiers(rows))
      } catch (e) {
        console.error('Error loading sales-tr team:', e)
        if (!cancelled) {
          setSalesTrTeamRows([])
          setSalesTrAdminValues([])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user?.role])

  function handleOrderClick(order: Order) {
    setSelectedOrder(order)
    setActiveTab('create')
  }

  /** คลิกที่รายการใน ตรวจสอบแล้ว/ยกเลิก → แสดงรายละเอียดเพื่อดู (read-only) โดยไม่สลับแท็บ */
  function handleOrderClickViewOnly(order: Order) {
    setSelectedOrder(order)
  }

  /** options.switchToTab: หลัง save แล้วให้สลับไปแท็บนั้น (เช่น ปฏิเสธโอนเกิน → ตรวจสอบไม่ผ่าน) */
  function handleSave(options?: { switchToTab?: 'complete' }) {
    setSelectedOrder(null)
    setActiveTab(options?.switchToTab === 'complete' ? 'complete' : 'waiting')
    // Refresh counts immediately
    refreshCounts()
  }

  async function refreshCounts() {
    let salesTrScope: string[] | null = null
    if (isSalesTrTeamRole(user?.role)) {
      try {
        salesTrScope = await fetchSalesTrTeamAdminValues(supabase)
      } catch (e) {
        console.error('refreshCounts sales-tr team:', e)
        salesTrScope = []
      }
    }

    function applyOwnerFilter(query: any) {
      if (isSalesPumpOwnerScopedRole(user?.role)) {
        const name = resolveSalesPumpOwnerAdminName(user?.role, user?.username, user?.email)
        return name ? query.eq('admin_user', name) : query
      }
      if (isSalesTrTeamRole(user?.role)) {
        if (!salesTrScope || salesTrScope.length === 0) {
          return query.eq('admin_user', '__no_sales_tr_team__')
        }
        return query.in('admin_user', salesTrScope)
      }
      return query
    }

    try {
      // Load waiting count
      const { count: waitingCount } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true }).eq('status', 'รอลงข้อมูล')
      )
      
      // Load complete count (รวม ตรวจสอบไม่ผ่าน และ ตรวจสอบไม่สำเร็จ)
      const { count: completeCount } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true }).in('status', ['ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ'])
      )

      // Load verified count (OFFICE: เฉพาะ superadmin/admin เห็น)
      let verifiedQuery = supabase.from('or_orders').select('id', { count: 'exact', head: true }).eq('status', 'ตรวจสอบแล้ว')
      if (!canSeeOfficeChannel(user?.role)) {
        verifiedQuery = verifiedQuery.neq('channel_code', 'OFFICE')
      }
      const { count: verifiedCount } = await applyOwnerFilter(verifiedQuery)

      // Load data error count
      const { count: dataErrorCount } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true }).eq('status', 'ลงข้อมูลผิด')
      )

      // Load cancelled count
      const { count: cancelledCount } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true }).eq('status', 'ยกเลิก')
      )

      // Load shipped count
      const { count: shippedCount } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true }).eq('status', 'จัดส่งแล้ว')
      )

      // Load confirm count: PUMP ทุกบิลในสถานะคิว + ช่องอื่นที่ติ๊กออกแบบ (requires_confirm_design)
      const confirmStatusList = [
        'ตรวจสอบแล้ว',
        'รอออกแบบ',
        'ไม่ต้องออกแบบ',
        'ออกแบบแล้ว',
        'รอคอนเฟิร์ม',
        'คอนเฟิร์มแล้ว',
      ] as const
      const { count: confirmPump } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true })
          .eq('channel_code', 'PUMP')
          .in('status', [...confirmStatusList]),
      )
      const { count: confirmOtherChannels } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true })
          .eq('requires_confirm_design', true)
          .neq('channel_code', 'PUMP')
          .in('status', [...confirmStatusList]),
      )
      const confirmCountTotal = (confirmPump ?? 0) + (confirmOtherChannels ?? 0)

      // Load issue count (On) — sales-tr นับเฉพาะบิลที่ admin_user เป็นของทีม sales-tr
      let issueCount = 0
      if (isSalesTrTeamRole(user?.role)) {
        const vals = salesTrScope || []
        if (vals.length > 0) {
          const ir = await supabase
            .from('or_issues')
            .select('id, or_orders!inner(admin_user)', { count: 'exact', head: true })
            .eq('status', 'On')
            .in('or_orders.admin_user', vals)
          if (!ir.error) issueCount = ir.count ?? 0
          else {
            console.warn('Issue count join query failed, fallback:', ir.error)
            const { count: ic } = await supabase
              .from('or_issues')
              .select('id', { count: 'exact', head: true })
              .eq('status', 'On')
            issueCount = ic ?? 0
          }
        }
      } else {
        const { count: ic } = await supabase
          .from('or_issues')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'On')
        issueCount = ic ?? 0
      }

      setWaitingCount(waitingCount || 0)
      setCompleteCount(completeCount || 0)
      setVerifiedCount(verifiedCount || 0)
      setDataErrorCount(dataErrorCount || 0)
      setCancelledCount(cancelledCount || 0)
      setConfirmCount(confirmCountTotal ?? 0)
      setShippedCount(shippedCount || 0)
      setIssueCount(issueCount || 0)
      // แจ้ง Sidebar ให้อัปเดตตัวเลขเมนูทันที
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
    } catch (error) {
      console.error('Error refreshing counts:', error)
    }
  }

  function handleCancel() {
    setSelectedOrder(null)
  }

  async function handleMoveToWaiting(order: Order) {
    try {
      const { data: latestOrder, error: latestErr } = await supabase
        .from('or_orders')
        .select('id, status')
        .eq('id', order.id)
        .single()
      if (latestErr) throw latestErr

      const latestStatus = String((latestOrder as any)?.status || order.status || '')
      if (latestStatus === 'ยกเลิก') {
        const { count: approvedCancelCount, error: amendErr } = await supabase
          .from('or_order_amendments')
          .select('id', { count: 'exact', head: true })
          .eq('order_id', order.id)
          .in('status', ['approved', 'executed'])
        if (amendErr) throw amendErr
        if ((approvedCancelCount || 0) > 0) {
          alert('บิลนี้อนุมัติยกเลิกแล้ว ไม่สามารถย้ายกลับไป "รอลงข้อมูล" ได้')
          return
        }
      }

      const { error } = await supabase
        .from('or_orders')
        .update({ status: 'รอลงข้อมูล' })
        .eq('id', order.id)
      if (error) throw error
      refreshCounts()
      setListRefreshKey((k) => k + 1)
    } catch (err: any) {
      console.error('Error moving order to waiting:', err)
      alert('เกิดข้อผิดพลาด: ' + (err?.message || err))
    }
  }

  /** ลบบิล (รอลงข้อมูล): ลบรูปใน bucket slip-images/slip{bill_no} แล้วลบ or_orders (cascade ลบ items, reviews, slips, refunds) */
  async function handleDeleteOrder(order: Order) {
    try {
      const billNo = order.bill_no
      if (billNo) {
        const folderName = `slip${billNo}`
        const { data: files, error: listError } = await supabase.storage
          .from('slip-images')
          .list(folderName, { limit: 200 })
        if (!listError && files && files.length > 0) {
          const filePaths = files
            .filter((f) => f.name && !f.name.endsWith('/'))
            .map((f) => `${folderName}/${f.name}`)
          if (filePaths.length > 0) {
            const { error: removeError } = await supabase.storage
              .from('slip-images')
              .remove(filePaths)
            if (removeError) console.warn('ลบรูปสลิปไม่ครบ:', removeError)
          }
        }
      }
      const { error: deleteError } = await supabase
        .from('or_orders')
        .delete()
        .eq('id', order.id)
      if (deleteError) throw deleteError
      if (selectedOrder?.id === order.id) setSelectedOrder(null)
      refreshCounts()
      setListRefreshKey((k) => k + 1)
    } catch (err: any) {
      console.error('Error deleting order:', err)
      alert('เกิดข้อผิดพลาดในการลบบิล: ' + (err?.message || err))
      throw err
    }
  }

  // โหลด channels จากตาราง
  useEffect(() => {
    async function loadChannels() {
      try {
        const { data, error } = await supabase
          .from('channels')
          .select('channel_code, channel_name')
          .order('channel_code', { ascending: true })

        if (error) throw error
        setChannels(data || [])
      } catch (error) {
        console.error('Error loading channels:', error)
      }
    }

    loadChannels()
  }, [])

  // โหลดตัวเลขทุกแท็บทันทีเมื่อเปิดหน้า (แบบขนาน) + realtime เมื่อ or_orders / ac_refunds เปลี่ยน
  useEffect(() => {
    async function loadCounts() {
      try {
        await refreshCounts()
      } catch (error) {
        console.error('Error loading counts:', error)
      }
    }

    loadCounts()

    const channel = supabase
      .channel('orders-count-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, () => {
        loadCounts()
        setListRefreshKey((k) => k + 1)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ac_refunds' }, () => loadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_issues' }, () => loadCounts())
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [searchTerm, channelFilter])

  // ฟัง event จาก TopBar เพื่อเปลี่ยนไปแท็บ Issue
  useEffect(() => {
    const onNavigateToIssue = () => {
      setActiveTab('issue')
      setSelectedOrder(null)
    }
    window.addEventListener('navigate-to-issue', onNavigateToIssue)
    return () => window.removeEventListener('navigate-to-issue', onNavigateToIssue)
  }, [])

  // จาก IssueBoard (ข้อความยังไม่อ่าน) → ไป Confirm แล้วเปิดแชทบิล
  useEffect(() => {
    const onNavigateToOrderChat = (e: Event) => {
      const orderId = (e as CustomEvent<{ orderId?: string }>).detail?.orderId
      if (!orderId) return
      setActiveTab('confirm')
      setSelectedOrder(null)
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('open-confirm-order-chat', { detail: { orderId } }))
      }, 120)
    }
    window.addEventListener('navigate-to-order-chat', onNavigateToOrderChat)
    return () => window.removeEventListener('navigate-to-order-chat', onNavigateToOrderChat)
  }, [])

  function narrowSalesTrAdminUserForTab(): string | undefined {
    if (user?.role !== 'sales-tr' || !SALES_TR_FILTER_TABS.includes(activeTab)) return undefined
    if (salesTrOnlyMe) {
      const self = user.username?.trim() || user.email?.trim()
      return self || undefined
    }
    if (salesTrMemberFilter.trim()) return salesTrMemberFilter.trim()
    return undefined
  }

  const salesTrOrderListProps =
    user?.role === 'sales-tr'
      ? {
          salesTrTeamAdminValues: salesTrAdminValues,
          narrowSalesTrAdminUser: narrowSalesTrAdminUserForTab(),
        }
      : {}

  const suppressSalesTrListCountSync =
    user?.role === 'sales-tr' &&
    SALES_TR_FILTER_TABS.includes(activeTab) &&
    (salesTrOnlyMe || !!salesTrMemberFilter.trim())

  return (
    <div
      className="w-full"
    >
      {/* หัวเมนูย่อย — sticky ภายใน scroll container ไม่ทะลุ */}
      <div
        className="sticky top-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6 px-6"
      >
        {/* Navigation Tabs */}
        <div className="w-full px-4 sm:px-6 lg:px-8 overflow-x-auto scrollbar-thin">
          <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3" aria-label="Tabs">
            {[
              { id: 'all', label: 'ทั้งหมด' },
              { id: 'create', label: 'สร้าง/แก้ไข' },
              { id: 'waiting', label: `รอลงข้อมูล (${waitingCount})` },
              { id: 'data-error', label: `ลงข้อมูลผิด (${dataErrorCount})` },
              { id: 'complete', label: 'ตรวจสอบไม่ผ่าน', count: completeCount, countColor: 'text-red-600' },
              { id: 'verified', label: 'ตรวจสอบแล้ว', count: verifiedCount, countColor: 'text-green-600' },
              { id: 'confirm', label: 'Confirm', count: confirmCount, countColor: 'text-blue-600' },
              { id: 'shipped', label: 'จัดส่งแล้ว' },
              { id: 'cancelled', label: `ยกเลิก (${cancelledCount})`, labelColor: 'text-orange-600' },
              { id: 'issue', label: 'Issue', count: issueCount, countColor: 'text-blue-600' },
            ].filter((tab) => hasAccess(`orders-${tab.id}`)).map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.id as Tab)
                  setSelectedOrder(null)
                }}
                className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap flex-shrink-0 transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-blue-600'
                }`}
              >
                {'count' in tab && tab.count !== undefined && 'countColor' in tab
                  ? <>
                      {tab.label}{' '}
                      <span className={`font-semibold ${tab.countColor}`}>({tab.count})</span>
                    </>
                  : tab.label
                }
              </button>
            ))}
          </nav>
        </div>

        {/* Search and Filter - แสดงเมื่อไม่ใช่แท็บสร้าง/แก้ไข */}
        {activeTab !== 'create' && activeTab !== 'confirm' && (
          <div className="w-full px-4 sm:px-6 lg:px-8 py-3 bg-surface-100 border-t border-surface-200">
            <div className="flex flex-wrap gap-3">
              <input
                type="text"
                placeholder="ค้นหา..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="flex-1 min-w-[200px] px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-300 bg-surface-50 text-base"
              />
              <select
                value={channelFilter}
                onChange={(e) => setChannelFilter(e.target.value)}
                className="px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-200 bg-surface-50 text-base"
              >
                <option value="">ทั้งหมด</option>
                {channels.map((ch) => (
                  <option key={ch.channel_code} value={ch.channel_code}>
                    {ch.channel_name || ch.channel_code}
                  </option>
                ))}
              </select>
              {activeTab === 'all' && (
                <>
                  <select
                    value={allStatusFilter}
                    onChange={(e) => setAllStatusFilter((e.target.value || '') as OrderStatus | '')}
                    className="px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-200 bg-surface-50 text-base"
                  >
                    <option value="">ทุกสถานะ</option>
                    {ALL_STATUS_FILTER_OPTIONS.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    value={allDateFrom}
                    onChange={(e) => setAllDateFrom(e.target.value)}
                    className="px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-200 bg-surface-50 text-base"
                  />
                  <input
                    type="date"
                    value={allDateTo}
                    onChange={(e) => setAllDateTo(e.target.value)}
                    className="px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-200 bg-surface-50 text-base"
                  />
                </>
              )}
              {activeTab === 'shipped' && (
                <>
                  <input
                    type="date"
                    value={shippedDateFrom}
                    onChange={(e) => setShippedDateFrom(e.target.value)}
                    className="px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-200 bg-surface-50 text-base"
                  />
                  <input
                    type="date"
                    value={shippedDateTo}
                    onChange={(e) => setShippedDateTo(e.target.value)}
                    className="px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-200 bg-surface-50 text-base"
                  />
                  <div className="text-sm font-semibold text-surface-700 flex items-center px-3 py-2 rounded-xl bg-white border border-surface-200">
                    จำนวนบิลหลังกรอง: {shippedFilteredCount.toLocaleString()} รายการ
                  </div>
                </>
              )}
              {SALES_TR_FILTER_TABS.includes(activeTab) && user?.role === 'sales-tr' && (
                <>
                  <select
                    value={salesTrMemberFilter}
                    disabled={salesTrOnlyMe}
                    onChange={(e) => {
                      setSalesTrMemberFilter(e.target.value)
                      setSalesTrOnlyMe(false)
                    }}
                    className="min-w-[200px] px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-200 bg-surface-50 text-base disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label="กรองตามผู้ลงข้อมูล sales-tr"
                  >
                    <option value="">ทีม sales-tr ทั้งหมด</option>
                    {salesTrTeamRows.map((row, idx) => {
                      const label = row.username?.trim() || row.email?.trim() || `user-${idx}`
                      const value = row.username?.trim() || row.email?.trim() || ''
                      if (!value) return null
                      return (
                        <option key={`${value}-${idx}`} value={value}>
                          {label}
                        </option>
                      )
                    })}
                  </select>
                  <button
                    type="button"
                    onClick={() => {
                      setSalesTrOnlyMe((v) => {
                        const next = !v
                        if (next) setSalesTrMemberFilter('')
                        return next
                      })
                    }}
                    className={`shrink-0 px-4 py-2.5 rounded-xl border text-base font-medium transition-colors ${
                      salesTrOnlyMe
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-800 ring-2 ring-emerald-200'
                        : 'border-surface-300 bg-surface-50 text-gray-700 hover:bg-surface-100'
                    }`}
                  >
                    เฉพาะฉัน
                  </button>
                </>
              )}
              {activeTab === 'all' && (
                <div className="ml-auto text-sm font-semibold text-surface-700 flex items-center px-3 py-2 rounded-xl bg-white border border-surface-200">
                  จำนวนบิลหลังกรอง: {allCount.toLocaleString()} รายการ
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ส่วนเนื้อหาทุกเมนู — อยู่ใต้ sticky เมนูย่อยปกติ */}
      <main
        className="w-full pb-6 min-h-0 pt-4"
        aria-label="เนื้อหาออเดอร์"
      >
        {selectedOrder ? (
          <OrderForm
            order={selectedOrder}
            onSave={handleSave}
            onCancel={handleCancel}
            onOpenOrder={(o) => { setSelectedOrder(o); setActiveTab('create') }}
            readOnly={activeTab !== 'create'}
            viewOnly={activeTab === 'verified' || activeTab === 'cancelled' || activeTab === 'shipped'}
          />
        ) : activeTab === 'all' ? (
          <OrderList
            status={allStatusFilter ? allStatusFilter : undefined}
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClickViewOnly}
            onCountChange={setAllCount}
            dateFrom={allDateFrom}
            dateTo={allDateTo}
            refreshTrigger={listRefreshKey}
            useDetailViewOnClick={true}
            hideActionButtons={true}
            detailReadOnly={true}
            {...salesTrOrderListProps}
          />
        ) : activeTab === 'waiting' ? (
          <OrderList
            status="รอลงข้อมูล"
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClick}
            showBillingStatus={true}
            onCountChange={suppressSalesTrListCountSync ? undefined : setWaitingCount}
            showDeleteButton={true}
            onDelete={handleDeleteOrder}
            refreshTrigger={listRefreshKey}
            {...salesTrOrderListProps}
          />
        ) : activeTab === 'complete' ? (
          <OrderList
            status={['ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ']}
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClick}
            showBillingStatus={true}
            onCountChange={suppressSalesTrListCountSync ? undefined : setCompleteCount}
            showMoveToWaitingButton={true}
            onMoveToWaiting={handleMoveToWaiting}
            refreshTrigger={listRefreshKey}
            useDetailViewOnClick={true}
            {...salesTrOrderListProps}
          />
        ) : activeTab === 'verified' ? (
          <OrderList
            status="ตรวจสอบแล้ว"
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClickViewOnly}
            verifiedOnly={true}
            onCountChange={suppressSalesTrListCountSync ? undefined : setVerifiedCount}
            showMoveToWaitingButton={true}
            onMoveToWaiting={handleMoveToWaiting}
            refreshTrigger={listRefreshKey}
            useDetailViewOnClick={true}
            {...salesTrOrderListProps}
          />
        ) : activeTab === 'confirm' ? (
          <OrderConfirmBoard onCountChange={setConfirmCount} />
        ) : activeTab === 'issue' ? (
          <IssueBoard
            scope="orders"
            onOpenCountChange={suppressSalesTrListCountSync ? undefined : setIssueCount}
            salesTrNarrowAdminUser={
              user?.role === 'sales-tr' ? narrowSalesTrAdminUserForTab() : undefined
            }
          />
        ) : activeTab === 'data-error' ? (
          <OrderList
            status="ลงข้อมูลผิด"
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClick}
            showBillingStatus={true}
            onCountChange={suppressSalesTrListCountSync ? undefined : setDataErrorCount}
            {...salesTrOrderListProps}
          />
        ) : activeTab === 'shipped' ? (
          <OrderList
            status="จัดส่งแล้ว"
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClickViewOnly}
            dateFrom={shippedDateFrom}
            dateTo={shippedDateTo}
            onCountChange={setShippedFilteredCount}
            refreshTrigger={listRefreshKey}
            useDetailViewOnClick={true}
            detailReadOnly={true}
            {...salesTrOrderListProps}
          />
        ) : activeTab === 'cancelled' ? (
          <OrderList
            status="ยกเลิก"
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClickViewOnly}
            onCountChange={setCancelledCount}
            showMoveToWaitingButton={true}
            onMoveToWaiting={handleMoveToWaiting}
            refreshTrigger={listRefreshKey}
            {...salesTrOrderListProps}
          />
        ) : (
          <OrderForm
            onSave={handleSave}
            onCancel={handleCancel}
            onOpenOrder={(o) => { setSelectedOrder(o); setActiveTab('create') }}
          />
        )}
      </main>
    </div>
  )
}
