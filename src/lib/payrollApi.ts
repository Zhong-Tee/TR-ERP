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
  personal_tax: number
  social_security: number
  savings: number
  student_loan: number
  company_loan: number
  leave_deduction: number
  other_income: number
  other_deduction: number
  income_opening_balance: number
  personal_tax_opening_balance: number
  social_security_opening_balance: number
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
  status: 'draft' | 'confirmed'
  payment_date?: string | null
  confirmed_by?: string | null
  confirmed_at?: string | null
  company?: HRCompany
  items?: PayrollItem[]
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

function throwIfError(error: { message: string } | null) {
  if (error) throw new Error(error.message)
}

export async function fetchHRCompanies(includeInactive = false): Promise<HRCompany[]> {
  let query = supabase.from('hr_companies').select('*').order('name_th')
  if (!includeInactive) query = query.eq('is_active', true)
  const { data, error } = await query
  throwIfError(error)
  return (data || []) as HRCompany[]
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

export async function fetchPayrollRun(month: string, companyId: string): Promise<PayrollRun | null> {
  const { data, error } = await supabase
    .from('hr_payroll_runs')
    .select('*, company:hr_companies!company_id(*), items:hr_payroll_items(*)')
    .eq('payroll_month', `${month}-01`)
    .eq('company_id', companyId)
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
}): Promise<PayrollRun> {
  const runPayload = {
    payroll_month: `${input.month}-01`,
    company_id: input.company.id,
    payment_date: input.paymentDate || null,
    status: input.confirm ? 'confirmed' : 'draft',
    confirmed_by: input.confirm ? input.userId || null : null,
    confirmed_at: input.confirm ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }
  const { data: run, error: runError } = await supabase
    .from('hr_payroll_runs')
    .upsert(runPayload, { onConflict: 'payroll_month,company_id' })
    .select()
    .single()
  throwIfError(runError)

  if (input.items.length) {
    const rows = input.items.map((item) => {
      // Generated and server-managed columns must be absent from the INSERT
      // payload. Sending them as undefined can still become a non-DEFAULT
      // value after PostgREST serialization.
      const {
        id: _id,
        payroll_run_id: _payrollRunId,
        gross_income: _grossIncome,
        total_deduction: _totalDeduction,
        net_pay: _netPay,
        created_at: _createdAt,
        updated_at: _updatedAt,
        ...editable
      } = item as PayrollItem & { created_at?: string; updated_at?: string }
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
  return (await fetchPayrollRun(input.month, input.company.id)) as PayrollRun
}

export async function fetchPayrollHistory(companyId?: string): Promise<PayrollRun[]> {
  let query = supabase
    .from('hr_payroll_runs')
    .select('*, company:hr_companies!company_id(*), items:hr_payroll_items(*)')
    .eq('status', 'confirmed')
    .order('payroll_month', { ascending: false })
  if (companyId) query = query.eq('company_id', companyId)
  const { data, error } = await query
  throwIfError(error)
  return (data || []) as PayrollRun[]
}
