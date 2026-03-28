import type { SupabaseClient } from '@supabase/supabase-js'
import type { OrderStatus } from '../types'
import { pumpVerifiedRoutingStatus } from './pumpConfirmRouting'

export type OwnerSalesRole = 'sales-tr' | 'sales-pump'

/** PUMP: ติ๊กออกแบบเมื่อ requires_confirm_design !== false (สอดคล้อง OrderForm / RPC) */
export function pumpDesignChecked(requiresConfirmDesign: boolean | null | undefined): boolean {
  return requiresConfirmDesign !== false
}

export function nonPumpDesignChecked(requiresConfirmDesign: boolean | null | undefined): boolean {
  return requiresConfirmDesign === true
}

/**
 * หลังตรวจสลิปสำเร็จ (หรือเส้นทางเทียบเท่า): สถานะถัดไปตามเจ้าของบิล (admin_user → role)
 *
 * - sales-tr + ติ๊กออกแบบ → ตรวจสอบแล้ว (คิว Confirm งานใหม่)
 * - sales-tr + ไม่ติ๊ก → รอตรวจคำสั่งซื้อ (ทั้ง PUMP และ non-PUMP)
 * - sales-pump + PUMP → ติ๊ก → ตรวจสอบแล้ว, ไม่ติ๊ก → ไม่ต้องออกแบบ
 * - sales-pump + ช่องอื่น → ข้ามรอตรวจ → ตรวจสอบแล้ว
 * - role อื่น: PUMP ใช้ pumpVerifiedRoutingStatus; non-PUMP ใช้ fallbackNonPumpNonSales (SlipUpload=รอตรวจ, OrderForm verify=ตรวจสอบแล้ว)
 */
export function computePostSlipVerificationStatus(
  ownerRole: OwnerSalesRole | null | undefined,
  channelCode: string | null | undefined,
  requiresConfirmDesign: boolean | null | undefined,
  options?: { fallbackNonPumpNonSales?: OrderStatus },
): OrderStatus {
  const ch = (channelCode ?? '').trim()
  const isPump = ch === 'PUMP'
  const fallbackNonPump: OrderStatus = options?.fallbackNonPumpNonSales ?? 'รอตรวจคำสั่งซื้อ'

  if (ownerRole === 'sales-pump') {
    if (isPump) {
      return pumpVerifiedRoutingStatus(pumpDesignChecked(requiresConfirmDesign))
    }
    return 'ตรวจสอบแล้ว'
  }

  if (ownerRole === 'sales-tr') {
    if (isPump) {
      return pumpDesignChecked(requiresConfirmDesign) ? 'ตรวจสอบแล้ว' : 'รอตรวจคำสั่งซื้อ'
    }
    return nonPumpDesignChecked(requiresConfirmDesign) ? 'ตรวจสอบแล้ว' : 'รอตรวจคำสั่งซื้อ'
  }

  if (isPump) {
    return pumpVerifiedRoutingStatus(pumpDesignChecked(requiresConfirmDesign))
  }
  return fallbackNonPump
}

export async function fetchOrderOwnerSalesRole(
  client: SupabaseClient,
  adminUser: string | null | undefined,
): Promise<OwnerSalesRole | null> {
  const key = (adminUser ?? '').trim()
  if (!key) return null

  const { data: byUsername } = await client
    .from('us_users')
    .select('role')
    .eq('username', key)
    .maybeSingle()
  if (byUsername?.role === 'sales-tr' || byUsername?.role === 'sales-pump') {
    return byUsername.role
  }

  const { data: byEmail } = await client
    .from('us_users')
    .select('role')
    .eq('email', key)
    .maybeSingle()
  if (byEmail?.role === 'sales-tr' || byEmail?.role === 'sales-pump') {
    return byEmail.role
  }

  return null
}
