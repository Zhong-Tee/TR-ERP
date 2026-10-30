import type { PayrollItem } from './payrollApi'
import type { HREmployee } from '../types'

/** Older runs have no enrollment snapshot; use only their recorded deduction. */
export function payrollSocialSecurityEnabled(item: Pick<PayrollItem, 'social_security_enabled' | 'social_security'>): boolean {
  return item.social_security_enabled ?? Number(item.social_security) > 0
}

export function monthlyPayrollGroup(items: PayrollItem[], enrolled: boolean): PayrollItem[] {
  return items.filter(item => item.pay_type !== 'daily' && payrollSocialSecurityEnabled(item) === enrolled)
}

/** A draft may predate an employee's switch from daily to monthly payroll. */
export function appendMissingMonthlyEmployees(
  items: PayrollItem[], employees: HREmployee[], createItem: (employee: HREmployee) => PayrollItem,
): PayrollItem[] {
  const included = new Set(items.map(item => item.employee_id))
  const result = [...items]
  for (const employee of employees) {
    if (included.has(employee.id)) continue
    const candidate = createItem(employee)
    if (employee.contract_type === 'daily' && !(Number(candidate.monthly_payable_days) > 0)) continue
    included.add(employee.id)
    result.push(candidate)
  }
  return result
}
