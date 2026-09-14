import type { HRWFHRequestType } from '../types'

export const WFH_REQUEST_TYPE_OPTIONS: ReadonlyArray<{ value: HRWFHRequestType; label: string }> = [
  { value: 'afternoon_shift', label: 'เข้างานกะบ่าย' },
  { value: 'sunday_work', label: 'ทำงานวันอาทิตย์' },
  { value: 'other', label: 'อื่นๆ' },
]

export function wfhRequestTypeLabel(type?: HRWFHRequestType | null): string {
  return WFH_REQUEST_TYPE_OPTIONS.find((option) => option.value === (type ?? 'other'))?.label ?? 'อื่นๆ'
}

export function wfhRequestTypeNeedsReason(type?: HRWFHRequestType | null): boolean {
  return !type || type === 'other'
}
