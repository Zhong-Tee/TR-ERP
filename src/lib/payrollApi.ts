import { supabase } from './supabase'
import type { HRCompany, HREmployee } from '../types'

export interface PayrollItem {
  id?: string
  payroll_run_id?: string
  employee_id: string
  employee_code: string
  employee_name: string
  employee_nickname?: string | null
  department_position?: string | null
  base_salary: number
  position_allowance: number
  ot_normal_hours: number
  ot_holiday_hours: number
  overtime_pay: number
  pay_type?: 'permanent' | 'daily'
  daily_rate?: number
  full_days?: number
  half_days?: number
  paid_holiday_days?: number
  unpaid_leave_days?: number
  payable_days?: number
  unresolved_attendance_days?: number
  daily_wage_details?: DailyWageDetail[]
  personal_tax: number
  social_security: number
  ewf: number
  savings: number
  student_loan: number
  company_loan: number
  leave_deduction: number
  other_income: number
  other_deduction: number
  income_opening_balance: number
  personal_tax_opening_balance: number
  social_security_opening_balance: number
  ewf_opening_balance: number
  student_loan_opening_balance: number
  savings_opening_balance: number
  company_loan_opening_balance: number
  company_loan_opening_installments: number
  reviewed_at?: string | null
  reviewed_by?: string | null
  gross_income?: number
  total_deduction?: number
  net_pay?: number
  company_snapshot?: HRCompany
}

export interface PayrollRun {
  id: string
  payroll_month: string
  company_id: string
  payroll_type?: 'permanent' | 'daily'
  status: 'draft' | 'confirmed'
  payment_date?: string | null
  confirmed_by?: string | null
  confirmed_at?: string | null
  company?: HRCompany
  items?: PayrollItem[]
}

export type DailyWageStatus = 'worked_full' | 'worked_half' | 'paid_holiday' | 'unpaid_leave' | 'absent' | 'unresolved'

export interface DailyWageDetail {
  workDate: string
  status: DailyWageStatus
  payableDay: number
  clockIn?: string | null
  clockOut?: string | null
  clockInSource?: 'entry' | 'certified' | null
  clockOutSource?: 'entry' | 'certified' | null
  dailyRate: number
  amount: number
  note: string
}

export interface DailyWageSummary {
  dailyRate: number
  fullDays: number
  halfDays: number
  paidHolidayDays: number
  unpaidLeaveDays: number
  payableDays: number
  unresolvedDays: number
  regularPay: number
  details: DailyWageDetail[]
}

export function calculateDailyWageSummary(dailyRate: number, details: DailyWageDetail[]): DailyWageSummary {
  return {
    dailyRate: Math.max(0, Number(dailyRate) || 0),
    fullDays: details.filter((detail) => detail.status === 'worked_full').reduce((sum, detail) => sum + detail.payableDay, 0),
    halfDays: details.filter((detail) => detail.status === 'worked_half' || (detail.status === 'unpaid_leave' && detail.payableDay === 0.5)).length,
    paidHolidayDays: details.filter((detail) => detail.status === 'paid_holiday').length,
    unpaidLeaveDays: details.filter((detail) => detail.status === 'unpaid_leave').reduce((sum, detail) => sum + (1 - detail.payableDay), 0),
    payableDays: details.reduce((sum, detail) => sum + detail.payableDay, 0),
    unresolvedDays: details.filter((detail) => detail.status === 'unresolved').length,
    regularPay: Math.round(details.reduce((sum, detail) => sum + detail.amount, 0) * 100) / 100,
    details,
  }
}

export interface SocialSecuritySettings {
  id: boolean
  contribution_rate: number
  maximum_wage_base: number
  updated_at?: string
  updated_by?: string | null
}

export const DEFAULT_SOCIAL_SECURITY_SETTINGS: SocialSecuritySettings = {
  id: true,
  contribution_rate: 5,
  maximum_wage_base: 17500,
}

export interface PayrollOvertimeSummary {
  normalHours: number
  holidayHours: number
  overtimePay: number
}

