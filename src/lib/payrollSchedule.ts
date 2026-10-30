import type { PayrollItem } from './payrollApi'
import type { MonthlyWageDetail } from './payrollCompensation'

export const DEFAULT_PAY_SCHEDULE_ID = '00000000-0000-4000-8000-000000000001'
export type PayFrequency = 'daily' | 'weekly' | 'semimonthly' | 'monthly' | 'custom'
export interface PaySchedule {
  id: string; company_id: string | null; name: string; frequency: PayFrequency
  weekday: number; first_day: number; second_day: number | null; payment_day: number | null
  holiday_rule: 'none' | 'previous' | 'next'; deduction_policy: 'last' | 'proportional'
  cutoff_time: string; is_active: boolean
}
export interface PayScheduleAssignment { employee_id: string; schedule_id: string; effective_date: string; created_at?: string }
export interface PayPeriod { start: string; end: string; paymentDate: string }
export const FINANCIAL_FIELDS = ['base_salary','position_allowance','overtime_pay','other_income','personal_tax','social_security','ewf','savings','student_loan','company_loan','leave_deduction','other_deduction'] as const
export type FinancialField = typeof FINANCIAL_FIELDS[number]
export const DEDUCTION_FIELDS = ['personal_tax','social_security','ewf','savings','student_loan','company_loan','leave_deduction','other_deduction'] as const
export const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
export const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0,10)
export const lastDateOfMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10)
export function daysBetween(start: string, end: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) return []
  const count = Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1
  if (!Number.isFinite(count) || count > 366) throw new Error('ช่วงค่าจ้างต้องไม่เกิน 366 วัน')
  return Array.from({ length: count }, (_, index) => shiftDate(start,index))
}
export function adjustPaymentDate(date: string, rule: PaySchedule['holiday_rule'], holidays: Set<string>): string {
  if (rule === 'none') return date
  let result = date
  for (let index=0;index<370;index++) {
    const weekday = new Date(`${result}T00:00:00Z`).getUTCDay()
    if (weekday !== 0 && weekday !== 6 && !holidays.has(result)) return result
    result = shiftDate(result,rule === 'previous' ? -1 : 1)
  }
  throw new Error('ไม่พบวันจ่ายที่เป็นวันทำการ')
}
export function schedulePeriods(schedule: PaySchedule, month: string, holidays = new Set<string>()): PayPeriod[] {
  const first = `${month}-01`, last = lastDateOfMonth(month)
  const finish = (start: string,end: string,date: string): PayPeriod => ({ start,end,paymentDate: adjustPaymentDate(date,schedule.holiday_rule,holidays) })
  if (schedule.frequency === 'custom') return []
  if (schedule.frequency === 'daily') return daysBetween(first,last).map(date => finish(date,date,date))
  if (schedule.frequency === 'weekly') {
    return daysBetween(first,last).filter(date => (new Date(`${date}T00:00:00Z`).getUTCDay() || 7) === schedule.weekday)
      .map(date => finish(shiftDate(date,-7),shiftDate(date,-1),date))
  }
  const day = (value: number | null) => value == null ? last : `${month}-${String(Math.min(value,Number(last.slice(8)))).padStart(2,'0')}`
  if (schedule.frequency === 'semimonthly') {
    const cutoff = day(schedule.first_day)
    const second = day(schedule.second_day)
    if (cutoff >= second) throw new Error('วันจ่ายงวดที่สองต้องอยู่หลังงวดแรก')
    const previousLast=shiftDate(first,-1), previousMonth=previousLast.slice(0,7)
    const previousCutoff=schedule.second_day == null ? previousLast
      : `${previousMonth}-${String(Math.min(schedule.second_day,Number(previousLast.slice(8)))).padStart(2,'0')}`
    return [finish(shiftDate(previousCutoff,1),cutoff,cutoff),finish(shiftDate(cutoff,1),second,second)]
  }
  let payment = day(schedule.payment_day)
  if (payment < last) {
    const next = shiftDate(last,1).slice(0,7)
    payment = `${next}-${String(Math.min(schedule.payment_day || 31,Number(lastDateOfMonth(next).slice(8)))).padStart(2,'0')}`
  }
  return [finish(first,last,payment)]
}
export function scheduleOnDate(employeeId: string, date: string, assignments: PayScheduleAssignment[]): string {
  const row = [...assignments].filter(value => value.employee_id===employeeId && value.effective_date<=date)
    .sort((a,b) => b.effective_date.localeCompare(a.effective_date) || (b.created_at || '').localeCompare(a.created_at || ''))[0]
  return row?.schedule_id || DEFAULT_PAY_SCHEDULE_ID
}
/** Allocate integer cents, independent of the selected payment window. */
export function distributeCents(amount: number, weights: number[]): number[] {
  const cents = Math.round(amount*100), total = weights.reduce((sum,value)=>sum+value,0)
  let cumulative=0, allocated=0
  return weights.map(weight => {
    cumulative+=weight
    const next = total ? Math.round(cents*cumulative/total) : 0
    const result=(next-allocated)/100; allocated=next
    return result
  })
}
export function monthlyDailyAmounts(details: MonthlyWageDetail[]): { date: string; salary: number; allowance: number; rate: number }[] {
  const allDates=details.flatMap(detail=>daysBetween(detail.startDate,detail.endDate))
  const fullMonth=allDates.length>0 && allDates[0].endsWith('-01') && allDates.at(-1)===lastDateOfMonth(allDates[0].slice(0,7))
    && allDates.length===Number(lastDateOfMonth(allDates[0].slice(0,7)).slice(8))
  return details.flatMap(detail=>{
    const dates=daysBetween(detail.startDate,detail.endDate)
    const weights=dates.map(date=>fullMonth && Number(date.slice(8))>15 ? 15/(Number(lastDateOfMonth(date.slice(0,7)).slice(8))-15) : 1)
    const salary=distributeCents(detail.amount,weights), allowance=distributeCents(detail.allowanceAmount,weights)
    return dates.map((date,index)=>({ date,salary:salary[index],allowance:allowance[index],rate:detail.monthlyRate }))
  })
}
export function payrollAmounts(item: Partial<PayrollItem>) {
  const income=roundMoney(Number(item.base_salary||0)+Number(item.position_allowance||0)+Number(item.overtime_pay||0)+Number(item.other_income||0))
  const deduction=roundMoney(DEDUCTION_FIELDS.reduce((sum,key)=>sum+Number(item[key]||0),0))
  return { income,deduction,net:roundMoney(income-deduction) }
}
export function periodClosed(period: PayPeriod, cutoffTime: string, bangkokNow: string): boolean {
  return period.end < bangkokNow.slice(0,10) || (period.end===bangkokNow.slice(0,10) && bangkokNow.slice(11,16)>=cutoffTime.slice(0,5))
}
