export const CLAIM_PAYMENT_ZERO_TOLERANCE = 0.01

/**
 * บิลเคลมเป็นบิลเรียกเก็บใหม่ ยอดที่ต้องชำระจึงเท่ากับ total_amount
 * (ยอดสินค้าเคลม + ค่าจัดส่ง) โดยยอมรับเศษจากการคำนวณไม่เกิน 1 สตางค์เป็นยอดศูนย์
 */
export function requiresClaimPaymentSlip(totalAmount: unknown): boolean {
  const amount = Number(totalAmount)
  return Number.isFinite(amount) && amount > CLAIM_PAYMENT_ZERO_TOLERANCE
}