export function calculateOvertimePay(input: {
  salary: number
  contractType: HREmployee['contract_type']
  normalHours: number
  holidayHours: number
}): PayrollOvertimeSummary {
  const salary = Math.max(0, Number(input.salary) || 0)
  const normalHours = Math.max(0, Number(input.normalHours) || 0)
  const holidayHours = Math.max(0, Number(input.holidayHours) || 0)
  const dailyWage = input.contractType === 'daily' ? salary : salary / 30
  const hourlyWage = dailyWage / 8
  const overtimePay = hourlyWage * ((normalHours * 1.5) + (holidayHours * 3))
  return {
    normalHours: Math.round(normalHours * 100) / 100,
    holidayHours: Math.round(holidayHours * 100) / 100,
    overtimePay: Math.round(overtimePay * 100) / 100,
  }
}

function timeRangeHours(start: string, end: string): number {
  const [startHour, startMinute] = start.slice(0, 5).split(':').map(Number)
  const [endHour, endMinute] = end.slice(0, 5).split(':').map(Number)
  let minutes = (endHour * 60 + endMinute) - (startHour * 60 + startMinute)
  if (minutes < 0) minutes += 24 * 60
  return minutes / 60
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export async function fetchPayrollOvertime(
  month: string,
  employees: HREmployee[],
): Promise<Record<string, PayrollOvertimeSummary>> {
  const empty = Object.fromEntries(employees.map((employee) => [employee.id, {
    normalHours: 0,
    holidayHours: 0,
    overtimePay: 0,
  }]))
  if (!employees.length) return empty

  const monthStart = `${month}-01`
  const nextMonthStart = new Date(`${monthStart}T00:00:00Z`)
  nextMonthStart.setUTCMonth(nextMonthStart.getUTCMonth() + 1)
  const monthEndExclusive = nextMonthStart.toISOString().slice(0, 10)
  const employeeIds = employees.map((employee) => employee.id)

  const [requestsResult, entriesResult, holidaysResult, schedulesResult, calendarResult, salaryHistoryResult] = await Promise.all([
    supabase.from('hr_ot_requests')
      .select('id, employee_id, request_date, ot_start, ot_end, hours')
      .in('employee_id', employeeIds)
      .eq('status', 'approved')
      .gte('request_date', monthStart)
      .lt('request_date', monthEndExclusive),
    supabase.from('hr_time_entries')
      .select('id, employee_id, entry_type, work_date, entry_time')
      .in('employee_id', employeeIds)
      .in('entry_type', ['ot_in', 'ot_out'])
      .gte('work_date', monthStart)
      .lte('work_date', monthEndExclusive)
      .order('entry_time'),
    supabase.from('hr_company_holidays')
      .select('holiday_date')
      .gte('holiday_date', monthStart)
      .lt('holiday_date', monthEndExclusive),
    supabase.from('hr_work_schedules')
      .select('id, work_days, is_default')
      .eq('is_active', true),
    supabase.from('hr_employee_work_calendar')
      .select('employee_id, work_date, day_type')
      .in('employee_id', employeeIds)
      .gte('work_date', monthStart)
      .lt('work_date', monthEndExclusive),
    supabase.from('hr_salary_history')
      .select('employee_id, salary, pay_type, effective_date')
      .in('employee_id', employeeIds)
      .lt('effective_date', monthEndExclusive)
      .order('effective_date', { ascending: false }),
  ])
  throwIfError(requestsResult.error)
  throwIfError(entriesResult.error)
  throwIfError(holidaysResult.error)
  throwIfError(schedulesResult.error)
  throwIfError(calendarResult.error)
  throwIfError(salaryHistoryResult.error)

  const requests = requestsResult.data || []
  const entries = entriesResult.data || []
  const holidayDates = new Set((holidaysResult.data || []).map((row) => row.holiday_date))
  const schedules = schedulesResult.data || []
  const defaultSchedule = schedules.find((schedule) => schedule.is_default) || schedules[0]
  const schedulesById = new Map(schedules.map((schedule) => [schedule.id, schedule]))
  const calendarByEmployeeDate = new Map((calendarResult.data || []).map((row) => [
    `${row.employee_id}:${row.work_date}`,
    row.day_type,
  ]))
  const employeesById = new Map(employees.map((employee) => [employee.id, employee]))
  const salaryHistoryByEmployee = new Map<string, NonNullable<typeof salaryHistoryResult.data>>()
  ;(salaryHistoryResult.data || []).forEach((row) => {
    const rows = salaryHistoryByEmployee.get(row.employee_id) || []
    rows.push(row)
    salaryHistoryByEmployee.set(row.employee_id, rows)
  })
  const entriesByEmployee = new Map<string, typeof entries>()
  entries.forEach((entry) => {
    const rows = entriesByEmployee.get(entry.employee_id) || []
    rows.push(entry)
    entriesByEmployee.set(entry.employee_id, rows)
  })

  const approvedByEmployeeDate = new Map<string, number>()
  requests.forEach((request) => {
    const key = `${request.employee_id}:${request.request_date}`
    const approvedHours = Math.max(0, Number(request.hours) || timeRangeHours(request.ot_start, request.ot_end))
    approvedByEmployeeDate.set(key, (approvedByEmployeeDate.get(key) || 0) + approvedHours)
  })

  const totalsByEmployee = new Map<string, PayrollOvertimeSummary>()
  approvedByEmployeeDate.forEach((approvedHours, key) => {
    const separator = key.indexOf(':')
    const employeeId = key.slice(0, separator)
    const requestDate = key.slice(separator + 1)
    const employee = employeesById.get(employeeId)
    if (!employee) return
    const employeeEntries = entriesByEmployee.get(employeeId) || []
    const otIn = employeeEntries.find((entry) => entry.entry_type === 'ot_in' && entry.work_date === requestDate)
    if (!otIn) return
    const otInTime = new Date(otIn.entry_time).getTime()
    const nextDate = addDays(requestDate, 1)
    const otOut = employeeEntries.find((entry) => {
      if (entry.entry_type !== 'ot_out' || (entry.work_date !== requestDate && entry.work_date !== nextDate)) return false
      const time = new Date(entry.entry_time).getTime()
      return time > otInTime && time - otInTime <= 24 * 60 * 60 * 1000
    })
    if (!otOut) return
    const actualHours = (new Date(otOut.entry_time).getTime() - otInTime) / (60 * 60 * 1000)
    const payableHours = Math.min(actualHours, approvedHours)
    if (payableHours <= 0) return

    const calendarDayType = calendarByEmployeeDate.get(`${employeeId}:${requestDate}`)
    const schedule = (employee.work_schedule_id && schedulesById.get(employee.work_schedule_id)) || defaultSchedule
    const isoWeekday = new Date(`${requestDate}T00:00:00Z`).getUTCDay() || 7
    const scheduledWorkday = (schedule?.work_days || '1,2,3,4,5,6').split(',').includes(String(isoWeekday))
    const compensation = salaryHistoryByEmployee.get(employeeId)?.find((row) => row.effective_date <= requestDate)
    const effectiveContractType = compensation?.pay_type === 'daily'
      ? 'daily'
      : compensation?.pay_type === 'permanent'
        ? 'permanent'
        : employee.contract_type === 'daily' ? 'daily' : 'permanent'
    const isHoliday = holidayDates.has(requestDate)
      || (effectiveContractType !== 'daily' && (calendarDayType === 'weekly_off' || (!calendarDayType && !scheduledWorkday)))
    const pay = calculateOvertimePay({
      salary: Number(compensation?.salary ?? employee.salary) || 0,
      contractType: effectiveContractType,
      normalHours: isHoliday ? 0 : payableHours,
      holidayHours: isHoliday ? payableHours : 0,
    })
    const totals = totalsByEmployee.get(employeeId) || { normalHours: 0, holidayHours: 0, overtimePay: 0 }
    if (isHoliday) totals.holidayHours += payableHours
    else totals.normalHours += payableHours
    totals.overtimePay += pay.overtimePay
    totalsByEmployee.set(employeeId, totals)
  })

  return Object.fromEntries(employees.map((employee) => {
    const totals = totalsByEmployee.get(employee.id) || { normalHours: 0, holidayHours: 0, overtimePay: 0 }
    return [employee.id, {
      normalHours: Math.round(totals.normalHours * 100) / 100,
      holidayHours: Math.round(totals.holidayHours * 100) / 100,
      overtimePay: Math.round(totals.overtimePay * 100) / 100,
    }]
  }))
}

function bangkokMinutes(iso: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0)
  return hour * 60 + minute
}

