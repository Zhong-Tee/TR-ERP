import { supabase } from './supabase'
import type { HRCompany, HREmployee } from '../types'
import { fetchAllSupabasePages } from './supabasePagination'
import {
  calculateEmployeeEwf, calculateEmployeeSocialSecurity, calculateCappedSavings, calculateDailyWageSummary,
  fetchDailyWageSummaries, fetchMonthlyWageSummaries, fetchPayrollLeaveDeductions, fetchPayrollOvertime,
  fetchSocialSecuritySettings, isEmployeeSocialSecurityEnabled, type PayrollItem, type PayrollRun, type PayrollType,
} from './payrollApi'
import { DEFAULT_PAY_SCHEDULE_ID, FINANCIAL_FIELDS, daysBetween, distributeCents, lastDateOfMonth, monthlyDailyAmounts, roundMoney, scheduleOnDate, shiftDate, type FinancialField, type PayPeriod, type PaySchedule, type PayScheduleAssignment } from './payrollSchedule'
import type { PayrollYtd } from '../components/account/pdf/PayrollSlipPDF'

export interface PayrollPayment {
  id: string; payroll_item_id: string | null; adjustment_id: string | null; employee_id: string; amount: number
  batch_id: string; snapshot: Record<string, unknown>
  batch?: { paid_date: string; channel: string; reference: string; evidence_url: string | null; created_at: string; created_by: string }
}
export interface PayrollAdjustment {
  id: string; source_item_id: string; employee_id: string; company_id: string; earning_month: string; reason: string
  previous_amounts: Record<FinancialField, number>; corrected_amounts: Record<FinancialField, number>; deltas: Record<FinancialField, number>
  income_delta: number; deduction_delta: number; net_delta: number; status: 'approved' | 'cancelled'; created_at: string
  source?: PayrollItem
}
export interface MonthlyAllocation { payroll_item_id: string; payroll_run_id: string; employee_id: string; earning_month: string; amounts: Record<string, number> }
const check=(error: { message: string } | null)=>{ if(error) throw new Error(error.message) }
export async function fetchPaySchedules(companyId?: string): Promise<PaySchedule[]> {
  const { data,error }=await supabase.from('hr_pay_schedules').select('*').order('created_at')
  check(error)
  return ((data || []) as PaySchedule[]).filter(row=>!companyId || !row.company_id || row.company_id===companyId)
}
export async function savePaySchedule(schedule: Partial<PaySchedule>): Promise<PaySchedule> {
  const { id,...payload }=schedule
  const query=id ? supabase.from('hr_pay_schedules').update(payload).eq('id',id) : supabase.from('hr_pay_schedules').insert(payload)
  const { data,error }=await query.select('*').single(); check(error); return data as PaySchedule
}
export async function fetchPeriodRun(companyId: string,kind: PayrollType,schedule: PaySchedule,period: PayPeriod): Promise<PayrollRun | null> {
  let query=supabase.from('hr_payroll_runs').select('*, company:hr_companies!company_id(*), items:hr_payroll_items(*)').eq('company_id',companyId).eq('payroll_type',kind)
  const legacy=schedule.id===DEFAULT_PAY_SCHEDULE_ID && period.start.endsWith('-01') && period.end===lastDateOfMonth(period.start.slice(0,7))
  query=legacy ? query.is('schedule_id',null).eq('payroll_month',period.start) : query.eq('schedule_id',schedule.id).eq('period_start',period.start).eq('period_end',period.end)
  const { data,error }=await query.maybeSingle(); check(error); return data as PayrollRun | null
}
export async function fetchPeriodHistory(companyId: string): Promise<PayrollRun[]> {
  return fetchAllSupabasePages<PayrollRun>((from,to)=>supabase.from('hr_payroll_runs')
    .select('*, company:hr_companies!company_id(*), items:hr_payroll_items(*)').eq('company_id',companyId)
    .order('payroll_month',{ascending:false}).order('id').range(from,to))
}
export async function fetchPayrollPayments(companyId: string): Promise<PayrollPayment[]> {
  return fetchAllSupabasePages<PayrollPayment>((from,to)=>supabase.from('hr_payroll_payments')
    .select('*, batch:hr_payroll_payment_batches!batch_id(paid_date,channel,reference,evidence_url,created_at,created_by)')
    .eq('company_id',companyId).order('id').range(from,to))
}
export async function fetchPayrollAdjustments(companyId: string): Promise<PayrollAdjustment[]> {
  return fetchAllSupabasePages<PayrollAdjustment>((from,to)=>supabase.from('hr_payroll_adjustments').select('*, source:hr_payroll_items!source_item_id(*)')
    .eq('company_id',companyId).order('created_at',{ascending:false}).order('id').range(from,to))
}
export async function recordPayrollPayment(input: { requestKey: string; runId: string | null; items: { id: string; net_pay: number }[]; adjustmentIds?: string[]; paidDate: string; channel: string; reference: string; evidenceUrl?: string }) {
  const { data,error }=await supabase.rpc('hr_record_payroll_payment',{
    p_request:input.requestKey,p_run:input.runId,p_items:input.items,p_adjustments:input.adjustmentIds || [],p_paid_date:input.paidDate,
    p_channel:input.channel,p_reference:input.reference.trim(),p_evidence_url:input.evidenceUrl?.trim() || null,
  });check(error);return data as { batch: { id: string }; payments: PayrollPayment[] }
}
export async function createPayrollAdjustment(requestKey: string,itemId: string,corrected: Record<FinancialField,number>,reason: string,expectedPrevious?: Record<FinancialField,number>): Promise<PayrollAdjustment> {
  const { data,error }=await supabase.rpc('hr_create_payroll_adjustment',{p_request:requestKey,p_source:itemId,p_corrected:corrected,p_reason:reason.trim(),p_expected_previous:expectedPrevious||null});check(error);return data as PayrollAdjustment
}
export async function cancelPayrollAdjustment(id: string,reason: string): Promise<void> {
  const { error }=await supabase.rpc('hr_cancel_payroll_adjustment',{p_adjustment:id,p_reason:reason.trim()});check(error)
}
export async function changePayrollRun(runId: string,reason: string,cancel=false): Promise<void> {
  const { error }=await supabase.rpc(cancel?'hr_cancel_payroll':'hr_reopen_payroll',{p_run:runId,p_reason:reason.trim()});check(error)
}
export function financialValues(item: Partial<PayrollItem>): Record<FinancialField,number> {
  return Object.fromEntries(FINANCIAL_FIELDS.map(key=>[key,Number(item[key] || 0)])) as Record<FinancialField,number>
}
export function setPeriodManualAmount(item: PayrollItem,key: 'other_income' | 'other_deduction',amount: number): PayrollItem {
  const allocations=structuredClone(item.deduction_allocations || {})
  const months=Object.keys(allocations).sort()
  const weights=months.map(month=>item.earning_dates?.filter(date=>date.startsWith(month)).length || 1)
  const values=distributeCents(amount,weights)
  months.forEach((month,index)=>{allocations[month][key]=values[index]})
  return {...item,[key]:amount,deduction_allocations:allocations,reviewed_at:null,reviewed_by:null}
}

