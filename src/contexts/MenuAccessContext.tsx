import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthContext } from './AuthContext'

interface MenuAccessContextType {
  /** Raw map from DB — null = role has no config yet */
  menuAccess: Record<string, boolean> | null
  /** true while loading menu access from DB */
  menuAccessLoading: boolean
  /** Check if a menu key is accessible. Returns true when no DB config exists. */
  hasAccess: (menuKey: string) => boolean
  /** Force reload from DB (e.g. after saving role settings) */
  refreshMenuAccess: () => void
}

const MenuAccessContext = createContext<MenuAccessContextType | undefined>(undefined)

export function MenuAccessProvider({ children }: { children: ReactNode }) {
  const { user } = useAuthContext()
  const [accessMap, setAccessMap] = useState<Record<string, boolean> | null>(null)
  const [loaded, setLoaded] = useState(false)

  const loadAccess = useCallback(async () => {
    if (!user?.role) {
      setAccessMap(null)
      setLoaded(true)
      return
    }
    setLoaded(false)
    try {
      const { data, error } = await supabase
        .from('st_user_menus')
        .select('menu_key, has_access')
        .eq('role', user.role)
      if (error) {
        console.error('MenuAccess load error:', error)
        setLoaded(true)
        return
      }
      if (!data || data.length === 0) {
        setAccessMap(null)
        setLoaded(true)
        return
      }
      const map: Record<string, boolean> = {}
      data.forEach((row: { menu_key: string; has_access: boolean }) => {
        map[row.menu_key] = row.has_access
      })
      setAccessMap(map)
    } catch (e) {
      console.error('MenuAccess load error:', e)
    } finally {
      setLoaded(true)
    }
  }, [user?.role])

  useEffect(() => {
    loadAccess()
  }, [loadAccess])

  const hasAccess = useCallback(
    (menuKey: string): boolean => {
      if (accessMap === null) return true
      if (menuKey in accessMap) return accessMap[menuKey] === true
      return true
    },
    [accessMap],
  )

  return (
    <MenuAccessContext.Provider value={{ menuAccess: accessMap, menuAccessLoading: !loaded, hasAccess, refreshMenuAccess: loadAccess }}>
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