function timeMinutes(value?: string | null, fallback = 0): number {
  if (!value) return fallback
  const [hour, minute] = value.slice(0, 5).split(':').map(Number)
  return hour * 60 + minute
}

export async function fetchDailyWageSummaries(
  month: string,
  employees: HREmployee[],
): Promise<Record<string, DailyWageSummary>> {
  if (!employees.length) return {}
  const monthStart = `${month}-01`
  const nextMonth = new Date(`${monthStart}T00:00:00Z`)
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
  const monthEndExclusive = nextMonth.toISOString().slice(0, 10)
  const monthEnd = addDays(monthEndExclusive, -1)
  const employeeIds = employees.map((employee) => employee.id)

  const [entriesResult, certificationsResult, holidaysResult, leavesResult, schedulesResult, calendarResult, salaryHistoryResult] = await Promise.all([
    supabase.from('hr_time_entries')
      .select('employee_id, entry_type, work_date, entry_time')
      .in('employee_id', employeeIds)
      .in('entry_type', ['clock_in', 'clock_out'])
      .gte('work_date', monthStart)
      .lt('work_date', monthEndExclusive)
      .order('entry_time'),
    supabase.from('hr_time_certifications')
      .select('employee_id, entry_type, work_date, certified_time')
      .in('employee_id', employeeIds)
      .gte('work_date', monthStart)
      .lt('work_date', monthEndExclusive),
    supabase.from('hr_company_holidays')
      .select('holiday_date, name')
      .gte('holiday_date', monthStart)
      .lt('holiday_date', monthEndExclusive),
    supabase.from('hr_leave_requests')
      .select('employee_id, start_date, end_date, leave_mode, start_time, end_time, status')
      .in('employee_id', employeeIds)
      .in('status', ['approved', 'pending'])
      .lte('start_date', monthEnd)
      .gte('end_date', monthStart),
    supabase.from('hr_work_schedules')
      .select('id, work_start, work_end, is_default')
      .eq('is_active', true),
    supabase.from('hr_employee_work_calendar')
      .select('employee_id, work_date, work_start, work_end, work_schedule_id')
      .in('employee_id', employeeIds)
      .gte('work_date', monthStart)
      .lt('work_date', monthEndExclusive),
    supabase.from('hr_salary_history')
      .select('employee_id, salary, pay_type, effective_date')
      .in('employee_id', employeeIds)
      .lt('effective_date', monthEndExclusive)
      .order('effective_date', { ascending: false }),
  ])
  ;[entriesResult, certificationsResult, holidaysResult, leavesResult, schedulesResult, calendarResult, salaryHistoryResult]
    .forEach((result) => throwIfError(result.error))

  const entries = entriesResult.data || []
  const certifications = certificationsResult.data || []
  const holidayByDate = new Map((holidaysResult.data || []).map((holiday) => [holiday.holiday_date, holiday.name]))
  const leaves = leavesResult.data || []
  const schedules = schedulesResult.data || []
  const defaultSchedule = schedules.find((schedule) => schedule.is_default) || schedules[0]
  const schedulesById = new Map(schedules.map((schedule) => [schedule.id, schedule]))
  const calendarByEmployeeDate = new Map((calendarResult.data || []).map((row) => [`${row.employee_id}:${row.work_date}`, row]))
  const historyByEmployee = new Map<string, NonNullable<typeof salaryHistoryResult.data>>()
  ;(salaryHistoryResult.data || []).forEach((row) => {
    const rows = historyByEmployee.get(row.employee_id) || []
    rows.push(row)
    historyByEmployee.set(row.employee_id, rows)
  })

  const results: Record<string, DailyWageSummary> = {}
  employees.forEach((employee) => {
    const details: DailyWageDetail[] = []
    for (let workDate = monthStart; workDate < monthEndExclusive; workDate = addDays(workDate, 1)) {
      if (employee.hire_date && workDate < employee.hire_date.slice(0, 10)) continue
      if (employee.contract_end_date && workDate > employee.contract_end_date.slice(0, 10)) continue
      const compensation = historyByEmployee.get(employee.id)?.find((row) => row.effective_date <= workDate)
      const payType = compensation?.pay_type || employee.contract_type || 'permanent'
      if (payType !== 'daily') continue
      const dailyRate = Math.max(0, Number(compensation?.salary ?? employee.salary) || 0)
      const holidayName = holidayByDate.get(workDate)
      const leave = leaves.find((row) => row.employee_id === employee.id && row.start_date <= workDate && row.end_date >= workDate)
      const dayEntries = entries.filter((row) => row.employee_id === employee.id && row.work_date === workDate)
      const dayCertifications = certifications.filter((row) => row.employee_id === employee.id && row.work_date === workDate)
      const actualIn = dayEntries.find((row) => row.entry_type === 'clock_in')
      const actualOut = [...dayEntries].reverse().find((row) => row.entry_type === 'clock_out')
      const certifiedIn = dayCertifications.find((row) => row.entry_type === 'clock_in')
      const certifiedOut = dayCertifications.find((row) => row.entry_type === 'clock_out')
      const clockIn = actualIn?.entry_time || certifiedIn?.certified_time || null
      const clockOut = actualOut?.entry_time || certifiedOut?.certified_time || null
      const base = {
        workDate,
        clockIn,
        clockOut,
        clockInSource: actualIn ? 'entry' as const : certifiedIn ? 'certified' as const : null,
        clockOutSource: actualOut ? 'entry' as const : certifiedOut ? 'certified' as const : null,
        dailyRate,
      }

      if (holidayName) {
        details.push({ ...base, status: 'paid_holiday', payableDay: 1, amount: dailyRate, note: `วันหยุดบริษัท: ${holidayName}` })
        continue
      }
      if (leave?.status === 'pending') {
        details.push({ ...base, status: 'unresolved', payableDay: 0, amount: 0, note: 'ใบลายังรออนุมัติ' })
        continue
      }
      if (leave?.status === 'approved') {
        const payableDay = leave.leave_mode === 'hourly' ? 0.5 : 0
        details.push({ ...base, status: 'unpaid_leave', payableDay, amount: dailyRate * payableDay, note: leave.leave_mode === 'hourly' ? 'ลาครึ่งวัน (ไม่จ่ายครึ่งวันที่ลา)' : 'ลาเต็มวันโดยไม่รับค่าจ้าง' })
        continue
      }
      if (!clockIn && !clockOut) {
        details.push({ ...base, status: 'absent', payableDay: 0, amount: 0, note: 'ไม่มีการมาทำงาน' })
        continue
      }
      if (!clockIn || !clockOut) {
        details.push({ ...base, status: 'unresolved', payableDay: 0, amount: 0, note: 'เวลาเข้า–ออกไม่ครบและยังไม่ได้รับรอง' })
        continue
      }

      const calendar = calendarByEmployeeDate.get(`${employee.id}:${workDate}`)
      const schedule = (calendar?.work_schedule_id && schedulesById.get(calendar.work_schedule_id))
        || (employee.work_schedule_id && schedulesById.get(employee.work_schedule_id))
        || defaultSchedule
      const expectedStart = timeMinutes(calendar?.work_start || schedule?.work_start, 8 * 60)
      const expectedEnd = timeMinutes(calendar?.work_end || schedule?.work_end, 17 * 60)
      const midpoint = expectedStart + ((expectedEnd - expectedStart) / 2)
      const payableDay = bangkokMinutes(clockOut) <= midpoint ? 0.5 : 1
      details.push({
        ...base,
        status: payableDay === 0.5 ? 'worked_half' : 'worked_full',
        payableDay,
        amount: dailyRate * payableDay,
        note: payableDay === 0.5 ? 'กลับก่อนครึ่งวัน' : 'มาทำงานและมีเวลาเข้า–ออกครบ',
      })
    }

    results[employee.id] = calculateDailyWageSummary(Number(employee.salary) || 0, details)
  })
  return results
}

