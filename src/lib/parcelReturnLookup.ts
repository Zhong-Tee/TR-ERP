import { supabase } from './supabase'

export function normalizeParcelTracking(tracking: string): string {
  return tracking.replace(/\s+/g, '').toUpperCase()
}

// The RPC normalizes stored tracking numbers too, while preserving their
// original formatting in the returned order and applying the caller's RLS.
export async function findShippedOrderByTracking(tracking: string) {
  const key = normalizeParcelTracking(tracking)
  if (!key) return null

  const { data, error } = await supabase
    .rpc('find_shipped_order_for_parcel_return', { p_tracking: key })
    .select('bill_no, tracking_number, recipient_name, status, or_order_items(product_id, quantity)')
  if (error) throw error
  return Array.isArray(data) ? data[0] ?? null : null
}
