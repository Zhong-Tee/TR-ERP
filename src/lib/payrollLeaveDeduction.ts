import type { HREmployeeOpeningBalance, HRLeaveRequest, HRLeaveType } from '../types'

export type LeaveDeductionRequest = Pick<HRLeaveRequest, 'id' | 'employee_id' | 'leave_type_id' | 'start_date' | 'total_days' | 'status' | 'created_at'>
export type LeaveDeductionType = Pick<HRLeaveType, 'id' | 'name' | 'max_days_per_year' | 'is_paid'>
export type LeaveDeductionOpening = Pick<HREmployeeOpeningBalance, 'employee_id' | 'leave_type_id' | 'year' | 'effective_date' | 'opening_remaining_days'>

/** Match the HR overage report: charge the increment in the request's starting month. */
export function calculateMonthlyLeaveOverage(
  month: string,
  requests: LeaveDeductionRequest[],
  types: LeaveDeductionType[],
  openings: LeaveDeductionOpening[],
): Map<string, Map<string, number>> {
  const year = Number(month.slice(0, 4))
  const typesById = new Map(types.map((type) => [type.id, type]))
  const openingByKey = new Map(openings.filter((row) => row.year === year).map((row) => [`${row.employee_id}|${row.leave_type_id}`, row]))
  const cumulative = new Map<string, number>()
  const details = new Map<string, Map<string, number>>()
  const approved = requests.filter((row) => row.status === 'approved' && row.start_date.startsWith(String(year)) && row.start_date.slice(0, 7) <= month)
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  for (const request of approved) {
    const type = typesById.get(request.leave_type_id)
    if (!type) throw new Error('ไม่พบประเภทลา ไม่สามารถคำนวณยอดหักเงินเดือนได้')
    const key = `${request.employee_id}|${request.leave_type_id}`
    const opening = openingByKey.get(key)
    if (opening && request.start_date < opening.effective_date) continue
    // Unpaid leave has no paid entitlement, even if a leave-day limit is configured.
    const entitled = type.is_paid ? Math.max(0, Number(opening?.opening_remaining_days ?? type.max_days_per_year ?? 0)) : 0
    const usedBefore = cumulative.get(key) || 0
    const usedAfter = usedBefore + Math.max(0, Number(request.total_days) || 0)
    cumulative.set(key, usedAfter)
    const excess = Math.max(0, usedAfter - entitled) - Math.max(0, usedBefore - entitled)
    if (excess > 0 && request.start_date.slice(0, 7) === month) {
      const byType = details.get(request.employee_id) || new Map<string, number>()
      byType.set(type.name, (byType.get(type.name) || 0) + excess)
      details.set(request.employee_id, byType)
    }
  }
  return details
}

export function calculateLeaveDeductionAmount(salary: number, excessDays: number, payType: string = 'permanent'): number {
  const dailyRate = payType === 'daily' ? salary : salary / 30
  return Math.round(dailyRate * excessDays * 100) / 100
}

/** Drafts follow the latest leave source; confirmed payroll is a saved snapshot. */
export function resolvePayrollLeaveDeduction(
  status: 'draft' | 'confirmed',
  savedAmount: number,
  currentAmount: number | undefined,
) {
  const amount = status === 'confirmed' ? Number(savedAmount) || 0 : Number(currentAmount) || 0
  return { amount, changed: status !== 'confirmed' && amount !== (Number(savedAmount) || 0) }
}