export function calculateCappedSavings(input: {
  monthlySavings: number
  openingBalance: number
  priorSavings: number
  maximumBalance?: number | null
}): number {
  const monthlySavings = Math.max(0, Number(input.monthlySavings) || 0)
  if (input.maximumBalance == null) return monthlySavings
  const maximumBalance = Math.max(0, Number(input.maximumBalance) || 0)
  const accumulatedBeforeMonth = Math.max(0, Number(input.openingBalance) || 0)
    + Math.max(0, Number(input.priorSavings) || 0)
  const remaining = Math.max(0, maximumBalance - accumulatedBeforeMonth)
  return Math.round(Math.min(monthlySavings, remaining) * 100) / 100
}

/** กองทุนสงเคราะห์ลูกจ้าง (EWF) = ฐานเงินเดือนรวมเงินพิเศษ × 0.25% */
export function calculateEwf(wage: number): number {
  const eligibleWage = Math.max(0, Number(wage) || 0)
  return Math.round(eligibleWage * 0.0025 * 100) / 100
}

/** EMP00001 is exempt; other employees follow their company's EWF setting. */
export function calculateEmployeeEwf(employeeCode: string, wage: number, ewfEnabled = true): number {
  if (!ewfEnabled || employeeCode.trim().toUpperCase() === 'EMP00001') return 0
  return calculateEwf(wage)
}

