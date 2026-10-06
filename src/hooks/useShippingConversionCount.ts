import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthContext } from '../contexts/AuthContext'

export function useShippingConversionCount(approvalOnly = false) {
  const { user } = useAuthContext()
  const actorId = user?.id
  const actorRole = user?.role
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!actorId || !actorRole || !['superadmin', 'admin', 'account', 'sales-tr', 'sales-pump'].includes(actorRole)) return
    let cancelled = false
    async function load() {
      const query = supabase.from('or_shipping_conversion_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending')
      if (approvalOnly) query.eq('shipping_cost', 0).is('zero_approved_by', null)
      const { count: total, error } = await query
      if (!cancelled && !error) setCount(total || 0)
    }
    void load()
    const refresh = () => { if (!document.hidden) void load() }
    const timer = window.setInterval(refresh, 30000)
    window.addEventListener('shipping-conversion-changed', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('shipping-conversion-changed', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [actorId, actorRole, approvalOnly])
  return count
}
