import type { HREmployee } from '../types'

export interface CompensationRecord {
  id?: string
  employee_id: string
  salary: number
  position_allowance?: number | null
  pay_type: 'permanent' | 'daily'
  effective_date: string
  created_at?: string
}

export interface MonthlyWageDetail {
  startDate: string
  endDate: string
  monthlyRate: number
  positionAllowance: number
  calendarDays: number
  payableDays: number
  amount: number
  allowanceAmount: number
}

export interface MonthlyWageSummary {
  monthlyRate: number
  calendarDays: number
  payableDays: number
  baseSalary: number
  positionAllowance: number
  details: MonthlyWageDetail[]
}

export function sortCompensationHistory(rows: CompensationRecord[]): CompensationRecord[] {
  return [...rows].sort((a, b) => b.effective_date.localeCompare(a.effective_date)
    || (b.created_at || '').localeCompare(a.created_at || '') || (b.id || '').localeCompare(a.id || ''))
}

/** The caller supplies a sorted history shared by monthly, daily and OT calculations. */
export function compensationAt(employee: HREmployee, history: CompensationRecord[], date: string) {
  const row = history.find(record => record.employee_id === employee.id && record.effective_date <= date)
  return {
    salary: Math.max(0, Number(row?.salary ?? employee.salary) || 0),
    positionAllowance: Math.max(0, Number(row?.position_allowance ?? employee.position_allowance) || 0),
    payType: row?.pay_type || employee.contract_type || 'permanent',
  }
}

export function calculateMonthlyWage(month: string, employee: HREmployee, records: CompensationRecord[]): MonthlyWageSummary {
  const history = sortCompensationHistory(records)
  const start = `${month}-01`
  const date = new Date(`${start}T00:00:00Z`)
  const details: MonthlyWageDetail[] = []
  let daysInMonth = 0
  for (; date.toISOString().slice(0, 7) === month; date.setUTCDate(date.getUTCDate() + 1)) {
    daysInMonth++
    const workDate = date.toISOString().slice(0, 10)
    if (employee.hire_date && workDate < employee.hire_date.slice(0, 10)) continue
    if (employee.contract_end_date && workDate > employee.contract_end_date.slice(0, 10)) continue
    const pay = compensationAt(employee, history, workDate)
    if (pay.payType !== 'permanent') continue
    const last = details.at(-1)
    if (last && last.monthlyRate === pay.salary && last.positionAllowance === pay.positionAllowance
      && new Date(`${last.endDate}T00:00:00Z`).getTime() + 86400000 === date.getTime()) {
      last.endDate = workDate; last.calendarDays++
    } else details.push({ startDate: workDate, endDate: workDate, monthlyRate: pay.salary,
      positionAllowance: pay.positionAllowance, calendarDays: 1, payableDays: 0, amount: 0, allowanceAmount: 0 })
  }
  const calendarDays = details.reduce((sum, row) => sum + row.calendarDays, 0)
  // A full calendar month earns a full monthly rate (including February).
  // Partial months use actual eligible calendar days / 30, capped at 30 days.
  const payableDays = calendarDays === daysInMonth ? 30 : Math.min(calendarDays, 30)
  const round = (value: number) => Math.round(value * 100) / 100
  for (const detail of details) {
    detail.payableDays = calendarDays ? detail.calendarDays * payableDays / calendarDays : 0
    detail.amount = round(detail.monthlyRate / 30 * detail.payableDays)
    detail.allowanceAmount = round(detail.positionAllowance / 30 * detail.payableDays)
  }
  return { monthlyRate: details.at(-1)?.monthlyRate || 0, calendarDays, payableDays,
    baseSalary: round(details.reduce((sum, row) => sum + row.amount, 0)),
    positionAllowance: round(details.reduce((sum, row) => sum + row.allowanceAmount, 0)), details }
}