function throwIfError(error: { message: string } | null) {
  if (error) throw new Error(error.message)
}

export async function fetchHRCompanies(includeInactive = false): Promise<HRCompany[]> {
  let query = supabase.from('hr_companies').select('*').order('sort_order').order('name_th')
  if (!includeInactive) query = query.eq('is_active', true)
  const { data, error } = await query
  throwIfError(error)
  return (data || []) as HRCompany[]
}

export async function reorderHRCompanies(companyIds: string[]): Promise<void> {
  const { error } = await supabase.rpc('reorder_hr_companies', { p_company_ids: companyIds })
  throwIfError(error)
}

export async function fetchSocialSecuritySettings(): Promise<SocialSecuritySettings> {
  const { data, error } = await supabase
    .from('hr_social_security_settings')
    .select('*')
    .eq('id', true)
    .maybeSingle()
  throwIfError(error)
  if (!data) return DEFAULT_SOCIAL_SECURITY_SETTINGS
  return {
    ...data,
    contribution_rate: Number(data.contribution_rate),
    maximum_wage_base: Number(data.maximum_wage_base),
  } as SocialSecuritySettings
}

export async function upsertSocialSecuritySettings(
  settings: Pick<SocialSecuritySettings, 'contribution_rate' | 'maximum_wage_base'>,
  userId?: string,
): Promise<SocialSecuritySettings> {
  const { data, error } = await supabase
    .from('hr_social_security_settings')
    .upsert({
      id: true,
      ...settings,
      updated_at: new Date().toISOString(),
      updated_by: userId || null,
    })
    .select()
    .single()
  throwIfError(error)
  return {
    ...data,
    contribution_rate: Number(data.contribution_rate),
    maximum_wage_base: Number(data.maximum_wage_base),
  } as SocialSecuritySettings
}

