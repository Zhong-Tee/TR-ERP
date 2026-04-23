import { useAuthContext } from '../../contexts/AuthContext'
import { useMenuAccess } from '../../contexts/MenuAccessContext'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useWmsModal } from '../wms/useWmsModal'
import { canClearAllChats, canUseIssueChat, resolveMenuKeyFromPath } from '../../config/accessPolicy'
import { dispatchIssueOnCount } from '../../lib/issueOnCountBroadcast'

interface TopBarProps {
  sidebarOpen: boolean
  onToggleSidebar?: () => void
}

export default function TopBar({ sidebarOpen, onToggleSidebar }: TopBarProps) {
  const { user, signOut } = useAuthContext()
  const { hasAccess } = useMenuAccess()
  const location = useLocation()
  const navigate = useNavigate()
  const [issueOnCount, setIssueOnCount] = useState(0)
  const [newChatCount, setNewChatCount] = useState(0)
  const [menuCount, setMenuCount] = useState<number | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [clearingChat, setClearingChat] = useState(false)
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()
  const [belowOrderPointCount, setBelowOrderPointCount] = useState(0)
  const [warehousePendingReturnCount, setWarehousePendingReturnCount] = useState(0)
  const [purchaseBadge, setPurchaseBadge] = useState<{ pr_pending: number; pr_approved_no_po: number; po_waiting_gr: number }>({ pr_pending: 0, pr_approved_no_po: 0, po_waiting_gr: 0 })
  const [notifyCollapsed, setNotifyCollapsed] = useState(true)
  const [notifyBlinking, setNotifyBlinking] = useState(false)
  const prevIssueCountRef = useRef(0)
  const prevChatCountRef = useRef(0)

  // ── รับค่า warehouse count จาก Sidebar RPC + จากหน้า Warehouse (Hold / logic เดียวกับปุ่ม "ถึงจุดสั่งซื้อ") ──
  useEffect(() => {
    const onWarehouseCount = (e: Event) => {
      const count = (e as CustomEvent).detail?.count
      if (typeof count === 'number') setBelowOrderPointCount(count)
    }
    const onPendingReturnCount = (e: Event) => {
      const count = (e as CustomEvent).detail?.count
      if (typeof count === 'number') setWarehousePendingReturnCount(count)
    }
    const onPurchaseBadge = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail) setPurchaseBadge(detail)
    }
    window.addEventListener('sidebar-warehouse-count', onWarehouseCount)
    window.addEventListener('warehouse-below-order-point', onWarehouseCount)
    window.addEventListener('sidebar-pending-return-count', onPendingReturnCount)
    window.addEventListener('sidebar-purchase-badge', onPurchaseBadge)
    return () => {
      window.removeEventListener('sidebar-warehouse-count', onWarehouseCount)
      window.removeEventListener('warehouse-below-order-point', onWarehouseCount)
      window.removeEventListener('sidebar-pending-return-count', onPendingReturnCount)
      window.removeEventListener('sidebar-purchase-badge', onPurchaseBadge)
    }
  }, [])

  // รับตัวเลขจำนวนจากหน้าลูก (เช่น AdminQC)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail && typeof detail.count === 'number') {
        setMenuCount(detail.count)
      }
    }
    window.addEventListener('topbar-menu-count', handler)
    return () => window.removeEventListener('topbar-menu-count', handler)
  }, [])

  // รีเซ็ตตัวเลขเมื่อเปลี่ยนหน้า
  useEffect(() => {
    setMenuCount(null)
  }, [location.pathname])

  const menuTitle = (() => {
    const path = location.pathname
    if (path.startsWith('/dashboard')) return 'Dashboard'
    if (path.startsWith('/orders')) return 'ออเดอร์'
    if (path.startsWith('/admin-qc')) return 'รอตรวจคำสั่งซื้อ'
    if (path.startsWith('/account')) return 'บัญชี'
    if (path.startsWith('/export')) return 'ใบงาน'
    if (path.startsWith('/plan')) return 'Plan'
    if (path.startsWith('/machinery')) return 'Machinery'
    if (path.startsWith('/wms')) return 'จัดสินค้า'
    if (path.startsWith('/qc')) return 'QC Operation'
    if (path.startsWith('/packing')) return 'จัดของ'
    if (path.startsWith('/transport')) return 'ทวนสอบขนส่ง'
    if (path.startsWith('/products')) return 'สินค้า'
    if (path.startsWith('/cartoon-patterns')) return 'ลายการ์ตูน'
    if (path.startsWith('/warehouse')) return 'คลัง'
    if (path.startsWith('/purchase')) return 'สั่งซื้อ'
    if (path.startsWith('/sales-reports')) return 'รายงานยอดขาย'
    if (path.startsWith('/kpi')) return 'KPI'
    if (path.startsWith('/hr')) return 'HR'
    if (path.startsWith('/settings')) return 'ตั้งค่า'
    return 'เมนู'
  })()

  const handleLogout = async () => {
    const ok = await showConfirm({ title: 'ออกจากระบบ', message: 'ต้องการออกจากระบบหรือไม่?' })
    if (!ok) return
    setLoggingOut(true)
    try {
      await signOut()
    } catch (error: any) {
      showMessage({ message: 'เกิดข้อผิดพลาด: ' + error.message })
    } finally {
      setLoggingOut(false)
    }
  }

  // Role ที่เห็นแชท/issue
  const canSeeChat = canUseIssueChat(user?.role)
  const isAdminRole = canClearAllChats(user?.role)

  // ── RPC: ดึง issue count + unread chat ใน 1 query (แทน 8-10 queries เดิม) ──
  const chatDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (chatDebounceRef.current) clearTimeout(chatDebounceRef.current) }, [])

  const loadChatCounts = useCallback(async () => {
    if (!user || !canSeeChat) {
      setIssueOnCount(0)
      setNewChatCount(0)
      return
    }
    try {
      const { data, error } = await supabase.rpc('get_unread_chat_count', {
        p_user_id: user.id,
        p_role: (user.role || '').trim(),
        p_username: (user.username || user.email || '').trim(),
      })
      if (error) throw error
      setIssueOnCount(data?.issue_on_count ?? 0)
      setNewChatCount((data?.issue_unread ?? 0) + (data?.order_unread ?? 0))
    } catch (error) {
      console.error('Error loading chat counts:', error)
    }
  }, [user, canSeeChat])

  const clearAllChatNotifications = useCallback(async () => {
    if (!user) return
    setClearingChat(true)
    try {
      const now = new Date().toISOString()
      const [{ data: issues }, { data: orders }] = await Promise.all([
        supabase.from('or_issue_messages').select('issue_id'),
        supabase.from('or_order_chat_logs').select('order_id').eq('is_hidden', false),
      ])
      const issueIds = [...new Set((issues || []).map((r: any) => r.issue_id))]
      const orderIds = [...new Set((orders || []).map((r: any) => r.order_id))]
      const promises: PromiseLike<any>[] = []
      if (issueIds.length > 0) {
        promises.push(
          supabase.from('or_issue_reads').upsert(
            issueIds.map((id) => ({ issue_id: id, user_id: user.id, last_read_at: now })),
            { onConflict: 'issue_id,user_id' }
          ).then()
        )
      }
      if (orderIds.length > 0) {
        promises.push(
          supabase.from('or_order_chat_reads').upsert(
            orderIds.map((id) => ({ order_id: id, user_id: user.id, last_read_at: now })),
            { onConflict: 'order_id,user_id' }
          ).then()
        )
      }
      await Promise.all(promises)
      setNewChatCount(0)
      await loadChatCounts()
    } catch (error) {
      console.error('Error clearing chat notifications:', error)
    } finally {
      setClearingChat(false)
    }
  }, [user, loadChatCounts])

  const debouncedLoadChatCounts = useCallback(() => {
    if (chatDebounceRef.current) clearTimeout(chatDebounceRef.current)
    chatDebounceRef.current = setTimeout(() => loadChatCounts(), 2_000)
  }, [loadChatCounts])

  useEffect(() => {
    if (!canSeeChat) {
      setIssueOnCount(0)
      setNewChatCount(0)
      setNotifyCollapsed(true)
      setNotifyBlinking(false)
      return
    }
    loadChatCounts()
    const channel = supabase
      .channel('topbar-issue-counts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_issues' }, () => debouncedLoadChatCounts())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'or_issue_messages' }, (payload) => {
        const sid = (payload.new as { sender_id?: string })?.sender_id
        if (user?.id && sid === user.id) return
        debouncedLoadChatCounts()
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'or_order_chat_logs' }, (payload) => {
        const sid = (payload.new as { sender_id?: string })?.sender_id
        if (user?.id && sid === user.id) return
        debouncedLoadChatCounts()
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [canSeeChat, user?.id, loadChatCounts, debouncedLoadChatCounts])

  // เด้งกล่องแจ้งเตือนออกทันทีเมื่อมี Issue/Chat ใหม่เพิ่มขึ้น
  useEffect(() => {
    if (!canSeeChat) return
    const hasNewIssue = issueOnCount > prevIssueCountRef.current
    const hasNewChat = newChatCount > prevChatCountRef.current
    if (hasNewIssue || hasNewChat) {
      setNotifyCollapsed(false)
      setNotifyBlinking(true)
    }
    prevIssueCountRef.current = issueOnCount
    prevChatCountRef.current = newChatCount
  }, [canSeeChat, issueOnCount, newChatCount])

  // แจ้ง Plan / Sidebar ให้ใช้ตัวเลขเดียวกับ TopBar โดยไม่ subscribe ซ้ำ
  useEffect(() => {
    if (!canSeeChat) {
      dispatchIssueOnCount(0)
      return
    }
    dispatchIssueOnCount(issueOnCount)
  }, [canSeeChat, issueOnCount])

  // ── เมื่อ user อ่านแชทแล้ว → รีเฟรช count ──
  useEffect(() => {
    if (!canSeeChat) return
    const onChatRead = () => { if (user) loadChatCounts() }
    window.addEventListener('issue-chat-read', onChatRead)
    window.addEventListener('order-chat-read', onChatRead)
    return () => {
      window.removeEventListener('issue-chat-read', onChatRead)
      window.removeEventListener('order-chat-read', onChatRead)
    }
  }, [user, canSeeChat, loadChatCounts])

  const issueTabs = [
    { key: 'on', label: `New Issue (${issueOnCount})` },
    { key: 'unread', label: `New Chat (${newChatCount})` },
  ]

  /** Navigate to the correct Issue page based on role, then switch Issue tab (on / unread / …) */
  const handleIssueClick = (tabKey: string) => {
    // กำหนดเส้นทางตาม role
    const isProductionRole = user?.role === 'production'
    const targetPath = isProductionRole ? '/plan' : '/orders'

    // ถ้าอยู่ในหน้าที่ถูกต้องแล้ว → แค่ส่ง event สลับ tab
    if (location.pathname === targetPath) {
      // ส่ง event ให้หน้า Orders/Plan สลับไปแท็บ issue ก่อน
      window.dispatchEvent(new CustomEvent('navigate-to-issue', { detail: { tab: tabKey } }))
      // แล้วส่ง event ให้ IssueBoard สลับ on/close
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('issue-tab-change', { detail: { tab: tabKey } }))
      }, 50)
    } else {
      // navigate ไปหน้าที่ถูกต้อง
      navigate(targetPath)
      // รอ render แล้วส่ง event
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('navigate-to-issue', { detail: { tab: tabKey } }))
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('issue-tab-change', { detail: { tab: tabKey } }))
        }, 100)
      }, 150)
    }
  }

  const warehouseTabs = [
    { path: '/warehouse/sub', label: 'คลังย่อย' },
    { path: '/warehouse', label: 'คลังสินค้า' },
    { path: '/warehouse/audit', label: 'Audit' },
    { path: '/warehouse/adjust', label: 'ปรับสต๊อค' },
    { path: '/warehouse/returns', label: 'รับสินค้าตีกลับ' },
    { path: '/warehouse/production', label: 'ผลิตภายใน' },
    { path: '/warehouse/roll-calc', label: 'Roll Material Calculator' },
    { path: '/warehouse/sales-list', label: 'รายการขายสินค้า' },
  ].filter((tab) => {
    const menuKey = resolveMenuKeyFromPath(tab.path)
    return menuKey ? hasAccess(menuKey) : false
  })

  const purchaseTabs = [
    { path: '/purchase/pr', label: 'PR (ใบขอซื้อ)' },
    { path: '/purchase/po', label: 'PO (ใบสั่งซื้อ)' },
    { path: '/purchase/gr', label: 'GR (ใบรับสินค้า)' },
    { path: '/purchase/sample', label: 'สินค้าตัวอย่าง' },
  ].filter((tab) => {
    const menuKey = resolveMenuKeyFromPath(tab.path)
    return menuKey ? hasAccess(menuKey) : false
  })

  const productTabs = [
    { path: '/products', label: 'รายการสินค้า' },
    { path: '/products/inactive', label: 'รายการสินค้าไม่เคลื่อนไหว' },
  ].filter((tab) => {
    const menuKey = resolveMenuKeyFromPath(tab.path)
    return menuKey ? hasAccess(menuKey) : false
  })

  const hrTabs = [
    { path: '/hr', label: 'ทะเบียนพนักงาน' },
    { path: '/hr/leave', label: 'ระบบลางาน' },
    { path: '/hr/interview', label: 'นัดสัมภาษณ์' },
    { path: '/hr/attendance', label: 'เวลาทำงาน' },
    { path: '/hr/contracts', label: 'สัญญาจ้าง' },
    { path: '/hr/documents', label: 'กฏระเบียบ/SOP' },
    { path: '/hr/onboarding', label: 'รับพนักงานใหม่' },
    { path: '/hr/salary', label: 'เส้นทางเงินเดือน' },
    { path: '/hr/warnings', label: 'ใบเตือน' },
    { path: '/hr/certificates', label: 'ใบรับรอง' },
    { path: '/hr/assets', label: 'ทะเบียนทรัพย์สิน' },
    { path: '/hr/settings', label: 'ตั้งค่า' },
  ].filter((tab) => {
    const menuKey = resolveMenuKeyFromPath(tab.path)
    return menuKey ? hasAccess(menuKey) : false
  })

  const activeSubTabs = location.pathname.startsWith('/warehouse')
    ? warehouseTabs
    : location.pathname.startsWith('/purchase')
      ? purchaseTabs
      : location.pathname.startsWith('/products')
        ? productTabs
        : location.pathname.startsWith('/hr')
          ? hrTabs
          : []
  const showProductsSubBarCount = location.pathname.startsWith('/products') && menuCount !== null

  useEffect(() => {
    const height = activeSubTabs.length > 0 ? '4.5rem' : '0rem'
    document.documentElement.style.setProperty('--subnav-height', height)
    return () => {
      document.documentElement.style.setProperty('--subnav-height', '0rem')
    }
  }, [activeSubTabs.length])

  // Badge เมนู "รับสินค้าตีกลับ": แสดงเฉพาะสถานะรอดำเนินการ (pending)
  useEffect(() => {
    const loadWarehousePendingReturns = async () => {
      try {
        const { count, error } = await supabase
          .from('inv_returns')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'pending')
        if (error) throw error
        setWarehousePendingReturnCount(count || 0)
      } catch (error) {
        console.error('Error loading pending return count:', error)
      }
    }

    loadWarehousePendingReturns()
    const channel = supabase
      .channel('topbar-warehouse-returns-count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inv_returns' }, () => {
        loadWarehousePendingReturns()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  return (
    <>
      <header
        className={`bg-white text-slate-900 h-16 flex items-center justify-between px-6 border-b border-slate-200 shadow-sm fixed top-0 right-0 z-40 transition-all duration-300 ${
          sidebarOpen ? 'left-64' : 'left-20'
        }`}
      >
        <div className="flex items-center gap-3">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-700"
              title={sidebarOpen ? 'ปิดเมนู' : 'เปิดเมนู'}
              aria-label={sidebarOpen ? 'ปิดเมนู' : 'เปิดเมนู'}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          )}
          <h2 className="text-2xl font-semibold text-slate-900 tracking-tight">
            {menuTitle}
            {menuCount !== null && !location.pathname.startsWith('/products') && (
              <span className="ml-2 text-xl font-semibold text-slate-500 tabular-nums">({menuCount})</span>
            )}
          </h2>
          <div className="flex items-center gap-2">
            {canSeeChat && issueTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => handleIssueClick(tab.key)}
                className={`px-3 py-1.5 rounded-full text-sm font-semibold transition-colors shadow-sm ${
                  tab.key === 'on'
                    ? 'bg-amber-400 text-amber-950 hover:bg-amber-300'
                    : 'bg-orange-500 text-white hover:bg-orange-400'
                }`}
              >
                {tab.label}
              </button>
            ))}
            {canSeeChat && isAdminRole && newChatCount > 0 && (
              <button
                type="button"
                onClick={clearAllChatNotifications}
                disabled={clearingChat}
                title="ล้างแจ้งเตือนแชททั้งหมด"
                className="px-2 py-1.5 rounded-full text-xs font-semibold bg-sky-500 text-white hover:bg-sky-600 transition-colors disabled:opacity-50"
              >
                {clearingChat ? '...' : 'ล้าง'}
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
        {user && (
          <div className="text-sm text-slate-600">
            <span className="mr-4">{user.username || user.email}</span>
            <span className="text-slate-400">({user.role})</span>
          </div>
        )}
        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl transition-colors font-semibold disabled:opacity-50"
        >
          {loggingOut ? 'กำลังออก...' : 'ออกจากระบบ'}
        </button>
        </div>
      </header>
      {activeSubTabs.length > 0 && (
        <div
          className={`fixed top-16 right-0 z-30 border-b border-surface-200 bg-white shadow-soft transition-all duration-300 ${
            sidebarOpen ? 'left-64' : 'left-20'
          }`}
        >
          <div className="w-full px-4 sm:px-6 lg:px-8 overflow-x-auto scrollbar-thin">
            <div className="flex items-center justify-between gap-4">
              <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3" aria-label="Tabs">
                {activeSubTabs.map((tab) => {
                  const isActive = location.pathname === tab.path
                  const badge = tab.path === '/warehouse' && belowOrderPointCount > 0
                    ? belowOrderPointCount
                    : tab.path === '/warehouse/returns' && warehousePendingReturnCount > 0
                      ? warehousePendingReturnCount
                      : tab.path === '/purchase/pr' && purchaseBadge.pr_pending > 0
                        ? purchaseBadge.pr_pending
                        : tab.path === '/purchase/po' && purchaseBadge.pr_approved_no_po > 0
                          ? purchaseBadge.pr_approved_no_po
                          : tab.path === '/purchase/gr' && purchaseBadge.po_waiting_gr > 0
                            ? purchaseBadge.po_waiting_gr
                            : null
                  return (
                    <Link
                      key={tab.path}
                      to={tab.path}
                      className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap flex-shrink-0 transition-colors flex items-center gap-1.5 ${
                        isActive
                          ? 'border-blue-500 text-blue-600'
                          : 'border-transparent text-gray-500 hover:text-blue-600'
                      }`}
                    >
                      {tab.label}
                      {badge !== null && (
                        <span className="min-w-[1.4rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold bg-orange-500 text-white">
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}
                    </Link>
                  )
                })}
              </nav>
              <div className="flex items-center gap-2 flex-shrink-0">
                {showProductsSubBarCount && (
                  <div className="px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-100 text-sm text-blue-700 whitespace-nowrap">
                    สินค้าทั้งหมด <span className="font-bold tabular-nums">{menuCount?.toLocaleString()}</span> รายการ
                  </div>
                )}
              {location.pathname === '/purchase/pr' && (
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('purchase-pr-create'))}
                  className="px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold text-sm whitespace-nowrap flex-shrink-0"
                >
                  + สร้าง PR
                </button>
              )}
              {location.pathname === '/purchase/sample' && (
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('purchase-sample-create'))}
                  className="px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold text-sm whitespace-nowrap flex-shrink-0"
                >
                  + รับสินค้าตัวอย่าง
                </button>
              )}
              </div>
            </div>
          </div>
        </div>
      )}
      {canSeeChat && (
        <div className="fixed bottom-6 right-6 z-50">
          {notifyCollapsed ? (
            <button
              type="button"
              onClick={() => { setNotifyCollapsed(false); setNotifyBlinking(false) }}
              className={`group -mr-6 rounded-l-xl border border-gray-200 bg-white shadow-xl px-3 py-2.5 flex items-center gap-2 hover:bg-gray-50 transition-colors ${
                notifyBlinking ? 'animate-pulse ring-2 ring-red-300' : ''
              }`}
              title="ขยายแจ้งเตือน"
              aria-label="ขยายแจ้งเตือน"
            >
              <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              <span className="text-xs font-semibold text-gray-700 whitespace-nowrap">แจ้งเตือน</span>
              {(issueOnCount > 0 || newChatCount > 0) && (
                <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-500 text-white animate-bounce">
                  {issueOnCount + newChatCount}
                </span>
              )}
            </button>
          ) : (
            <div
              className={`w-[380px] rounded-2xl border border-gray-200 bg-white shadow-2xl overflow-hidden ${
                notifyBlinking ? 'animate-pulse ring-2 ring-red-300' : ''
              }`}
              onClick={() => setNotifyBlinking(false)}
            >
              <div className="px-3 py-2 bg-emerald-600 text-white flex items-center justify-between">
                <div className="font-bold text-base flex items-center gap-2">
                  แจ้งเตือน
                  {notifyBlinking && (
                    <span className="inline-flex w-2.5 h-2.5 rounded-full bg-red-300 animate-ping" />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => { setNotifyCollapsed(true); setNotifyBlinking(false) }}
                  className="w-7 h-7 rounded-lg bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors"
                  title="ย่อ"
                  aria-label="ย่อ"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
              <div className="p-3 space-y-2">
                <button
                  type="button"
                  onClick={() => { setNotifyBlinking(false); handleIssueClick('on') }}
                  className={`w-full flex items-center justify-between rounded-xl border border-yellow-200 bg-yellow-50 px-4 py-3 text-base hover:bg-yellow-100 transition-colors ${
                    issueOnCount > 0 ? 'ring-1 ring-yellow-300' : ''
                  }`}
                >
                  <span className="font-medium text-gray-700">New Issue</span>
                  <span className={`px-2.5 py-1 rounded-full text-sm font-bold bg-yellow-400 text-red-600 ${
                    issueOnCount > 0 ? 'animate-bounce' : ''
                  }`}>
                    {issueOnCount}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => { setNotifyBlinking(false); handleIssueClick('unread') }}
                  className={`w-full flex items-center justify-between rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-base hover:bg-orange-100 transition-colors ${
                    newChatCount > 0 ? 'ring-1 ring-orange-300' : ''
                  }`}
                >
                  <span className="font-medium text-gray-700">New Chat</span>
                  <span className={`px-2.5 py-1 rounded-full text-sm font-bold bg-orange-500 text-white ${
                    newChatCount > 0 ? 'animate-bounce' : ''
                  }`}>
                    {newChatCount}
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {MessageModal}
      {ConfirmModal}
    </>
  )
}
