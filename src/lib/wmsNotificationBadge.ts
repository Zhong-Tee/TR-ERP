import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllSupabasePages } from './supabasePagination'
import { enrichWmsNotificationsWithOrderDetails } from './wmsNotificationEnrichment'

/** Count each cancelled work order once, even when it needs both actions. */
export function countPendingCancellationNotifications(
  rows: Array<{ order_id?: string | null; pendingCancelled?: number; awaitingShelf?: number }>,
): number {
  const pendingOrders = new Set<string>()
  for (const row of rows) {
    if (Number(row.pendingCancelled || 0) <= 0 && Number(row.awaitingShelf || 0) <= 0) continue
    const orderId = String(row.order_id || '').trim()
    if (orderId) pendingOrders.add(orderId)
  }
  return pendingOrders.size
}

/** Match the notification page's actionable tabs, without a date/read filter. */
export async function loadWmsNotificationBadgeCount(client: SupabaseClient): Promise<number> {
  const [newResult, cancellationRows] = await Promise.all([
    client.from('wms_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'unread')
      .neq('type', 'ยกเลิกบิล'),
    fetchAllSupabasePages<{ id: string; order_id: string | null; type: string }>((from, to) => client.from('wms_notifications')
      .select('id, order_id, type')
      .eq('type', 'ยกเลิกบิล')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to)),
  ])
  if (newResult.error) throw newResult.error
  const enriched = await enrichWmsNotificationsWithOrderDetails(client, cancellationRows)
  return (newResult.count ?? 0) + countPendingCancellationNotifications(enriched)
}
