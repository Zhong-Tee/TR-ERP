import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthContext } from './AuthContext'

interface MenuAccessContextType {
  /** Raw map from DB — null = role has no config yet */
  menuAccess: Record<string, boolean> | null
  /** true while loading menu access from DB */
  menuAccessLoading: boolean
  /** Check if a menu key is accessible. Returns true only when no DB config exists (fallback). */
  hasAccess: (menuKey: string) => boolean
  /** Force reload from DB (e.g. after saving role settings) */
  refreshMenuAccess: () => void
}

const MenuAccessContext = createContext<MenuAccessContextType | undefined>(undefined)

export function MenuAccessProvider({ children }: { children: ReactNode }) {
  const { user } = useAuthContext()
  const [accessMap, setAccessMap] = useState<Record<string, boolean> | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [prevRole, setPrevRole] = useState<string | undefined>(user?.role)

  // Synchronously reset loaded state when role changes so consumers
  // (SmartRedirect, ProtectedRoute) never see stale menuAccess data.
  if (prevRole !== user?.role) {
    setPrevRole(user?.role)
    setLoaded(false)
    setAccessMap(null)
  }

  const fetchAndApply = useCallback(async (showLoading: boolean) => {
    if (!user?.role) {
      setAccessMap(null)
      setLoaded(true)
      return
    }
    if (showLoading) setLoaded(false)
    try {
      const { data, error } = await supabase
        .from('st_user_menus')
        .select('menu_key, has_access')
        .eq('role', user.role)
      if (error) {
        console.error('MenuAccess load error:', error)
        if (showLoading) setLoaded(true)
        return
      }
      if (!data || data.length === 0) {
        setAccessMap(null)
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
  }, [user?.role])

  useEffect(() => {
    fetchAndApply(true)
  }, [fetchAndApply])

  const refreshMenuAccess = useCallback(() => fetchAndApply(false), [fetchAndApply])

  const hasAccess = useCallback(
    (menuKey: string): boolean => {
      if (accessMap === null) return true
      if (menuKey in accessMap) return accessMap[menuKey] === true
      // key ใหม่ที่ยังไม่อยู่ใน DB → fallback ตาม parent key (e.g. "products-inactive" → "products")
      const dash = menuKey.lastIndexOf('-')
      if (dash > 0) {
        const parentKey = menuKey.substring(0, dash)
        if (parentKey in accessMap) return accessMap[parentKey] === true
      }
      return false
    },
    [accessMap],
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