export function calculateSocialSecurity(
  wage: number,
  settings: Pick<SocialSecuritySettings, 'contribution_rate' | 'maximum_wage_base'>,
): number {
  const contributionWage = Math.min(Math.max(0, Number(wage) || 0), settings.maximum_wage_base)
  return Math.round(contributionWage * settings.contribution_rate) / 100
}

export async function upsertHRCompany(company: Partial<HRCompany>): Promise<HRCompany> {
  const payload = { ...company, updated_at: new Date().toISOString() }
  const result = company.id
    ? await supabase.from('hr_companies').update(payload).eq('id', company.id).select().single()
    : await supabase.from('hr_companies').insert(payload).select().single()
  throwIfError(result.error)
  return result.data as HRCompany
}

export async function uploadHRCompanyPng(companyKey: string, kind: 'logo' | 'signature', file: File): Promise<string> {
  if (file.type !== 'image/png' && !file.name.toLowerCase().endsWith('.png')) throw new Error('รองรับเฉพาะไฟล์ PNG')
  if (file.size > 5 * 1024 * 1024) throw new Error('ไฟล์ต้องมีขนาดไม่เกิน 5 MB')
  const safeKey = companyKey.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  const path = `${safeKey}/${kind}_${Date.now()}.png`
  const { error } = await supabase.storage.from('hr-company-assets').upload(path, file, { contentType: 'image/png', upsert: false })
  throwIfError(error)
  return supabase.storage.from('hr-company-assets').getPublicUrl(path).data.publicUrl
}

export async function deleteHRCompanyAsset(publicUrl: string): Promise<void> {
  const marker = '/storage/v1/object/public/hr-company-assets/'
  const pathname = new URL(publicUrl).pathname
  const markerIndex = pathname.indexOf(marker)
  // URLs outside the managed bucket have no Storage object that this app can delete.
  if (markerIndex < 0) return
  const objectPath = decodeURIComponent(pathname.slice(markerIndex + marker.length))
  if (!objectPath) return
  const { error } = await supabase.storage.from('hr-company-assets').remove([objectPath])
  throwIfError(error)
}

