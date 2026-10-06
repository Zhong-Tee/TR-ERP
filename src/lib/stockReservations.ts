import { supabase } from './supabase'
import { fetchAllSupabasePagesResult } from './supabasePagination'

export type StockReservationRow = {
  source_type: 'prebill' | 'order' | 'borrow' | 'wms'
  source_id: string
  document_type: 'QT' | 'PC' | 'sale' | 'claim' | 'borrow' | 'wms'
  document_no: string
  source_document_no: string | null
  customer_name: string
  owner_name: string
  product_id: string
  qty: number
  expires_on: string | null
  status: string
}
export const reservationTypeLabels = { QT: 'QT', PC: 'PC', sale: 'บิลขาย', claim: 'บิลเคลม', borrow: 'ใบยืม', wms: 'งานหยิบ WMS' }
export function reservationStatusLabel(row: StockReservationRow): string {
  if (row.status === 'cancelled_pending_stock') return 'ยกเลิก รอจัดการสต๊อก'
  if (row.status === 'picked') return 'หยิบแล้ว รอตรวจ'
  if (row.source_type === 'prebill') return ({ active: 'รอยืนยัน', pending_discount: 'รออนุมัติส่วนลด', approved: 'อนุมัติแล้ว รอเปิดบิล', rejected: 'ไม่อนุมัติส่วนลด' } as Record<string, string>)[row.status] || row.status
  if (row.source_type === 'borrow') return row.status === 'partial_returned' ? 'คืนบางส่วน ยังจองค้าง' : row.status === 'overdue' ? 'เกินกำหนดคืน' : 'อนุมัติแล้ว รอคืน'
  return `${row.status} · รอหยิบ/ตัดสต๊อก`
}
export function reservationTotals(onHand: number, reserved: number) {
  return { reserved, available: onHand - reserved }
}

export function isMissingReservationRpc(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'PGRST202'
}
type ReservationStock = { product_id: string; on_hand: number | null; reserved: number | null; safety_stock: number | null; own_reserved?: number }
export async function fetchReservationStock(type: 'order' | 'prebill', sourceId: string | null) {
  const result = await fetchAllSupabasePagesResult<ReservationStock>((from,to) => supabase.rpc('rpc_get_reservation_stock', { p_type: type, p_source: sourceId }).order('product_id').range(from,to))
  if (!isMissingReservationRpc(result.error)) return result
  // Deploying the client before the migration must leave the legacy stock loader usable.
  return fetchAllSupabasePagesResult<ReservationStock>((from,to) => supabase.from('inv_stock_balances').select('product_id,on_hand,reserved,safety_stock').order('product_id').range(from,to))
}
async function usesLegacyReservationSchema(table: 'or_orders' | 'or_prebill_documents') {
  const result = await supabase.from(table).select('stock_reservation_enabled').limit(1)
  return result.error?.code === '42703' && result.error.message.includes('stock_reservation_enabled')
}
export async function saveReservationOrderItems(orderId: string, items: Record<string, unknown>[]) {
  const result = await supabase.rpc('rpc_save_order_items', { p_order_id: orderId, p_items: items })
  if (!isMissingReservationRpc(result.error) || !await usesLegacyReservationSchema('or_orders')) return result
  // Only a database without the reservation migration uses the legacy writer.
  const deletion = await supabase.from('or_order_items').delete().eq('order_id',orderId)
  if (deletion.error || items.length === 0) return deletion
  return supabase.from('or_order_items').insert(items)
}
export async function saveReservationPrebill(id: string | null, payload: Record<string, unknown>, items: Record<string, unknown>[]) {
  const result = await supabase.rpc('rpc_save_prebill_document', { p_id: id, p_document: payload, p_items: items })
  if (!isMissingReservationRpc(result.error) || !await usesLegacyReservationSchema('or_prebill_documents')) {
    return { ...result, data: Array.isArray(result.data) ? result.data[0] : result.data }
  }
  const header = id
    ? await supabase.from('or_prebill_documents').update(payload).eq('id',id).select().single()
    : await supabase.from('or_prebill_documents').insert(payload).select().single()
  if (header.error) return header
  const deletion = await supabase.from('or_prebill_items').delete().eq('document_id',header.data.id)
  if (deletion.error) return { data: null, error: deletion.error }
  if (items.length) {
    const insertion = await supabase.from('or_prebill_items').insert(items.map(item => ({...item,document_id:header.data.id})))
    if (insertion.error) return { data: null, error: insertion.error }
  }
  return header
}

export function reservationBreakdown(balanceReserved: number, linkedReserved: number) {
  const difference = Number((balanceReserved - linkedReserved).toFixed(2))
  return {
    total: balanceReserved,
    linked: linkedReserved,
    unexplained: Math.max(0, difference),
    underReserved: Math.max(0, -difference),
  }
}
