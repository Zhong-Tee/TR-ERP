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
  const [refreshKey, setRefreshKey] = useState(0)

  const isAdmin = isAdminOrSuperadmin(user?.role)

  // เลือก tab แรกที่มีสิทธิ์ (sales จะ land ที่ Assign เพราะไม่มีสิทธิ์ Dashboard/งานใหม่)
  useEffect(() => {
    if (hasAccess(`marketplace-${activeTab}`)) return
    const firstAccessible = MP_TABS.find((t) => hasAccess(`marketplace-${t.key}`))
    if (firstAccessible) setActiveTab(firstAccessible.key)
  }, [hasAccess, activeTab])

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
      .eq('is_active', true)
    if (!error && data) {
      setSalesUsers(
        (data as (MpSalesUser & { is_active: boolean })[])
          .filter((u) => isSalesAssignableRole(u.role))
          .sort((a, b) => (a.username || a.email).localeCompare(b.username || b.email)),
      )
    }
  }, [])

  useEffect(() => {
    loadConfigs()
    loadSalesUsers()
  }, [loadConfigs, loadSalesUsers])

  // realtime: งานเปลี่ยน (assign/เปิดบิล/รอติดตาม) → refresh list ทุก tab
  useEffect(() => {
    const channel = supabase
      .channel('mp-orders-page')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mp_orders' }, () => {
        setRefreshKey((k) => k + 1)
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const triggerRefresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  // จำนวนงานแยกตามสถานะ → แสดง badge บนแต่ละแถบย่อย + ส่งให้ TopBar
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    let cancelled = false
    async function loadCounts() {
      const statuses = ['new', 'assigned', 'follow_up', 'done', 'cancelled'] as const
      const results = await Promise.all(
        statuses.map((s) =>
          supabase.from('mp_orders').select('id', { count: 'exact', head: true }).eq('status', s),
        ),
      )
      if (cancelled) return
      const counts: Record<string, number> = {}
      statuses.forEach((s, i) => {
        counts[s] = results[i].count || 0
      })
      setTabCounts(counts)
      // TopBar: admin = งานรอมอบหมาย, sales = งานของตัวเองที่ยังไม่เสร็จ
      const topbarCount = isAdmin ? counts.new : (counts.assigned || 0) + (counts.follow_up || 0)
      window.dispatchEvent(new CustomEvent('topbar-menu-count', { detail: { count: topbarCount } }))
    }
    loadCounts()
    return () => {
      cancelled = true
    }
  }, [isAdmin, refreshKey])

  /** จำนวนที่จะแสดงบน badge ของแต่ละแถบ (Dashboard/ตั้งค่า ไม่มี) */
  const tabBadge = (key: string): number => {
    switch (key) {
      case 'new':
        return tabCounts.new || 0
      case 'assign':
        return tabCounts.assigned || 0
      case 'follow-up':
        return tabCounts.follow_up || 0
      case 'done':
        return tabCounts.done || 0
      case 'cancelled':
        return tabCounts.cancelled || 0
      default:
        return 0
    }
  }

  const visibleTabs = useMemo(
    () => MP_TABS.filter((tab) => hasAccess(`marketplace-${tab.key}`)),
    [hasAccess],
  )

  if (!user) return null

  return (
    <div className="space-y-6">
      {/* เมนูย่อย — สไตล์เดียวกับหน้า ตั้งค่า/ออเดอร์ */}
      <div className="sticky top-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6 px-6">
        <div className="w-full px-4 sm:px-6 lg:px-8 overflow-x-auto scrollbar-thin">
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

      {activeTab === 'new' && hasAccess('marketplace-new') && (
        <MarketplaceNewTab
          user={user}
          configs={configs}
          salesUsers={salesUsers}
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
          configs={configs}
          salesUsers={salesUsers}
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
          configs={configs}
          salesUsers={salesUsers}
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
          configs={configs}
          salesUsers={salesUsers}
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
          configs={configs}
          salesUsers={salesUsers}
          refreshKey={refreshKey}
          onChanged={triggerRefresh}
        />
      )}

      {activeTab === 'settings' && hasAccess('marketplace-settings') && (
        <MarketplaceSettingsTab configs={configs} onConfigsChanged={loadConfigs} />
      )}
    </div>
  )
}
