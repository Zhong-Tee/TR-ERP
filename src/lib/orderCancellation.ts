import type { User } from '../types'
import { supabase } from './supabase'

export function isZeroValueOrder(totalAmount: number | string | null | undefined): boolean {
  if (totalAmount == null || totalAmount === '') return false
  const amount = Number(totalAmount)
  return Number.isFinite(amount) && amount === 0
}

export async function cancelOrderWithAudit(orderId: string, user: User): Promise<void> {
  const actorName = user.username?.trim() || user.email?.trim() || user.id
  const { error } = await supabase
    .from('or_orders')
    .update({
      status: 'ยกเลิก',
      cancelled_by: user.id,
      cancelled_by_name: actorName,
      cancelled_at: new Date().toISOString(),
    })
    .eq('id', orderId)

  if (error) throw error
}
