import { supabase } from './supabase'
import { fetchAllSupabasePages } from './supabasePagination'

export const caseMethods = {
  refund: 'ผู้ขายตกลงคืนเงิน',
  cancel_unpaid: 'ยกเลิกยอดที่ยังไม่ชำระ',
  vendor_refused: 'ผู้ขายไม่รับผิดชอบ',
  dispute: 'ติดตาม / ข้อพิพาท',
} as const
export type CaseMethod = keyof typeof caseMethods
export const caseStatuses = {
  pending: 'รออนุมัติ', refund_pending: 'รอคืนเงิน', adjustment_pending: 'รอปรับยอดชำระ',
  dispute: 'ติดตาม / ข้อพิพาท', completed: 'ดำเนินการเสร็จแล้ว', rejected: 'ไม่อนุมัติ',
} as const
export const canViewPurchaseCost = (role?: string) => ['superadmin', 'admin', 'account'].includes(role || '')
export function outstandingQuantity(item: { qty: number; qty_received_total?: number | null; resolution_qty?: number | null }, reserved = 0) {
  return Math.max(0, Math.round((Number(item.qty) - Number(item.qty_received_total || 0) - Number(item.resolution_qty || 0) - reserved) * 100) / 100)
}
export interface CaseItem {
  id: string; qty: number; po_item_id: string
  inv_po_items: { id: string; qty: number; qty_received_total: number; resolution_qty: number; unit: string; pr_products: { product_code: string; product_name: string } }
}
export interface ReceivingCase {
  id: string; case_no: number; po_id: string; method: CaseMethod; status: keyof typeof caseStatuses
  reason: string; assigned_to: string; created_by: string; created_at: string; approved_by?: string; approved_at?: string
  inv_po: { po_no: string; supplier_name: string }
  inv_receiving_case_items: CaseItem[]
  inv_receiving_case_events: { id: string; action: string; note: string; actor_id: string; created_at: string }[]
}
export interface CaseFinance { expected_amount: number; settled_amount: number; currency: string }
export interface CaseSettlement { id: string; amount: number; reference: string; settled_on: string }

export async function loadReceivingCases() {
  const data = await fetchAllSupabasePages((from, to) => supabase.from('inv_receiving_cases').select(`*,
    inv_po(po_no,supplier_name),
    inv_receiving_case_items(id,qty,po_item_id,inv_po_items(id,qty,qty_received_total,resolution_qty,unit,pr_products(product_code,product_name))),
    inv_receiving_case_events(*)`).order('created_at', { ascending: false }).order('id').range(from, to))
  return (data || []) as unknown as ReceivingCase[]
}
export async function loadCaseUsers(): Promise<Record<string, string>> {
  const { data, error } = await supabase.rpc('rpc_receiving_case_users')
  if (error) throw error
  return Object.fromEntries((data || []).map((u: { id: string; name: string }) => [u.id, u.name]))
}
export async function caseAction(id: string, action: string, data: Record<string, unknown> = {}) {
  const { error } = await supabase.rpc('rpc_receiving_case_action', { p_case_id: id, p_action: action, p_data: data })
  if (error) throw error
}
export async function uploadCaseEvidence(caseId: string, userId: string, file: File) {
  if (file.size > 10 * 1024 * 1024 || !['image/jpeg', 'image/png', 'application/pdf'].includes(file.type)) throw new Error('แนบ JPG, PNG หรือ PDF ขนาดไม่เกิน 10 MB')
  const name = file.name.replace(/[^\p{L}\p{N}._-]/gu, '_')
  const { error } = await supabase.storage.from('receiving-case-evidence').upload(`${caseId}/${userId}/${crypto.randomUUID()}_${name}`, file)
  if (error) throw error
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String((error as { message?: string })?.message || error)
}
