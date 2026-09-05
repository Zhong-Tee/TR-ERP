export function hasDuplicateSlipError(errors: unknown): boolean {
  return Array.isArray(errors) && errors.some((error) => String(error).includes('สลิปซ้ำ'))
}

const SLIP_NOT_USED_ORDER_STATUSES = new Set([
  'รอลงข้อมูล',
  'ลงข้อมูลผิด',
  'ตรวจสอบไม่ผ่าน',
  'ตรวจสอบไม่สำเร็จ',
  'ยกเลิก',
])

export function isSlipOrderStatusConsideredUsed(status: unknown): boolean {
  const value = typeof status === 'string' ? status.trim() : ''
  return value !== '' && !SLIP_NOT_USED_ORDER_STATUSES.has(value)
}

export function manualSlipSubmissionMode(input: {
  hasPending: boolean
  hasDuplicateBadge: boolean
  hasExactTransRefDuplicate: boolean
  duplicateLookupFailed: boolean
}): 'pending' | 'blocked_exact' | 'blocked_safe' | 'exception_review' | 'normal' {
  if (input.hasPending) return 'pending'
  if (input.hasExactTransRefDuplicate) return 'blocked_exact'
  if (input.duplicateLookupFailed && input.hasDuplicateBadge) return 'blocked_safe'
  if (input.hasDuplicateBadge) return 'exception_review'
  return 'normal'
}
