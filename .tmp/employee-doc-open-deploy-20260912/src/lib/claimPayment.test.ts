import { describe, expect, it } from 'vitest'
import { requiresClaimPaymentSlip } from './claimPayment'

describe('requiresClaimPaymentSlip', () => {
  it('ไม่บังคับสลิปเมื่อไม่มียอดต้องชำระ', () => {
    expect(requiresClaimPaymentSlip(0)).toBe(false)
    expect(requiresClaimPaymentSlip(null)).toBe(false)
    expect(requiresClaimPaymentSlip(0.01)).toBe(false)
  })

  it('บังคับสลิปเมื่อมียอดต้องชำระจริง', () => {
    expect(requiresClaimPaymentSlip(0.02)).toBe(true)
    expect(requiresClaimPaymentSlip('100.00')).toBe(true)
  })

  it('ไม่บังคับสลิปเมื่อค่าไม่ถูกต้องหรือติดลบ', () => {
    expect(requiresClaimPaymentSlip('invalid')).toBe(false)
    expect(requiresClaimPaymentSlip(-1)).toBe(false)
  })
})
