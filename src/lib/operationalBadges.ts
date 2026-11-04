import { supabase } from './supabase'
import { operationalCountCache } from './readRefresh'

export function loadPendingReturns(scope: string) {
  return operationalCountCache.read(`returns:${scope}`, async () => {
    const { count, error } = await supabase.from('inv_returns')
      .select('id', { count: 'exact', head: true }).eq('status', 'pending')
    if (error) throw error
    return count || 0
  })
}

export function loadHrPendingCounts(scope: string) {
  return operationalCountCache.read(`hr:${scope}`, async () => {
    const results = await Promise.all(['hr_leave_requests', 'hr_ot_requests', 'hr_wfh_requests'].map(table =>
      supabase.from(table).select('id', { count: 'exact', head: true }).eq('status', 'pending')))
    for (const result of results) if (result.error) throw result.error
    const [leave, ot, wfh] = results.map(result => result.count || 0)
    return { leave, ot, wfh, total: leave + ot + wfh }
  })
}
