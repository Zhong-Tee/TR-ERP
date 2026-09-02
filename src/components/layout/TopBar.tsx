import { useAuthContext } from '../../contexts/AuthContext'
import { useMenuAccess } from '../../contexts/MenuAccessContext'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useWmsModal } from '../wms/useWmsModal'
import { canClearAllChats, canUseIssueChat, isOperationalIssueRole, resolveMenuKeyFromPath } from '../../config/accessPolicy'
import { dispatchIssueOnCount } from '../../lib/issueOnCountBroadcast'
import { broadcastHrMyOpenTaskCount, loadHrMyOpenTaskCount } from '../../lib/hrTaskBadge'
import ModeSwitchButton from '../ModeSwitchButton'

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
  const [purchaseBadge, setPurchaseBadge] = useState<{ pr_pending: number; pr_approved_no_po: number; po_waiting_gr: number; machinery_pending?: number }>({ pr_pending: 0, pr_approved_no_po: 0, po_waiting_gr: 0, machinery_pending: 0 })
  const [sampleAttentionCount, setSampleAttentionCount] = useState(0)
  // Badge เมนู HR: จำนวนใบลา + คำขอ OT + คำขอ WFH ที่รออนุมัติ (เรียลไทม์)
  const [hrLeavePending, setHrLeavePending] = useState(0)
  const [hrOtPending, setHrOtPending] = useState(0)
  const [hrWfhPending, setHrWfhPending] = useState(0)
  /** ประกาศที่ต้องดำเนินการ: รออนุมัติ + เผยแพร่แล้วแต่พนักงานรับทราบไม่ครบ */
  const [hrAnnouncementAttention, setHrAnnouncementAttention] = useState(0)
  /** คำร้องใหม่ที่ HR ยังไม่ได้กดรับเรื่อง */
  const [hrRequestPending, setHrRequestPending] = useState(0)
  /** คำทักท้วงคะแนนที่ HR ยังไม่ได้ตัดสิน */
  const [hrScoreAppealPending, setHrScoreAppealPending] = useState(0)
  /** งานที่ผู้ใช้ปัจจุบันเป็นผู้รับผิดชอบและยังไม่เสร็จ */
  const [hrMyOpenTaskCount, setHrMyOpenTaskCount] = useState(0)
  const [notifyCollapsed, setNotifyCollapsed] = useState(true)
  const [notifyBlinking, setNotifyBlinking] = useState(false)
  /** ตำแหน่งแนวตั้งของป้ายแจ้งเตือน (px จากขอบล่าง) — ลากขึ้น/ลงได้ จำค่าไว้ใน localStorage */
  const [notifyBottom, setNotifyBottom] = useState<number>(() => {
    const saved = Number(localStorage.getItem('notify-widget-bottom'))
    return Number.isFinite(saved) && saved >= 8 ? saved : 24
  })
  const notifyDragRef = useRef<{ pointerId: number; startY: number; startBottom: number; lastBottom: number; moved: boolean } | null>(null)
  /** กันไม่ให้ click (เปิด/ปิดป้าย) ทำงานทันทีหลังปล่อยจากการลาก */
  const notifySuppressClickRef = useRef(false)

  function onNotifyDragPointerDown(e: React.PointerEvent<HTMLElement>) {
    // ถ้ากดลงบนปุ่มลูกข้างใน (เช่น ปุ่มย่อ) ไม่เริ่มลาก — ให้ click ของปุ่มนั้นทำงานตามปกติ
    const targetButton = (e.target as HTMLElement).closest('button')
    if (targetButton && targetButton !== e.currentTarget) return
    notifyDragRef.current = { pointerId: e.pointerId, startY: e.clientY, startBottom: notifyBottom, lastBottom: notifyBottom, moved: false }
  }
  function onNotifyDragPointerMove(e: React.PointerEvent<HTMLElement>) {
    const d = notifyDragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const dy = d.startY - e.clientY // ลากขึ้น = ค่า bottom เพิ่ม
    if (!d.moved && Math.abs(dy) < 5) return // ขยับน้อยกว่า 5px ถือว่าเป็นคลิก
    if (!d.moved) {
      d.moved = true
      // จับ pointer เมื่อเริ่มลากจริงเท่านั้น — จับตั้งแต่ pointerdown จะทำให้ click ของปุ่มลูกไม่ทำงาน
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    const maxBottom = Math.max(8, window.innerHeight - 120) // กันลากหลุดขอบบน
    const next = Math.min(Math.max(8, d.startBottom + dy), maxBottom)
    d.lastBottom = next
    setNotifyBottom(next)
  }
  function onNotifyDragPointerUp(e: React.PointerEvent<HTMLElement>) {
    const d = notifyDragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    notifyDragRef.current = null
    if (d.moved) {
      notifySuppressClickRef.current = true
      localStorage.setItem('notify-widget-bottom', String(Math.round(d.lastBottom)))
    }
  }
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
    if (path.startsWith('/marketplace')) return 'Marketplace'
    if (path.startsWith('/orders')) return 'ออเดอร์'
    if (path.startsWith('/admin-qc')) return 'รอตรวจคำสั่งซื้อ'
    if (path.startsWith('/account')) return 'บัญชี'
    if (path.startsWith('/export')) return 'ใบงาน'
    if (path.startsWith('/plan')) return 'Plan'
    if (path.startsWith('/machinery')) return 'Machinery'
    if (path.startsWith('/wms')) return 'จัดสินค้า'
    if (path.startsWith('/qc')) return 'QC Operation'
    if (path.startsWith('/packing')) return 'แพ็คสินค้า'
    if (path.startsWith('/transport')) return 'ทวนสอบขนส่ง'
    if (path.startsWith('/products')) return 'สินค้า'
    if (path.startsWith('/cartoon-patterns')) return 'ลายการ์ตูน'
    if (path.startsWith('/warehouse')) return 'คลัง'
    if (path.startsWith('/purchase')) return 'สั่งซื้อ'
    if (path.startsWith('/sales-reports')) return 'รายงานยอดขาย'
    if (path.startsWith('/kpi')) return 'KPI'
    if (path.startsWith('/hr')) return 'HR'
    if (path.startsWith('/knowledge-hub')) return 'Knowledge Hub'
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_issue_messages' }, (payload) => {
        const sid = (payload.new as { sender_id?: string })?.sender_id
        if (user?.id && sid === user.id) return
        debouncedLoadChatCounts()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_order_chat_logs' }, (payload) => {
        const sid = (payload.new as { sender_id?: string })?.sender_id
        if (user?.id && sid === user.id) return
        debouncedLoadChatCounts()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_issue_reads' }, () => debouncedLoadChatCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_order_chat_reads' }, () => debouncedLoadChatCounts())
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') loadChatCounts()
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn(`TopBar issue counts realtime: ${status}`)
        }
      })

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') loadChatCounts()
    }
    const fallbackInterval = window.setInterval(refreshWhenVisible, 15_000)
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(fallbackInterval)
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
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
    const targetPath = isOperationalIssueRole(user?.role) ? '/plan' : '/orders'

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
    { path: '/warehouse/inventory-history', label: 'รายการสินค้าคงเหลือ' },
  ].filter((tab) => {
    const menuKey = resolveMenuKeyFromPath(tab.path)
    return menuKey ? hasAccess(menuKey) : false
  })

  const purchaseTabs = [
    { path: '/purchase/requests', label: 'คำขอซื้อ' },
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
    { path: '/products/information', label: 'ข้อมูลสินค้า' },
    { path: '/products/inactive', label: 'รายการสินค้าไม่เคลื่อนไหว' },
  ].filter((tab) => {
    const menuKey = resolveMenuKeyFromPath(tab.path)
    return menuKey ? hasAccess(menuKey) : false
  })

  const hrTabOrder = [
    '/hr', '/hr/tasks', '/hr/leave', '/hr/attendance', '/hr/work-calendar',
    '/hr/announcements', '/hr/work-score', '/hr/requests', '/hr/warnings', '/hr/certificates',
    '/hr/interview', '/hr/onboarding', '/hr/assets',
    '/hr/contracts', '/hr/documents', '/hr/salary', '/hr/settings',
  ]
  const hrTabs = [
    { path: '/hr', label: 'ทะเบียนพนักงาน' },
    { path: '/hr/tasks', label: 'งาน' },
    { path: '/hr/requests', label: 'คำร้อง' },
    { path: '/hr/leave', label: 'ลางาน/OT/WFH' },
    { path: '/hr/interview', label: 'นัดสัมภาษณ์' },
    { path: '/hr/attendance', label: 'เวลาทำงาน' },
    { path: '/hr/work-score', label: 'คะแนนปฏิบัติงาน' },
    { path: '/hr/work-calendar', label: 'ตารางวันทำงาน/วันหยุด' },
    { path: '/hr/contracts', label: 'สัญญาจ้าง' },
    { path: '/hr/documents', label: 'กฏระเบียบ/SOP' },
    { path: '/hr/onboarding', label: 'รับพนักงานใหม่' },
    { path: '/hr/salary', label: 'เส้นทางเงินเดือน' },
    { path: '/hr/announcements', label: 'ประกาศ' },
    { path: '/hr/warnings', label: 'ใบเตือน' },
    { path: '/hr/certificates', label: 'ใบรับรอง' },
    { path: '/hr/assets', label: 'ทะเบียนทรัพย์สิน' },
    { path: '/hr/settings', label: 'ตั้งค่า' },
  ].sort((a, b) => hrTabOrder.indexOf(a.path) - hrTabOrder.indexOf(b.path)).filter((tab) => {
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

  // จำนวน Sample ที่ยังอยู่ในขั้นตอนรับเข้า/รับแล้ว/กำลังทดสอบ แสดงข้างเมนูสินค้าตัวอย่าง
  useEffect(() => {
    const loadSampleAttentionCount = async () => {
      const { count, error } = await supabase
        .from('inv_samples')
        .select('*', { count: 'exact', head: true })
        .in('status', ['pending_receipt', 'received', 'testing'])
      if (error) {
        console.error('Error loading sample badge count:', error)
        return
      }
      setSampleAttentionCount(count || 0)
    }

    void loadSampleAttentionCount()
    window.addEventListener('purchase-samples-changed', loadSampleAttentionCount)
    const channel = supabase
      .channel('topbar-sample-attention-count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inv_samples' }, loadSampleAttentionCount)
      .subscribe()
    return () => {
      window.removeEventListener('purchase-samples-changed', loadSampleAttentionCount)
      void supabase.removeChannel(channel)
    }
  }, [])

  // จองพื้นที่เท่าความสูงจริงของแถบเมนูย่อย — เมนูยาวจนมี scrollbar แนวนอน (เช่น HR) จะสูงกว่า 4.5rem
  const subnavRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = subnavRef.current
    if (activeSubTabs.length === 0 || !el) {
      document.documentElement.style.setProperty('--subnav-height', '0rem')
      return
    }
    const update = () =>
      document.documentElement.style.setProperty('--subnav-height', `${el.offsetHeight}px`)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      ro.disconnect()
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

  // Badge เมนู HR "ลางาน/OT/WFH": จำนวนคำขอที่รออนุมัติ (เรียลไทม์)
  const canSeeHrLeave = hasAccess('hr-leave')
  useEffect(() => {
    if (!canSeeHrLeave) return
    const loadHrPending = async () => {
      try {
        const [leaveRes, otRes, wfhRes] = await Promise.all([
          supabase.from('hr_leave_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
          supabase.from('hr_ot_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
          supabase.from('hr_wfh_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        ])
        setHrLeavePending(leaveRes.count || 0)
        setHrOtPending(otRes.count || 0)
        setHrWfhPending(wfhRes.count || 0)
      } catch (error) {
        console.error('Error loading HR pending count:', error)
      }
    }

    loadHrPending()
    // อัปเดตทันทีเมื่อหน้า HR แจ้ง (ยื่น/อนุมัติ/ปฏิเสธ) — ไม่ต้องรอ realtime
    window.addEventListener('hr-counts-changed', loadHrPending)
    const channel = supabase
      .channel('topbar-hr-pending-count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_leave_requests' }, loadHrPending)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_ot_requests' }, loadHrPending)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_wfh_requests' }, loadHrPending)
      .subscribe()

    return () => {
      window.removeEventListener('hr-counts-changed', loadHrPending)
      supabase.removeChannel(channel)
    }
  }, [canSeeHrLeave])

  // Badge เมนู HR "คะแนนปฏิบัติงาน": คำทักท้วงรอตรวจสอบ (เรียลไทม์ทุกหน้า)
  const canSeeHrWorkScore = hasAccess('hr-work-score')
  useEffect(() => {
    if (!canSeeHrWorkScore) return
    const loadScoreAppealPending = async () => {
      try {
        const { count, error } = await supabase.from('hr_score_appeals')
          .select('*', { count: 'exact', head: true }).eq('status', 'pending')
        if (error) throw error
        setHrScoreAppealPending(count || 0)
      } catch (error) {
        console.error('Error loading score appeal badge count:', error)
      }
    }
    void loadScoreAppealPending()
    window.addEventListener('hr-score-appeals-changed', loadScoreAppealPending)
    const channel = supabase.channel('topbar-hr-score-appeal-count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_score_appeals' }, loadScoreAppealPending)
      .subscribe()
    return () => {
      window.removeEventListener('hr-score-appeals-changed', loadScoreAppealPending)
      void supabase.removeChannel(channel)
    }
  }, [canSeeHrWorkScore])

  // Badge เมนู HR "งาน": งานของฉันที่ยังดำเนินการอยู่ (ใช้ได้ทั้งหน้า HR และหน้าอื่น)
  const canSeeHrTasks = hasAccess('hr-tasks')
  useEffect(() => {
    if (!canSeeHrTasks || !user?.id) {
      setHrMyOpenTaskCount(0)
      broadcastHrMyOpenTaskCount(0)
      return
    }
    const loadMyOpenTasks = async () => {
      try {
        const count = await loadHrMyOpenTaskCount(user.id)
        setHrMyOpenTaskCount(count)
        broadcastHrMyOpenTaskCount(count)
      } catch (error) {
        console.error('Error loading my task badge count:', error)
      }
    }
    void loadMyOpenTasks()
    window.addEventListener('hr-tasks-changed', loadMyOpenTasks)
    const channel = supabase.channel(`topbar-my-task-count-${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_tasks' }, loadMyOpenTasks)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_notifications' }, loadMyOpenTasks)
      .subscribe()
    return () => {
      window.removeEventListener('hr-tasks-changed', loadMyOpenTasks)
      void supabase.removeChannel(channel)
    }
  }, [canSeeHrTasks, user?.id])

  // Badge เมนู HR "ประกาศ": ประกาศรออนุมัติ + ประกาศที่เผยแพร่แล้วแต่รับทราบไม่ครบ (เรียลไทม์)
  const canSeeHrAnnouncements = hasAccess('hr-announcements')
  useEffect(() => {
    if (!canSeeHrAnnouncements) return
    // เรียก rpc ตรง ๆ แทน import จาก hrApi — TopBar โหลดทุกหน้า ไม่ควรดึงโมดูล HR ทั้งก้อนเข้า bundle หลัก
    const loadAnnouncementAttention = async () => {
      try {
        const { data, error } = await supabase.rpc('get_announcement_attention_count')
        if (error) throw error
        setHrAnnouncementAttention(Number(data ?? 0))
      } catch (error) {
        console.error('Error loading announcement badge count:', error)
      }
    }

    loadAnnouncementAttention()
    window.addEventListener('hr-counts-changed', loadAnnouncementAttention)
    const channel = supabase
      .channel('topbar-hr-announcement-count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_announcements' }, loadAnnouncementAttention)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_announcement_reads' }, loadAnnouncementAttention)
      .subscribe()

    return () => {
      window.removeEventListener('hr-counts-changed', loadAnnouncementAttention)
      supabase.removeChannel(channel)
    }
  }, [canSeeHrAnnouncements])

  // Badge เมนู HR "คำร้อง": นับเฉพาะเรื่องใหม่ที่ยังไม่ได้รับเรื่อง
  const canSeeHrRequests = hasAccess('hr-requests')
  useEffect(() => {
    if (!canSeeHrRequests) return
    const loadRequestPending = async () => {
      try {
        const { count, error } = await supabase
          .from('hr_requests')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'submitted')
        if (error) throw error
        setHrRequestPending(count || 0)
      } catch (error) {
        console.error('Error loading HR request badge count:', error)
      }
    }

    loadRequestPending()
    window.addEventListener('hr-requests-changed', loadRequestPending)
    const channel = supabase
      .channel('topbar-hr-request-count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hr_requests' }, loadRequestPending)
      .subscribe()

    return () => {
      window.removeEventListener('hr-requests-changed', loadRequestPending)
      supabase.removeChannel(channel)
    }
  }, [canSeeHrRequests])

  return (
    <>
      <header
        className="relative z-40 flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-2 text-slate-900 shadow-sm sm:px-4 md:h-16 md:px-6"
      >
        <div className="flex min-w-0 items-center gap-1 sm:gap-3">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="shrink-0 p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-700"
              title={sidebarOpen ? 'ปิดเมนู' : 'เปิดเมนู'}
              aria-label={sidebarOpen ? 'ปิดเมนู' : 'เปิดเมนู'}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          )}
          <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight text-slate-900 sm:text-xl md:text-2xl">
            {menuTitle}
            {menuCount !== null && !location.pathname.startsWith('/products') && (
              <span className="ml-1 text-base font-semibold text-slate-500 tabular-nums md:ml-2 md:text-xl">({menuCount})</span>
            )}
          </h2>
          <div className="hidden items-center gap-2 sm:flex">
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

        <div className="flex shrink-0 items-center gap-1 sm:gap-2 lg:gap-4">
        {user && (
          <div className="hidden text-sm text-slate-600 lg:block">
            <span className="mr-4">{user.username || user.email}</span>
            <span className="text-slate-400">({user.role})</span>
          </div>
        )}
        <ModeSwitchButton className="w-10 h-10 flex items-center justify-center bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 rounded-xl transition-colors" />
        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className="hidden px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl transition-colors font-semibold disabled:opacity-50 sm:block"
        >
          {loggingOut ? 'กำลังออก...' : 'ออกจากระบบ'}
        </button>
        </div>
      </header>
      {activeSubTabs.length > 0 && (
        <div
          ref={subnavRef}
          data-app-subnav
          className="relative z-30 shrink-0 border-b border-surface-200 bg-white shadow-soft"
        >
          <div className="app-subnav-scrollbar w-full overflow-x-auto px-2 sm:px-4 md:px-6 lg:px-8">
            <div className="flex items-center justify-between gap-4">
              <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3" aria-label="Tabs">
                {activeSubTabs.map((tab) => {
                  const isActive = location.pathname === tab.path
                  const badge = tab.path === '/warehouse' && belowOrderPointCount > 0
                    ? belowOrderPointCount
                    : tab.path === '/warehouse/returns' && warehousePendingReturnCount > 0
                      ? warehousePendingReturnCount
                      : tab.path === '/purchase/requests' && (purchaseBadge.machinery_pending || 0) > 0
                        ? purchaseBadge.machinery_pending || 0
                      : tab.path === '/purchase/pr' && purchaseBadge.pr_pending > 0
                        ? purchaseBadge.pr_pending
                        : tab.path === '/purchase/po' && purchaseBadge.pr_approved_no_po > 0
                          ? purchaseBadge.pr_approved_no_po
                          : tab.path === '/purchase/gr' && purchaseBadge.po_waiting_gr > 0
                            ? purchaseBadge.po_waiting_gr
                            : tab.path === '/purchase/sample' && sampleAttentionCount > 0
                              ? sampleAttentionCount
                            : tab.path === '/hr/leave' && (hrLeavePending + hrOtPending + hrWfhPending) > 0
                              ? hrLeavePending + hrOtPending + hrWfhPending
                              : tab.path === '/hr/tasks' && hrMyOpenTaskCount > 0
                                ? hrMyOpenTaskCount
                              : tab.path === '/hr/announcements' && hrAnnouncementAttention > 0
                                ? hrAnnouncementAttention
                                : tab.path === '/hr/requests' && hrRequestPending > 0
                                  ? hrRequestPending
                                  : tab.path === '/hr/work-score' && hrScoreAppealPending > 0
                                    ? hrScoreAppealPending
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
        <div className="fixed right-6 z-50" style={{ bottom: notifyBottom }}>
          {notifyCollapsed ? (
            <button
              type="button"
              onClick={() => {
                if (notifySuppressClickRef.current) { notifySuppressClickRef.current = false; return }
                setNotifyCollapsed(false); setNotifyBlinking(false)
              }}
              onPointerDown={onNotifyDragPointerDown}
              onPointerMove={onNotifyDragPointerMove}
              onPointerUp={onNotifyDragPointerUp}
              onPointerCancel={onNotifyDragPointerUp}
              className={`group -mr-6 rounded-l-xl border border-gray-200 bg-white shadow-xl px-3 py-2.5 flex items-center gap-2 hover:bg-gray-50 transition-colors touch-none cursor-grab active:cursor-grabbing ${
                notifyBlinking ? 'animate-pulse ring-2 ring-red-300' : ''
              }`}
              title="ขยายแจ้งเตือน (ลากขึ้น/ลงเพื่อย้ายตำแหน่ง)"
              aria-label="ขยายแจ้งเตือน"
            >
              <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
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
              <div
                className="px-3 py-2 bg-emerald-600 text-white flex items-center justify-between touch-none cursor-grab active:cursor-grabbing"
                onPointerDown={onNotifyDragPointerDown}
                onPointerMove={onNotifyDragPointerMove}
                onPointerUp={onNotifyDragPointerUp}
                onPointerCancel={onNotifyDragPointerUp}
                title="ลากขึ้น/ลงเพื่อย้ายตำแหน่ง"
              >
                <div className="font-bold text-base flex items-center gap-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                  แจ้งเตือน
                  {notifyBlinking && (
                    <span className="inline-flex w-2.5 h-2.5 rounded-full bg-red-300 animate-ping" />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (notifySuppressClickRef.current) { notifySuppressClickRef.current = false; return }
                    setNotifyCollapsed(true); setNotifyBlinking(false)
                  }}
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
