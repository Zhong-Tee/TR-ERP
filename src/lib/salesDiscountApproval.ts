import { supabase } from './supabase'

export type DiscountCheck = { required: boolean; approved: boolean; zero_payment: boolean; status: string; reason?: string | null; review_note?: string | null; automatic_discount: number; legacy_unchanged?: boolean }
export type DiscountPreview = { header: Record<string, unknown>; items: Record<string, unknown>[]; promotions: { promotion_id: string; application_count: number }[] }
export const DISCOUNT_STATUS: Record<string, string> = { none: 'ยังไม่ได้ขออนุมัติ', pending: 'รออนุมัติส่วนลด', approved: 'อนุมัติส่วนลดแล้ว', rejected: 'ไม่อนุมัติส่วนลด', stale: 'ข้อมูลเปลี่ยน ต้องขออนุมัติใหม่', cancelled: 'ยกเลิก', expired: 'หมดอายุ' }
export function discountBlocksCompletion(check: DiscountCheck): boolean { return check.required && !check.approved }
export function maySkipSlip(check: DiscountCheck, total: number): boolean { return Number.isFinite(total) && total === 0 && check.approved && check.zero_payment }
export async function checkSalesDiscount(id: string | null, preview: DiscountPreview): Promise<DiscountCheck> {
 const { data, error } = await supabase.rpc('rpc_check_order_discount', { p_order_id: id, p_header: preview.header, p_items: preview.items, p_promotions: preview.promotions })
 if (error) throw error
 if (!data || typeof data.required !== 'boolean' || typeof data.approved !== 'boolean' || typeof data.zero_payment !== 'boolean') throw new Error('ไม่สามารถตรวจสอบสิทธิ์ส่วนลดได้')
 return data as DiscountCheck
}
