import { useAuthContext } from '../../contexts/AuthContext'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useWmsModal } from '../wms/useWmsModal'

interface TopBarProps {
  sidebarOpen: boolean
  onToggleSidebar?: () => void
}

export default function TopBar({ sidebarOpen, onToggleSidebar }: TopBarProps) {
  const { user, signOut } = useAuthContext()
  const location = useLocation()
  const navigate = useNavigate()
  const [issueOnCount, setIssueOnCount] = useState(0)
  const [newChatCount, setNewChatCount] = useState(0)
  const [menuCount, setMenuCount] = useState<number | null>(null)
  const { showConfirm, ConfirmModal } = useWmsModal()

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
    if (path.startsWith('/wms')) return 'จัดสินค้า'
    if (path.startsWith('/qc')) return 'QC'
    if (path.startsWith('/packing')) return 'จัดของ'
    if (path.startsWith('/transport')) return 'ทวนสอบขนส่ง'
    if (path.startsWith('/products')) return 'สินค้า'
    if (path.startsWith('/cartoon-patterns')) return 'ลายการ์ตูน'
    if (path.startsWith('/warehouse')) return 'คลัง'
    if (path.startsWith('/purchase')) return 'สั่งซื้อ'
    if (path.startsWith('/sales-reports')) return 'รายงานยอดขาย'
    if (path.startsWith('/settings')) return 'ตั้งค่า'
    return 'เมนู'
  })()

  const handleLogout = async () => {
    const ok = await showConfirm({ title: 'ออกจากระบบ', message: 'ต้องการออกจากระบบหรือไม่?' })
    if (ok) {
      await signOut()
    }
  }

  useEffect(() => {
    const loadIssueCounts = async () => {
      try {
        const [onRes] = await Promise.all([
          supabase.from('or_issues').select('id', { count: 'exact', head: true }).eq('status', 'On'),
        ])
        setIssueOnCount(onRes.count ?? 0)
        await loadAllUnreadChatCount()
      } catch (error) {
        console.error('Error loading issue counts:', error)
      }
    }
    const loadAllUnreadChatCount = async () => {
      if (!user) return
      try {
        // === Issue Chat unread ===
        const [{ data: issueReads }, { data: issueMessages }] = await Promise.all([
          supabase.from('or_issue_reads').select('issue_id, last_read_at').eq('user_id', user.id),
          supabase.from('or_issue_messages').select('issue_id, created_at'),
        ])
        const issueReadMap = new Map(
          (issueReads || []).map((r: { issue_id: string; last_read_at: string }) => [r.issue_id, new Date(r.last_read_at).getTime()])
        )
        let issueTotal = 0
        ;(issueMessages || []).forEach((m: { issue_id: string; created_at: string }) => {
          const lastRead = issueReadMap.get(m.issue_id) ?? 0
          if (new Date(m.created_at).getTime() > lastRead) issueTotal += 1
        })

        // === Order Chat unread ===
        const [{ data: orderReads }, { data: orderMessages }] = await Promise.all([
          supabase.from('or_order_chat_reads').select('order_id, last_read_at').eq('user_id', user.id),
          supabase.from('or_order_chat_logs').select('order_id, created_at').eq('is_hidden', false),
        ])
        const orderReadMap = new Map(
          (orderReads || []).map((r: any) => [r.order_id, new Date(r.last_read_at).getTime()])
        )
        let orderTotal = 0
        ;(orderMessages || []).forEach((m: { order_id: string; created_at: string }) => {
          const lastRead = orderReadMap.get(m.order_id) ?? 0
          if (new Date(m.created_at).getTime() > lastRead) orderTotal += 1
        })

        setNewChatCount(issueTotal + orderTotal)
      } catch (error) {
        console.error('Error loading unread chat count:', error)
      }
    }
    loadIssueCounts()
    const channel = supabase
      .channel('topbar-issue-counts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_issues' }, () => loadIssueCounts())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'or_issue_messages' }, () => loadIssueCounts())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'or_order_chat_logs' }, () => loadAllUnreadChatCount())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [user])

  useEffect(() => {
    const onChatRead = () => {
      if (!user) return
      ;(async () => {
        try {
          // === Issue Chat unread ===
          const [{ data: issueReads }, { data: issueMessages }] = await Promise.all([
            supabase.from('or_issue_reads').select('issue_id, last_read_at').eq('user_id', user.id),
            supabase.from('or_issue_messages').select('issue_id, created_at'),
          ])
          const issueReadMap = new Map(
            (issueReads || []).map((r: { issue_id: string; last_read_at: string }) => [r.issue_id, new Date(r.last_read_at).getTime()])
          )
          let issueTotal = 0
          ;(issueMessages || []).forEach((m: { issue_id: string; created_at: string }) => {
            const lastRead = issueReadMap.get(m.issue_id) ?? 0
            if (new Date(m.created_at).getTime() > lastRead) issueTotal += 1
          })

          // === Order Chat unread ===
          const [{ data: orderReads }, { data: orderMessages }] = await Promise.all([
            supabase.from('or_order_chat_reads').select('order_id, last_read_at').eq('user_id', user.id),
            supabase.from('or_order_chat_logs').select('order_id, created_at').eq('is_hidden', false),
          ])
          const orderReadMap = new Map(
            (orderReads || []).map((r: any) => [r.order_id, new Date(r.last_read_at).getTime()])
          )
          let orderTotal = 0
          ;(orderMessages || []).forEach((m: { order_id: string; created_at: string }) => {
            const lastRead = orderReadMap.get(m.order_id) ?? 0
            if (new Date(m.created_at).getTime() > lastRead) orderTotal += 1
          })

          setNewChatCount(issueTotal + orderTotal)
        } catch (error) {
          console.error('Error refreshing unread chat count:', error)
        }
      })()
    }
    window.addEventListener('issue-chat-read', onChatRead)
    window.addEventListener('order-chat-read', onChatRead)
    return () => {
      window.removeEventListener('issue-chat-read', onChatRead)
      window.removeEventListener('order-chat-read', onChatRead)
    }
  }, [user])

  const issueTabs = [
    { key: 'on', label: `New Issue (${issueOnCount})` },
    { key: 'close', label: `New Chat (${newChatCount})` },
  ]

  /** Navigate to the correct Issue page based on role, then switch Issue tab (on/close) */
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
    { path: '/warehouse', label: 'คลังสินค้า' },
    { path: '/warehouse/audit', label: 'Audit' },
    { path: '/warehouse/adjust', label: 'ปรับสต๊อค' },
    { path: '/warehouse/returns', label: 'รับสินค้าตีกลับ' },
  ]

  const purchaseTabs = [
    { path: '/purchase/pr', label: 'PR (ใบขอซื้อ)' },
    { path: '/purchase/po', label: 'PO (ใบสั่งซื้อ)' },
    { path: '/purchase/gr', label: 'GR (ใบรับสินค้า)' },
  ]

  const activeSubTabs = location.pathname.startsWith('/warehouse')
    ? warehouseTabs
    : location.pathname.startsWith('/purchase')
      ? purchaseTabs
      : []

  useEffect(() => {
    const height = activeSubTabs.length > 0 ? '3rem' : '0rem'
    document.documentElement.style.setProperty('--subnav-height', height)
    return () => {
      document.documentElement.style.setProperty('--subnav-height', '0rem')
    }
  }, [activeSubTabs.length])

  return (
    <>
      <header
        className={`bg-emerald-500 text-white h-16 flex items-center justify-between px-6 border-b border-emerald-600 shadow-soft fixed top-0 right-0 z-40 transition-all duration-300 ${
          sidebarOpen ? 'left-64' : 'left-20'
        }`}
      >
        <div className="flex items-center gap-3">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="p-2 hover:bg-white/20 rounded-lg transition-colors text-white"
              title={sidebarOpen ? 'ปิดเมนู' : 'เปิดเมนู'}
              aria-label={sidebarOpen ? 'ปิดเมนู' : 'เปิดเมนู'}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          )}
          <h2 className="text-2xl font-semibold text-white">
            {menuTitle}
            {menuCount !== null && (
              <span className="ml-2 text-xl font-semibold text-emerald-100 tabular-nums">({menuCount})</span>
            )}
          </h2>
          <div className="flex items-center gap-2">
            {issueTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => handleIssueClick(tab.key)}
                className={`px-3 py-1.5 rounded-full text-sm font-semibold transition-colors shadow-sm ${
                  tab.key === 'on'
                    ? 'bg-yellow-400 text-emerald-900 hover:bg-yellow-300'
                    : 'bg-orange-500 text-white hover:bg-orange-400'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-4">
        {user && (
          <div className="text-sm text-emerald-100">
            <span className="mr-4">{user.username || user.email}</span>
            <span className="text-emerald-200">({user.role})</span>
          </div>
        )}
        <button
          onClick={handleLogout}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl transition-colors font-semibold"
        >
          ออกจากระบบ
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
                  return (
                    <Link
                      key={tab.path}
                      to={tab.path}
                      className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap flex-shrink-0 transition-colors ${
                        isActive
                          ? 'border-blue-500 text-blue-600'
                          : 'border-transparent text-gray-500 hover:text-blue-600'
                      }`}
                    >
                      {tab.label}
                    </Link>
                  )
                })}
              </nav>
              {location.pathname === '/purchase/pr' && (
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('purchase-pr-create'))}
                  className="px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold text-sm whitespace-nowrap flex-shrink-0"
                >
                  + สร้าง PR
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {ConfirmModal}
    </>
  )
}
