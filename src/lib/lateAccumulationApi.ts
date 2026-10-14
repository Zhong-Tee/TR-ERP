import { supabase } from './supabase'

export type LateWarningLevel = 'verbal' | 'written_1' | 'final' | 'termination_review'
export const lateLevelLabels: Record<LateWarningLevel, string> = {
  verbal: 'เตือนด้วยวาจา', written_1: 'หนังสือเตือนครั้งที่ 1',
  final: 'เตือนครั้งสุดท้าย', termination_review: 'เสนอพิจารณาทางวินัยถึงขั้นเลิกจ้าง',
}
export interface LateIncident {
  employee_id: string
  work_date: string
  occurred_at: string
  expected_min: number
  actual_min: number
  late_min: number
  status: 'included' | 'exempt' | 'pending'
  reason: string | null
}
export interface LateAccumulationRow {
  employee_id: string
  employee_code: string
  employee_name: string
  department_name: string | null
  late_count: number
  late_minutes: number
  last_late_date: string | null
  clean_days: number
  current_level: LateWarningLevel | null
  next_level: LateWarningLevel
  effective_until: string | null
  pending_warning_id: string | null
  pending_case_number: string | null
  pending_status: string | null
  pending_emergency_count: number
  review_required: boolean
  eligible: boolean
  incidents: LateIncident[]
  history: LateIncident[]
}
export interface LateAccumulationData {
  start_date: string
  settings_locked: boolean
  ready_count: number
  rows: LateAccumulationRow[]
}

export const LATE_CHANGED_EVENT = 'hr-late-accumulation-changed'
export function notifyLateChanged() { window.dispatchEvent(new Event(LATE_CHANGED_EVENT)) }

export async function fetchLateAccumulation(): Promise<LateAccumulationData> {
  const { data, error } = await supabase.rpc('hr_late_accumulation')
  if (error) throw new Error(error.message)
  const result = data as LateAccumulationData
  const employeeIds = result.rows.map(row => row.employee_id)
  const batches: string[][] = []
  for (let offset = 0; offset < employeeIds.length; offset += 200) {
    batches.push(employeeIds.slice(offset, offset + 200))
  }
  const employees = await Promise.all(batches.map(async ids => {
    const { data: names, error: namesError } = await supabase.from('hr_employees')
      .select('id,nickname').in('id', ids)
    if (namesError) throw new Error(namesError.message)
    return names ?? []
  }))
  const nicknames = new Map(employees.flat().map(employee => [employee.id, employee.nickname?.trim()]))
  return {
    ...result,
    rows: result.rows.map(row => {
      const nickname = nicknames.get(row.employee_id)
      return { ...row, employee_name: nickname ? `${row.employee_name} (${nickname})` : row.employee_name }
    }),
  }
}
export async function saveLateStartDate(startDate: string) {
  const { error } = await supabase.rpc('hr_late_set_start_date', { p_start: startDate })
  if (error) throw new Error(error.message)
  notifyLateChanged()
}
export async function createLateWarning(employeeId: string): Promise<string> {
  const { data, error } = await supabase.rpc('hr_late_create_warning', { p_employee: employeeId })
  if (error) throw new Error(error.message)
  notifyLateChanged()
  return data as string
}
export async function setLateException(employeeId: string, date: string, exempt: boolean, reason: string) {
  const { error } = await supabase.rpc('hr_late_set_exception', {
    p_employee: employeeId, p_date: date, p_exempt: exempt, p_reason: reason,
  })
  if (error) throw new Error(error.message)
  notifyLateChanged()
}
export async function reviewLateWarning(warningId: string) {
  const { error } = await supabase.rpc('hr_late_review_warning', { p_warning: warningId })
  if (error) throw new Error(error.message)
  notifyLateChanged()
}
