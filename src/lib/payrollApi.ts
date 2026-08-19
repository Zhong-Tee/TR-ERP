import { supabase } from './supabase'
import type { HRCompany, HREmployee } from '../types'

export interface PayrollItem {
  id?: string
  payroll_run_id?: string
  employee_id: string
  employee_code: string
  employee_name: string
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
  savings_opening_balance: number
  company_loan_opening_balance: number
  company_loan_opening_installments: number
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

  const { error: deleteError } = await supabase.from('hr_payroll_items').delete().eq('payroll_run_id', run.id)
  throwIfError(deleteError)
  if (input.items.length) {
    const rows = input.items.map((item) => ({
      ...item,
      id: undefined,
      payroll_run_id: run.id,
      company_snapshot: input.company,
      gross_income: undefined,
      total_deduction: undefined,
      net_pay: undefined,
    }))
    const { error: itemError } = await supabase.from('hr_payroll_items').insert(rows)
    throwIfError(itemError)
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