export async function buildScheduledPayroll(company: HRCompany,kind: PayrollType,schedule: PaySchedule,period: PayPeriod,existing: PayrollRun | null): Promise<{ items: PayrollItem[]; reservedCount: number }> {
  if(existing?.status==='confirmed') return {items:existing.items || [],reservedCount:0}
  const { data: rawEmployees,error: employeeError }=await supabase.from('hr_employees').select('*, department:hr_departments!department_id(*), position:hr_positions!position_id(*)').eq('company_id',company.id)
  check(employeeError)
  const employees=((rawEmployees || []) as HREmployee[]).filter(employee=>(['active','probation'].includes(employee.employment_status) || !!employee.contract_end_date)
    && (!employee.hire_date || employee.hire_date<=period.end) && (!employee.contract_end_date || employee.contract_end_date>=period.start)
    && (kind==='daily' || isEmployeeSocialSecurityEnabled(employee)===(kind==='permanent')))
  if(!employees.length) return {items:[],reservedCount:0}
  const ids=employees.map(employee=>employee.id)
  const [assignments,reservations,allocations,settings]=await Promise.all([
    fetchAllSupabasePages<PayScheduleAssignment>((from,to)=>supabase.from('hr_employee_pay_schedule_history').select('*').in('employee_id',ids).lte('effective_date',period.end).order('effective_date',{ascending:false}).order('created_at',{ascending:false}).order('id').range(from,to)),
    fetchAllSupabasePages<{employee_id:string;work_date:string;payroll_run_id:string}>((from,to)=>supabase.from('hr_payroll_wage_reservations').select('employee_id,work_date,payroll_run_id').eq('company_id',company.id).in('employee_id',ids).gte('work_date',period.start).lte('work_date',period.end).order('employee_id').order('work_date').range(from,to)),
    fetchAllSupabasePages<MonthlyAllocation>((from,to)=>supabase.from('hr_payroll_effective_monthly_allocations').select('*').eq('company_id',company.id).in('employee_id',ids).order('employee_id').order('earning_month').order('allocation_key').range(from,to)),
    fetchSocialSecuritySettings(),
  ])
  const blocked=new Set(reservations.filter(row=>row.payroll_run_id!==existing?.id).map(row=>`${row.employee_id}:${row.work_date}`))
  let reservedCount=0
  const months=[...new Set(daysBetween(period.start,period.end).map(date=>date.slice(0,7)))]
  const byEmployee=new Map<string,PayrollItem>()
  for(const month of months) {
    const [monthly,daily,leave]=await Promise.all([fetchMonthlyWageSummaries(month,employees),fetchDailyWageSummaries(month,employees),fetchPayrollLeaveDeductions(month,employees)])
    const eligible: Record<string,string[]>={}
    for(const employee of employees) {
      const candidateDates=kind==='daily' ? (daily[employee.id]?.details || []).map(detail=>detail.workDate)
        : monthlyDailyAmounts(monthly[employee.id]?.details || []).map(detail=>detail.date)
      eligible[employee.id]=candidateDates.filter(date=>{
        if(date<period.start || date>period.end || scheduleOnDate(employee.id,date,assignments)!==schedule.id) return false
        if(blocked.has(`${employee.id}:${date}`)) { reservedCount++;return false }
        return true
      })
    }
    const overtime=await fetchPayrollOvertime(month,employees,kind==='daily'?'daily':'permanent',eligible)
    for(const employee of employees) {
      const dates=eligible[employee.id]
      if(!dates.length) continue
      const chosen=new Set(dates)
      const monthlyDays=monthlyDailyAmounts(monthly[employee.id]?.details || []).filter(day=>chosen.has(day.date))
      const dailyDays=(daily[employee.id]?.details || []).filter(day=>chosen.has(day.workDate))
      const dailySummary=calculateDailyWageSummary(dailyDays.at(-1)?.dailyRate || 0,dailyDays)
      const base=kind==='daily'?dailySummary.regularPay:roundMoney(monthlyDays.reduce((sum,day)=>sum+day.salary,0))
      const allowance=kind==='daily'?0:roundMoney(monthlyDays.reduce((sum,day)=>sum+day.allowance,0))
      const previous=allocations.filter(row=>row.employee_id===employee.id && row.payroll_item_id!==existing?.items?.find(item=>item.employee_id===employee.id)?.id)
      const previousMonth=previous.filter(row=>row.earning_month.slice(0,7)===month)
      const sum=(key:string,rows=previousMonth)=>rows.reduce((value,row)=>value+Number(row.amounts[key] || 0),0)
      const monthFirst=`${month}-01`, monthLast=lastDateOfMonth(month)
      const employmentDates=daysBetween(monthFirst,monthLast).filter(date=>(!employee.hire_date || date>=employee.hire_date) && (!employee.contract_end_date || date<=employee.contract_end_date))
      const lastDue=chosen.has(employmentDates.at(-1) || monthLast)
      const fraction=employmentDates.length ? dates.length/employmentDates.length : 0
      const due=(target:number,previousAmount:number)=>Math.max(0,roundMoney(Math.min(Math.max(0,target-previousAmount),lastDue?target-previousAmount:schedule.deduction_policy==='proportional'?target*fraction:0)))
      const socialTarget=calculateEmployeeSocialSecurity(employee,sum('base_salary')+base,settings)
      const social=(lastDue || schedule.deduction_policy==='proportional') ? Math.max(0,roundMoney(socialTarget-sum('social_security'))) : 0
      const ewfTarget=calculateEmployeeEwf(employee.employee_code,sum('base_salary')+sum('position_allowance')+base+allowance,company.ewf_enabled!==false)
      const ewf=(lastDue || schedule.deduction_policy==='proportional') ? Math.max(0,roundMoney(ewfTarget-sum('ewf'))) : 0
      const savingsTarget=calculateCappedSavings({monthlySavings:Number(employee.monthly_savings)||0,openingBalance:Number(employee.savings_opening_balance)||0,
        priorSavings:sum('savings',previous.filter(row=>row.earning_month.slice(0,7)<month)),maximumBalance:employee.savings_maximum})
      const loanRemaining=Math.max(0,Number(employee.company_loan_opening_balance || 0)-sum('company_loan',previous))
      const money: Record<FinancialField,number>={base_salary:base,position_allowance:allowance,overtime_pay:overtime[employee.id]?.overtimePay || 0,other_income:0,
        personal_tax:due(Number(employee.monthly_personal_tax)||0,sum('personal_tax')),social_security:social,ewf,
        savings:due(savingsTarget,sum('savings')),student_loan:due(Number(employee.monthly_student_loan)||0,sum('student_loan')),
        company_loan:due(Math.min(Number(employee.monthly_company_loan)||0,loanRemaining+sum('company_loan')),sum('company_loan')),
        leave_deduction:kind!=='daily' && lastDue ? Math.max(0,roundMoney((leave[employee.id]||0)-sum('leave_deduction'))) : 0,other_deduction:0}
      let item=byEmployee.get(employee.id)
      if(!item) {
        item={employee_id:employee.id,employee_code:employee.employee_code,employee_name:`${employee.prefix || ''}${employee.first_name} ${employee.last_name}`.trim(),employee_nickname:employee.nickname,
          department_position:[employee.department?.name,employee.position?.name].filter(Boolean).join(' / '),pay_type:kind==='daily'?'daily':'permanent',social_security_enabled:isEmployeeSocialSecurityEnabled(employee),
          ...financialValues({}),ot_normal_hours:0,ot_holiday_hours:0,
          income_opening_balance:Number(employee.income_opening_balance)||0,personal_tax_opening_balance:Number(employee.personal_tax_opening_balance)||0,social_security_opening_balance:Number(employee.social_security_opening_balance)||0,
          ewf_opening_balance:Number(employee.ewf_opening_balance)||0,student_loan_opening_balance:Number(employee.student_loan_opening_balance)||0,savings_opening_balance:Number(employee.savings_opening_balance)||0,
          company_loan_opening_balance:Number(employee.company_loan_opening_balance)||0,company_loan_opening_installments:Number(employee.company_loan_opening_installments)||0,
          earning_dates:[],deduction_allocations:{},daily_wage_details:[],monthly_wage_details:[],monthly_payable_days:0,full_days:0,half_days:0,paid_holiday_days:0,unpaid_leave_days:0,payable_days:0,unresolved_attendance_days:0,
        } as PayrollItem
        byEmployee.set(employee.id,item)
      }
      for(const key of FINANCIAL_FIELDS) item[key]=roundMoney(Number(item[key]||0)+money[key])
      item.ot_normal_hours+=overtime[employee.id]?.normalHours || 0;item.ot_holiday_hours+=overtime[employee.id]?.holidayHours || 0
      item.earning_dates!.push(...dates);item.deduction_allocations![month]=money
      if(kind==='daily') {
        item.daily_rate=dailySummary.dailyRate;item.daily_wage_details!.push(...dailyDays)
        item.full_days!+=dailySummary.fullDays;item.half_days!+=dailySummary.halfDays;item.paid_holiday_days!+=dailySummary.paidHolidayDays
        item.unpaid_leave_days!+=dailySummary.unpaidLeaveDays;item.payable_days!+=dailySummary.payableDays;item.unresolved_attendance_days!+=dailySummary.unresolvedDays
      } else {
        item.monthly_rate=monthlyDays.at(-1)?.rate || 0
        const details=monthlyDays.map(day=>({startDate:day.date,endDate:day.date,monthlyRate:day.rate,positionAllowance:0,calendarDays:1,payableDays:day.rate?day.salary/day.rate*30:1,amount:day.salary,allowanceAmount:day.allowance}))
        item.monthly_wage_details!.push(...details);item.monthly_payable_days=roundMoney(Number(item.monthly_payable_days)+details.reduce((sum,detail)=>sum+detail.payableDays,0))
      }
    }
  }
  const saved=new Map((existing?.items || []).map(item=>[item.employee_id,item]))
  for(const item of byEmployee.values()) {
    const old=saved.get(item.employee_id)
    if(old) {
      Object.assign(item,setPeriodManualAmount(item,'other_income',Number(old.other_income)||0))
      Object.assign(item,setPeriodManualAmount(item,'other_deduction',Number(old.other_deduction)||0))
      const unchanged=FINANCIAL_FIELDS.every(key=>Number(item[key])===Number(old[key])) && JSON.stringify(item.earning_dates)===JSON.stringify(old.earning_dates)
      item.id=old.id;item.payroll_run_id=old.payroll_run_id;item.reviewed_at=unchanged?old.reviewed_at:null;item.reviewed_by=unchanged?old.reviewed_by:null
    }
  }
  return {items:[...byEmployee.values()].sort((a,b)=>a.employee_code.localeCompare(b.employee_code,'en',{numeric:true})),reservedCount}
}