export async function fetchPayrollEmployees(companyId: string): Promise<HREmployee[]> {
  const { data, error } = await supabase
    .from('hr_employees')
    .select('*, department:hr_departments!department_id(*), position:hr_positions!position_id(*), company:hr_companies!company_id(*)')
    .eq('company_id', companyId)
    .in('employment_status', ['active', 'probation'])
    .order('employee_code')
  throwIfError(error)
  return (data || []) as HREmployee[]
}

export async function fetchConfirmedLeaveDeductions(month: string): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from('hr_leave_payroll_deductions')
    .select('employee_id, deduction_amount, status')
    .eq('payroll_month', `${month}-01`)
    .in('status', ['confirmed', 'sent'])
  throwIfError(error)
  return Object.fromEntries((data || []).map((row) => [row.employee_id, Number(row.deduction_amount) || 0]))
}

export async function fetchPayrollRun(month: string, companyId: string, payrollType: 'permanent' | 'daily' = 'permanent'): Promise<PayrollRun | null> {
  const { data, error } = await supabase
    .from('hr_payroll_runs')
    .select('*, company:hr_companies!company_id(*), items:hr_payroll_items(*)')
    .eq('payroll_month', `${month}-01`)
    .eq('company_id', companyId)
    .eq('payroll_type', payrollType)
    .maybeSingle()
  throwIfError(error)
  return data as PayrollRun | null
}

export async function savePayrollRun(input: {
  month: string
  company: HRCompany
  paymentDate: string
  items: PayrollItem[]
  confirm: boolean
  userId?: string
  payrollType?: 'permanent' | 'daily'
}): Promise<PayrollRun> {
  const runPayload = {
    payroll_month: `${input.month}-01`,
    company_id: input.company.id,
    payroll_type: input.payrollType || 'permanent',
    payment_date: input.paymentDate || null,
    status: input.confirm ? 'confirmed' : 'draft',
    confirmed_by: input.confirm ? input.userId || null : null,
    confirmed_at: input.confirm ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }
  const { data: run, error: runError } = await supabase
    .from('hr_payroll_runs')
    .upsert(runPayload, { onConflict: 'payroll_month,company_id,payroll_type' })
    .select()
    .single()
  throwIfError(runError)

  if (input.items.length) {
    const rows = input.items.map((item) => {
      // Generated and server-managed columns must be absent from the INSERT
      // payload. Sending them as undefined can still become a non-DEFAULT
      // value after PostgREST serialization.
      const editable = { ...item } as PayrollItem & { created_at?: string; updated_at?: string }
      delete editable.id
      delete editable.payroll_run_id
      delete editable.gross_income
      delete editable.total_deduction
      delete editable.net_pay
      delete editable.created_at
      delete editable.updated_at
      return {
        ...editable,
        payroll_run_id: run.id,
        company_snapshot: input.company,
      }
    })
    // Write first so an INSERT/UPDATE failure never destroys the last saved
    // draft. The unique key keeps one row per employee in a payroll run.
    const { error: itemError } = await supabase.from('hr_payroll_items')
      .upsert(rows, { onConflict: 'payroll_run_id,employee_id' })
    throwIfError(itemError)

    // Remove employees no longer present only after every new row is safe.
    const employeeIds = input.items.map((item) => item.employee_id)
    const { error: deleteError } = await supabase.from('hr_payroll_items')
      .delete()
      .eq('payroll_run_id', run.id)
      .not('employee_id', 'in', `(${employeeIds.join(',')})`)
    throwIfError(deleteError)
  }
  return (await fetchPayrollRun(input.month, input.company.id, input.payrollType || 'permanent')) as PayrollRun
}

export async function fetchPayrollHistory(companyId?: string, payrollType?: 'permanent' | 'daily'): Promise<PayrollRun[]> {
  let query = supabase
    .from('hr_payroll_runs')
    .select('*, company:hr_companies!company_id(*), items:hr_payroll_items(*)')
    .eq('status', 'confirmed')
    .order('payroll_month', { ascending: false })
  if (companyId) query = query.eq('company_id', companyId)
  if (payrollType) query = query.eq('payroll_type', payrollType)
  const { data, error } = await query
  throwIfError(error)
  return (data || []) as PayrollRun[]
}
