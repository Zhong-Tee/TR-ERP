import type { HREmployeeOpeningBalance, HRLeaveRequest, HRLeaveType } from '../types'

export type EntitlementType = Pick<HRLeaveType, 'id' | 'name' | 'max_days_per_year' | 'is_paid'>
export type EntitlementOpening = Pick<HREmployeeOpeningBalance, 'employee_id' | 'leave_type_id' | 'year' | 'effective_date' | 'opening_remaining_days'>
export type EntitlementRequest = Pick<HRLeaveRequest, 'employee_id' | 'leave_type_id' | 'start_date' | 'total_days' | 'status'>

/** A saved zero is an explicit personal entitlement, never a fallback to the company default. */
export function resolveLeaveEntitlement(employeeId: string, type: EntitlementType, asOf: string, openings: EntitlementOpening[]) {
  const year = Number(asOf.slice(0, 4))
  const opening = openings.find(row => row.employee_id === employeeId && row.leave_type_id === type.id && row.year === year && row.effective_date <= asOf)
  return {
    entitled: Math.max(0, Number(opening ? opening.opening_remaining_days : type.max_days_per_year ?? 0)),
    effectiveDate: opening?.effective_date ?? `${year}-01-01`,
    personal: !!opening,
  }
}

export function calculateEmployeeLeaveBalances(employeeId: string, asOf: string, types: EntitlementType[], requests: EntitlementRequest[], openings: EntitlementOpening[]) {
  const year = asOf.slice(0, 4)
  return types.map(type => {
    const basis = resolveLeaveEntitlement(employeeId, type, asOf, openings)
    const used = requests.filter(r => r.employee_id === employeeId && r.leave_type_id === type.id && r.status === 'approved' && r.start_date.startsWith(year) && r.start_date >= basis.effectiveDate)
      .reduce((sum, r) => sum + Math.max(0, Number(r.total_days) || 0), 0)
    return { id: type.id, name: type.name, entitled: basis.entitled, used, remaining: Math.max(0, basis.entitled - used), excess: Math.max(0, used - basis.entitled), effectiveDate: basis.effectiveDate, personal: basis.personal }
  })
}