export async function fetchPayHolidays(month:string): Promise<Set<string>> {
  const { data,error }=await supabase.from('hr_company_holidays').select('holiday_date').gte('holiday_date',shiftDate(`${month}-01`,-31)).lte('holiday_date',shiftDate(lastDateOfMonth(month),62))
  check(error);return new Set((data || []).map(row=>row.holiday_date as string))
}

export async function payrollFinancialYtd(companyId:string,item:PayrollItem,cutoffMonth:string,draft=false):Promise<PayrollYtd> {
  const allocations=await fetchAllSupabasePages<MonthlyAllocation>((from,to)=>supabase.from('hr_payroll_effective_monthly_allocations').select('*')
    .eq('company_id',companyId).eq('employee_id',item.employee_id).lte('earning_month',`${cutoffMonth}-01`).order('earning_month').order('allocation_key').range(from,to))
  const rows=allocations.filter(row=>!draft||row.payroll_item_id!==item.id).map(row=>({month:row.earning_month.slice(0,7),amounts:row.amounts}))
  if(draft) for(const [month,amounts] of Object.entries(item.deduction_allocations||{[cutoffMonth]:financialValues(item)})) if(month<=cutoffMonth)rows.push({month,amounts})
  const sum=(key:string,yearOnly=true)=>rows.filter(row=>!yearOnly||row.month.startsWith(cutoffMonth.slice(0,4))).reduce((value,row)=>value+Number(row.amounts[key]||0),0)
  return {income:Number(item.income_opening_balance||0)+sum('base_salary')+sum('position_allowance')+sum('overtime_pay')+sum('other_income'),
    personalTax:Number(item.personal_tax_opening_balance||0)+sum('personal_tax'),socialSecurity:Number(item.social_security_opening_balance||0)+sum('social_security'),
    ewf:Number(item.ewf_opening_balance||0)+sum('ewf'),studentLoan:Number(item.student_loan_opening_balance||0)+sum('student_loan'),companyLoan:sum('company_loan'),
    accumulatedSavings:Number(item.savings_opening_balance||0)+sum('savings',false),companyLoanBalance:Math.max(0,Number(item.company_loan_opening_balance||0)-sum('company_loan',false)),
    companyLoanInstallments:Math.max(0,Number(item.company_loan_opening_installments||0)-rows.filter(row=>Number(row.amounts.company_loan)>0).length)}
}
