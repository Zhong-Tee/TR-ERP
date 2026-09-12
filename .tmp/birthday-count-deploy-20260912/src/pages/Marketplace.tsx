import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthContext } from '../contexts/AuthContext'
import { useMenuAccess } from '../contexts/MenuAccessContext'
import { isAdminOrSuperadmin, isSalesAssignableRole } from '../config/accessPolicy'
import type { MpChannelConfig, MpSalesUser } from '../types/marketplace'
import MarketplaceNewTab from '../components/marketplace/MarketplaceNewTab'
import MarketplaceWorkList from '../components/marketplace/MarketplaceWorkList'
import MarketplaceSettingsTab from '../components/marketplace/MarketplaceSettingsTab'
import MarketplaceDashboard from '../components/marketplace/MarketplaceDashboard'

const MP_TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'new', label: 'งานใหม่' },
  { key: 'assign', label: 'Assign' },
  { key: 'follow-up', label: 'รอติดตาม' },
  { key: 'done', label: 'เสร็จสิ้น' },
  { key: 'cancelled', label: 'ยกเลิก' },
  { key: 'settings', label: 'ตั้งค่า' },
] as const

type MpTabKey = (typeof MP_TABS)[number]['key']

export default function Marketplace() {
  const { user } = useAuthContext()
  const { hasAccess } = useMenuAccess()
  const [activeTab, setActiveTab] = useState<MpTabKey>('new')
  const [configs, setConfigs] = useState<MpChannelConfig[]>([])
  const [salesUsers, setSalesUsers] = useState<MpSalesUser[]>([])
  const [marketplaceUsers, setMarketplaceUsers] = useState<MpSalesUser[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [canAssign, setCanAssign] = useState(user?.role === 'superadmin')

  const isAdmin = isAdminOrSuperadmin(user?.role)

  const canAccessTab = useCallback(
    (tabKey: MpTabKey) => tabKey === 'new' ? canAssign || hasAccess('marketplace-new') : hasAccess(`marketplace-${tabKey}`),
    [canAssign, hasAccess],
  )

  const loadAssignPermission = useCallback(async () => {
    if (!user) {
      return
    }
    if (user.role === 'superadmin') {
      return
    }
    const { data, error } = await supabase.rpc('mp_can_assign_orders')
    setCanAssign(!error && data === true)
  }, [user])

  useEffect(() => {
    // โหลดสิทธิ์จากฐานข้อมูลเมื่อผู้ใช้เปลี่ยน (setState เกิดหลัง RPC ตอบกลับ)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAssignPermission()
  }, [loadAssignPermission])

  // เลือก tab แรกที่มีสิทธิ์ (sales จะ land ที่ Assign เพราะไม่มีสิทธิ์ Dashboard/งานใหม่)
  useEffect(() => {
    if (canAccessTab(activeTab)) return
    const firstAccessible = MP_TABS.find((t) => canAccessTab(t.key))
    if (firstAccessible) setActiveTab(firstAccessible.key)
  }, [canAccessTab, activeTab])

  const loadConfigs = useCallback(async () => {
    const { data, error } = await supabase
      .from('mp_channel_configs')
      .select('*')
      .order('created_at', { ascending: true })
    if (!error && data) setConfigs(data as MpChannelConfig[])
  }, [])

  const loadSalesUsers = useCallback(async () => {
    const { data, error } = await supabase
      .from('us_users')
      .select('id, username, email, role, is_active')
    if (!error && data) {
      const users = data as (MpSalesUser & { is_active: boolean })[]
      setMarketplaceUsers(users)
      setSalesUsers(
        users
          .filter((u) => u.is_active && isSalesAssignableRole(u.role))
          .sort((a, b) => (a.username || a.email).localeCompare(b.username || b.email)),
      )
    }
  }, [])

  useEffect(() => {
    loadConfigs()
    loadSalesUsers()
  }, [loadConfigs, loadSalesUsers])

  // Realtime is useful only for active work queues. History/settings pages are
  // refreshed when opened, so keeping another subscription there only duplicates
  // the global Sidebar subscription and wastes Realtime messages.
  useEffect(() => {
    if (!['new', 'assign', 'follow-up'].includes(activeTab)) return

    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const channel = supabase
      .channel('mp-orders-page')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mp_orders' }, () => {
        // One import/assign action can emit many events. Refresh once after the
        // burst instead of querying the list and all badges for every row.
        if (document.visibilityState !== 'visible') return
        if (refreshTimer) clearTimeout(refreshTimer)
        refreshTimer = setTimeout(() => setRefreshKey((k) => k + 1), 750)
      })
      .subscribe()
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      supabase.removeChannel(channel)
    }
  }, [activeTab])

  const triggerRefresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  // จำนวนงานแยกตามสถานะ → แสดง badge บนแต่ละแถบย่อย + ส่งให้ TopBar
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    let cancelled = false
    async function loadCounts() {
      // The completed tab intentionally has no badge, so do not spend a count
      // query on the largest/history status.
      const statuses = ['new', 'assigned', 'follow_up', 'cancelled'] as const
      const [results, ownAssignedResult] = await Promise.all([
        Promise.all(
          statuses.map((s) =>
            supabase.from('mp_orders').select('id', { count: 'exact', head: true }).eq('status', s),
          ),
        ),
        supabase
          .from('mp_orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'assigned')
          .eq('assigned_to', user?.id || ''),
      ])
      if (cancelled) return
      const counts: Record<string, number> = {}
      statuses.forEach((s, i) => {
        counts[s] = results[i].count || 0
      })
      counts.assigned_own = ownAssignedResult.count || 0
      setTabCounts(counts)
      // TopBar: admin = งานรอมอบหมาย, sales = งานของตัวเองที่ยังไม่เสร็จ
      const topbarCount = isAdmin ? counts.new : (counts.assigned || 0) + (counts.follow_up || 0)
      window.dispatchEvent(new CustomEvent('topbar-menu-count', { detail: { count: topbarCount } }))
    }
    loadCounts()
    return () => {
      cancelled = true
    }
  }, [isAdmin, refreshKey, user?.id])

  /** จำนวนที่จะแสดงบน badge ของแต่ละแถบ (Dashboard/ตั้งค่า ไม่มี) */
  const tabBadge = (key: string): number => {
    switch (key) {
      case 'new':
        return tabCounts.new || 0
      case 'assign':
        return tabCounts.assigned_own || 0
      case 'follow-up':
        return tabCounts.follow_up || 0
      case 'cancelled':
        return tabCounts.cancelled || 0
      default:
        return 0
    }
  }

  // Events received while the browser was hidden are deliberately ignored.
  // Refresh once when the operator returns instead of consuming every event.
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        setRefreshKey((k) => k + 1)
      }
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => document.removeEventListener('visibilitychange', refreshWhenVisible)
  }, [])

  const visibleTabs = useMemo(
    () => MP_TABS.filter((tab) => canAccessTab(tab.key)),
    [canAccessTab],
  )

  if (!user) return null

  return (
    <div className="space-y-6">
      {/* เมนูย่อย — สไตล์เดียวกับหน้า ตั้งค่า/ออเดอร์ */}
      <div className="sticky top-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6">
        <div className="w-full overflow-x-auto px-2 scrollbar-thin sm:px-4 md:px-6 lg:px-8">
          <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3" aria-label="Tabs">
            {visibleTabs.map((tab) => {
              const badge = tabBadge(tab.key)
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap flex-shrink-0 transition-colors flex items-center gap-1.5 ${
                    activeTab === tab.key
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-blue-600'
                  }`}
                >
                  {tab.label}
                  {badge > 0 && (
                    <span className="min-w-[1.4rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold bg-orange-500 text-white">
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>
        </div>
      </div>

      {activeTab === 'dashboard' && hasAccess('marketplace-dashboard') && (
        <MarketplaceDashboard salesUsers={salesUsers} refreshKey={refreshKey} />
      )}

      {activeTab === 'new' && canAccessTab('new') && (
        <MarketplaceNewTab
          user={user}
          configs={configs}
          salesUsers={salesUsers}
          canAssign={canAssign}
          refreshKey={refreshKey}
          onChanged={triggerRefresh}
        />
      )}

      {activeTab === 'assign' && hasAccess('marketplace-assign') && (
        <MarketplaceWorkList
          key="assigned"
          status="assigned"
          user={user}
          isAdmin={isAdmin}
          canAssign={canAssign}
          configs={configs}
          salesUsers={salesUsers}
          users={marketplaceUsers}
          refreshKey={refreshKey}
          onChanged={triggerRefresh}
        />
      )}

      {activeTab === 'follow-up' && hasAccess('marketplace-follow-up') && (
        <MarketplaceWorkList
          key="follow_up"
          status="follow_up"
          user={user}
          isAdmin={isAdmin}
          canAssign={canAssign}
          configs={configs}
          salesUsers={salesUsers}
          users={marketplaceUsers}
          refreshKey={refreshKey}
          onChanged={triggerRefresh}
        />
      )}

      {activeTab === 'done' && hasAccess('marketplace-done') && (
        <MarketplaceWorkList
          key="done"
          status="done"
          user={user}
          isAdmin={isAdmin}
          canAssign={canAssign}
          configs={configs}
          salesUsers={salesUsers}
          users={marketplaceUsers}
          refreshKey={refreshKey}
          onChanged={triggerRefresh}
        />
      )}

      {activeTab === 'cancelled' && hasAccess('marketplace-cancelled') && (
        <MarketplaceWorkList
          key="cancelled"
          status="cancelled"
          user={user}
          isAdmin={isAdmin}
          canAssign={canAssign}
          configs={configs}
          salesUsers={salesUsers}
          users={marketplaceUsers}
          refreshKey={refreshKey}
          onChanged={triggerRefresh}
        />
      )}

      {activeTab === 'settings' && hasAccess('marketplace-settings') && (
        <MarketplaceSettingsTab
          user={user}
          configs={configs}
          onConfigsChanged={loadConfigs}
          onAssignersChanged={loadAssignPermission}
        />
      )}
    </div>
  )
}
