import { supabase } from './supabase'
import { fetchAllSupabasePages } from './supabasePagination'

interface ClaimShippingRequest { status: string; created_claim_order_id: string | null }
interface ClaimShippingOrder { id: string; status: string | null; claim_shipping_confirmed_at: string | null }

/** Same actionable definition for the menu badge and the approved subtab. */
export function countPendingClaimShipping(requests: ClaimShippingRequest[], orders: Record<string, ClaimShippingOrder>) {
  const ids = new Set<string>()
  for (const request of requests) {
    if (request.status !== 'approved' || !request.created_claim_order_id) continue
    const order = orders[request.created_claim_order_id]
    if (order && order.status !== 'ยกเลิก' && !order.claim_shipping_confirmed_at) ids.add(order.id)
  }
  return ids.size
}

export async function loadPendingClaimShippingCount(narrowAdminUser?: string) {
  const requests = await fetchAllSupabasePages<ClaimShippingRequest>((from, to) => supabase
    .from('or_claim_requests').select('id, status, created_claim_order_id')
    .eq('status', 'approved').not('created_claim_order_id', 'is', null)
    .order('id').range(from, to))
  const ids = [...new Set(requests.map(row => row.created_claim_order_id).filter((id): id is string => !!id))]
  const orders: Record<string, ClaimShippingOrder> = {}
  for (let offset = 0; offset < ids.length; offset += 100) {
    let query = supabase.from('or_orders').select('id, status, claim_shipping_confirmed_at')
      .in('id', ids.slice(offset, offset + 100))
    if (narrowAdminUser?.trim()) query = query.eq('admin_user', narrowAdminUser.trim())
    const { data, error } = await query
    if (error) throw error
    for (const row of data || []) orders[row.id] = row
  }
  return countPendingClaimShipping(requests, orders)
}
