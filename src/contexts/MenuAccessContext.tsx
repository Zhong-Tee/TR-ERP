import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthContext } from './AuthContext'
import { getMenuAccessCandidates, isDesktopDbManagedRole, isSuperadmin, normalizeRole } from '../config/accessPolicy'
import { wmsStoreBackupMenuDecision } from '../lib/wmsStoreBackup'

interface MenuAccessContextType {
  /** Raw map from DB. */
  menuAccess: Record<string, boolean> | null
  /** true while loading menu access from DB */
  menuAccessLoading: boolean
  /** Check if a menu key is accessible. */
  hasAccess: (menuKey: string) => boolean
  /** Force reload from DB (e.g. after saving role settings) */
  refreshMenuAccess: () => void
}

const MenuAccessContext = createContext<MenuAccessContextType | undefined>(undefined)

export function MenuAccessProvider({ children }: { children: ReactNode }) {
  const { user } = useAuthContext()
  const [accessMap, setAccessMap] = useState<Record<string, boolean> | null>(null)
  const [isWmsStoreBackup, setIsWmsStoreBackup] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const userAccessKey = `${user?.id || ''}:${user?.role || ''}`
  const [prevUserAccessKey, setPrevUserAccessKey] = useState(userAccessKey)

  // Synchronously reset loaded state when role changes so consumers
  // (SmartRedirect, ProtectedRoute) never see stale menuAccess data.
  if (prevUserAccessKey !== userAccessKey) {
    setPrevUserAccessKey(userAccessKey)
    setLoaded(false)
    setAccessMap(null)
    setIsWmsStoreBackup(false)
  }

  const fetchAndApply = useCallback(async (showLoading: boolean) => {
    if (!user?.role) {
      setAccessMap(null)
      setIsWmsStoreBackup(false)
      setLoaded(true)
      return
    }
    if (isSuperadmin(user.role)) {
      setAccessMap(null)
      setIsWmsStoreBackup(false)
      setLoaded(true)
      return
    }
    if (!isDesktopDbManagedRole(user.role)) {
      setAccessMap(null)
      setIsWmsStoreBackup(false)
      setLoaded(true)
      return
    }
    if (showLoading) setLoaded(false)
    try {
      const [menuResult, backupResult] = await Promise.all([
        supabase
          .from('st_user_menus')
          .select('menu_key, has_access')
          .eq('role', normalizeRole(user.role)),
        supabase.rpc('is_current_wms_store_backup'),
      ])
      const { data, error } = menuResult
      if (backupResult.error) {
        console.error('WMS Store backup access load error:', backupResult.error)
        setIsWmsStoreBackup(false)
      } else {
        setIsWmsStoreBackup(backupResult.data === true)
      }
      if (error) {
        console.error('MenuAccess load error:', error)
        if (showLoading) setLoaded(true)
        return
      }
      if (!data || data.length === 0) {
        setAccessMap({})
      } else {
        const map: Record<string, boolean> = {}
        data.forEach((row: { menu_key: string; has_access: boolean }) => {
          map[row.menu_key] = row.has_access
        })
        setAccessMap(map)
      }
    } catch (e) {
      console.error('MenuAccess load error:', e)
    } finally {
      setLoaded(true)
    }
  }, [user?.id, user?.role])

  useEffect(() => {
    fetchAndApply(true)
  }, [fetchAndApply])

  const refreshMenuAccess = useCallback(() => fetchAndApply(false), [fetchAndApply])

  useEffect(() => {
    if (!user?.role) return
    if (isSuperadmin(user.role)) return
    if (!isDesktopDbManagedRole(user.role)) return
    const role = normalizeRole(user.role)
    const channel = supabase
      .channel(`menu-access-${role}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'st_user_menus', filter: `role=eq.${role}` },
        () => {
          fetchAndApply(false)
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [user?.role, fetchAndApply])

  // สิทธิ์มีวันเริ่ม/หมดอายุ จึงตรวจซ้ำแม้ไม่มีการแก้แถวในฐานข้อมูล
  useEffect(() => {
    if (!user?.id || isSuperadmin(user.role)) return
    const timer = window.setInterval(() => fetchAndApply(false), 60_000)
    const channel = supabase
      .channel(`wms-store-backup-${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'wms_store_backup_assignments', filter: `user_id=eq.${user.id}` },
        () => fetchAndApply(false),
      )
      .subscribe()
    return () => {
      window.clearInterval(timer)
      supabase.removeChannel(channel)
    }
  }, [user?.id, user?.role, fetchAndApply])

  const hasAccess = useCallback(
    (menuKey: string): boolean => {
      if (isSuperadmin(user?.role)) return true
      if (!isDesktopDbManagedRole(user?.role)) return false
      if (isWmsStoreBackup) {
        const backupDecision = wmsStoreBackupMenuDecision(menuKey)
        if (backupDecision !== null) return backupDecision
      }
      if (accessMap === null) return false
      const candidates = getMenuAccessCandidates(menuKey)
      for (const candidate of candidates) {
        if (candidate in accessMap) {
          return accessMap[candidate] === true
        }
      }
      return false
    },
    [accessMap, isWmsStoreBackup, user?.role],
  )

  return (
    <MenuAccessContext.Provider value={{ menuAccess: accessMap, menuAccessLoading: !loaded, hasAccess, refreshMenuAccess }}>
      {children}
    </MenuAccessContext.Provider>
  )
}

export function useMenuAccess() {
  const context = useContext(MenuAccessContext)
  if (context === undefined) {
    throw new Error('useMenuAccess must be used within a MenuAccessProvider')
  }
  return context
}
