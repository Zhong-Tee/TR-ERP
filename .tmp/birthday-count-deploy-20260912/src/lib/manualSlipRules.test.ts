import { describe, expect, it } from 'vitest'
import { hasDuplicateSlipError, isSlipOrderStatusConsideredUsed, manualSlipSubmissionMode } from './manualSlipRules'

describe('manual slip submission rules', () => {
  it('detects the duplicate validation badge', () => {
    expect(hasDuplicateSlipError(['ยอดเงินไม่ตรง', 'สลิปซ้ำ (พบในออเดอร์อื่น)'])).toBe(true)
    expect(hasDuplicateSlipError(['ยอดเงินไม่ตรง'])).toBe(false)
  })

  it('does not treat slips on cancelled or failed bills as already used', () => {
    expect(isSlipOrderStatusConsideredUsed('ยกเลิก')).toBe(false)
    expect(isSlipOrderStatusConsideredUsed('ตรวจสอบไม่ผ่าน')).toBe(false)
    expect(isSlipOrderStatusConsideredUsed('ตรวจสอบแล้ว')).toBe(true)
  })

  it('blocks exact transRef duplicates', () => {
    expect(manualSlipSubmissionMode({
      hasPending: false,
      hasDuplicateBadge: true,
      hasExactTransRefDuplicate: true,
      duplicateLookupFailed: false,
    })).toBe('blocked_exact')
  })

  it('allows amount/date-only duplicates as exception reviews', () => {
    expect(manualSlipSubmissionMode({
      hasPending: false,
      hasDuplicateBadge: true,
      hasExactTransRefDuplicate: false,
      duplicateLookupFailed: false,
    })).toBe('exception_review')
  })

  it('fails closed when duplicate lookup is unavailable', () => {
    expect(manualSlipSubmissionMode({
      hasPending: false,
      hasDuplicateBadge: true,
      hasExactTransRefDuplicate: false,
      duplicateLookupFailed: true,
    })).toBe('blocked_safe')
  })
})
