import { supabase } from './supabase'
import type {
  HRDepartment, HRPosition, HREmployee, HRLeaveType, HRLeaveRequest,
  HRLeaveBalance, HRCandidate, HRInterview, HRInterviewScore,
  HRAttendanceUpload, HRAttendanceSummary, HRAttendanceDaily,
  HRContractTemplate, HRContract, HRDocumentCategory, HRDocument,
  HRExam, HRExamResult, HROnboardingTemplate, HROnboardingPlan,
  HROnboardingProgress, HRCareerTrack, HRCareerLevel, HREmployeeCareer,
  HRNotification, HRNotificationSettings,
  HRWarning, HRCertificate,
} from '../types'
import * as XLSX from 'xlsx'

function pgError(e: unknown): never {
  if (e instanceof Error) throw e
  const msg = typeof e === 'object' && e !== null && 'message' in e
    ? String((e as any).message)
    : typeof e === 'string' ? e : 'Unknown error'
  throw new Error(msg)
}

// ─── Dashboard RPC ──────────────────────────────────────────────────────────

export async function getHRDashboard(employeeId?: string) {
  const { data, error } = await supabase.rpc('get_hr_dashboard', {
    p_employee_id: employeeId ?? null,
  })
  if (error) pgError(error)
  return data as {
    total_employees: number
    pending_leaves: number
    today_on_leave: number
    upcoming_interviews: number
    active_onboarding: number
    unread_notifications: number
  }
}

// ─── Departments ────────────────────────────────────────────────────────────

export async function fetchDepartments() {
  const { data, error } = await supabase
    .from('hr_departments').select('*').order('name')
  if (error) pgError(error)
  return data as HRDepartment[]
}

export async function upsertDepartment(dept: Partial<HRDepartment>) {
  if (dept.id) {
    const { data, error } = await supabase
      .from('hr_departments').update(dept).eq('id', dept.id).select().single()
    if (error) pgError(error)
    return data as HRDepartment
  }
  const { data, error } = await supabase
    .from('hr_departments').insert(dept).select().single()
  if (error) pgError(error)
  return data as HRDepartment
}

export async function deleteDepartment(id: string) {
  const { error } = await supabase.from('hr_departments').delete().eq('id', id)
  if (error) pgError(error)
}

// ─── Positions ──────────────────────────────────────────────────────────────

export async function fetchPositions(departmentId?: string) {
  let q = supabase.from('hr_positions').select('*').order('level')
  if (departmentId) q = q.eq('department_id', departmentId)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRPosition[]
}

export async function upsertPosition(pos: Partial<HRPosition>) {
  if (pos.id) {
    const { data, error } = await supabase
      .from('hr_positions').update(pos).eq('id', pos.id).select().single()
    if (error) pgError(error)
    return data as HRPosition
  }
  const { data, error } = await supabase
    .from('hr_positions').insert(pos).select().single()
  if (error) pgError(error)
  return data as HRPosition
}

export async function deletePosition(id: string) {
  const { error } = await supabase.from('hr_positions').delete().eq('id', id)
  if (error) pgError(error)
}

// ─── Employees ──────────────────────────────────────────────────────────────

export async function fetchEmployees(filters?: { status?: string; department_id?: string }) {
  let q = supabase.from('hr_employees')
    .select('*, department:hr_departments!department_id(*), position:hr_positions!position_id(*)')
    .order('employee_code')
  if (filters?.status) q = q.eq('employment_status', filters.status)
  if (filters?.department_id) q = q.eq('department_id', filters.department_id)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HREmployee[]
}

export async function fetchEmployeeById(id: string) {
  const { data, error } = await supabase.from('hr_employees')
    .select('*, department:hr_departments!department_id(*), position:hr_positions!position_id(*)')
    .eq('id', id).single()
  if (error) pgError(error)
  return data as HREmployee
}

export async function fetchEmployeeByUserId(userId: string) {
  const { data, error } = await supabase.from('hr_employees')
    .select('*, department:hr_departments!department_id(*), position:hr_positions!position_id(*)')
    .eq('user_id', userId).single()
  if (error) return null
  return data as HREmployee
}

export async function upsertEmployee(emp: Partial<HREmployee>) {
  if (emp.id) {
    const { data, error } = await supabase
      .from('hr_employees').update(emp).eq('id', emp.id).select().single()
    if (error) pgError(error)
    return data as HREmployee
  }
  const { data, error } = await supabase
    .from('hr_employees').insert(emp).select().single()
  if (error) pgError(error)
  return data as HREmployee
}

export async function deleteEmployee(id: string) {
  const { error } = await supabase.from('hr_employees').delete().eq('id', id)
  if (error) pgError(error)
}

// ─── Leave Types ────────────────────────────────────────────────────────────

export async function fetchLeaveTypes() {
  const { data, error } = await supabase.from('hr_leave_types').select('*').order('name')
  if (error) pgError(error)
  return data as HRLeaveType[]
}

export async function upsertLeaveType(lt: Partial<HRLeaveType>) {
  if (lt.id) {
    const { data, error } = await supabase
      .from('hr_leave_types').update(lt).eq('id', lt.id).select().single()
    if (error) pgError(error)
    return data as HRLeaveType
  }
  const { data, error } = await supabase
    .from('hr_leave_types').insert(lt).select().single()
  if (error) pgError(error)
  return data as HRLeaveType
}

// ─── Leave Requests ─────────────────────────────────────────────────────────

export async function fetchLeaveRequests(filters?: { status?: string; employee_id?: string }) {
  let q = supabase.from('hr_leave_requests')
    .select('*, employee:hr_employees!employee_id(id, employee_code, first_name, last_name, nickname, department:hr_departments!department_id(name)), leave_type:hr_leave_types!leave_type_id(name)')
    .order('created_at', { ascending: false })
  if (filters?.status) q = q.eq('status', filters.status)
  if (filters?.employee_id) q = q.eq('employee_id', filters.employee_id)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRLeaveRequest[]
}

export async function createLeaveRequest(req: Partial<HRLeaveRequest>) {
  const { data, error } = await supabase
    .from('hr_leave_requests').insert(req).select().single()
  if (error) pgError(error)
  return data as HRLeaveRequest
}

export async function updateLeaveRequest(id: string, updates: Partial<HRLeaveRequest>) {
  const { data, error } = await supabase
    .from('hr_leave_requests').update(updates).eq('id', id).select().single()
  if (error) pgError(error)
  return data as HRLeaveRequest
}

export async function getEmployeeLeaveSummary(employeeId: string, year: number) {
  const { data, error } = await supabase.rpc('get_employee_leave_summary', {
    p_employee_id: employeeId,
    p_year: year,
  })
  if (error) pgError(error)
  return data as {
    balances: (HRLeaveBalance & { leave_type_name: string; remaining: number })[]
    recent_requests: { id: string; leave_type_name: string; start_date: string; end_date: string; total_days: number; status: string; reason: string; medical_cert_url: string; created_at: string }[]
    pending_count: number
  }
}

// ─── Candidates ─────────────────────────────────────────────────────────────

export async function fetchCandidates(status?: string) {
  let q = supabase.from('hr_candidates').select('*').order('created_at', { ascending: false })
  if (status) q = q.eq('status', status)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRCandidate[]
}

export async function upsertCandidate(c: Partial<HRCandidate>) {
  if (c.id) {
    const { data, error } = await supabase
      .from('hr_candidates').update(c).eq('id', c.id).select().single()
    if (error) pgError(error)
    return data as HRCandidate
  }
  const { data, error } = await supabase
    .from('hr_candidates').insert(c).select().single()
  if (error) pgError(error)
  return data as HRCandidate
}

// ─── Interviews ─────────────────────────────────────────────────────────────

export async function fetchInterviews() {
  const { data, error } = await supabase.from('hr_interviews')
    .select('*, candidate:hr_candidates(*)')
    .order('interview_date', { ascending: false })
  if (error) pgError(error)
  return data as HRInterview[]
}

export async function upsertInterview(iv: Partial<HRInterview>) {
  if (iv.id) {
    const { data, error } = await supabase
      .from('hr_interviews').update(iv).eq('id', iv.id).select().single()
    if (error) pgError(error)
    return data as HRInterview
  }
  const { data, error } = await supabase
    .from('hr_interviews').insert(iv).select().single()
  if (error) pgError(error)
  return data as HRInterview
}

export async function fetchInterviewScores(interviewId: string) {
  const { data, error } = await supabase.from('hr_interview_scores')
    .select('*').eq('interview_id', interviewId)
  if (error) pgError(error)
  return data as HRInterviewScore[]
}

export async function upsertInterviewScore(score: Partial<HRInterviewScore>) {
  if (score.id) {
    const { data, error } = await supabase
      .from('hr_interview_scores').update(score).eq('id', score.id).select().single()
    if (error) pgError(error)
    return data as HRInterviewScore
  }
  const { data, error } = await supabase
    .from('hr_interview_scores').insert(score).select().single()
  if (error) pgError(error)
  return data as HRInterviewScore
}

// ─── Attendance ─────────────────────────────────────────────────────────────

export async function fetchAttendanceUploads() {
  const { data, error } = await supabase.from('hr_attendance_uploads')
    .select('*').order('created_at', { ascending: false })
  if (error) pgError(error)
  return data as HRAttendanceUpload[]
}

export async function fetchAttendanceSummary(uploadId: string) {
  const { data, error } = await supabase.from('hr_attendance_summary')
    .select('*').eq('upload_id', uploadId).order('employee_name')
  if (error) pgError(error)
  return data as HRAttendanceSummary[]
}

export async function fetchAttendanceDaily(uploadId: string, fingerprintId?: string) {
  let q = supabase.from('hr_attendance_daily')
    .select('*').eq('upload_id', uploadId).order('work_date')
  if (fingerprintId) q = q.eq('fingerprint_id', fingerprintId)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRAttendanceDaily[]
}

export async function batchUpsertAttendance(
  upload: Record<string, unknown>,
  summaries: Record<string, unknown>[],
  dailies: Record<string, unknown>[],
) {
  const { data, error } = await supabase.rpc('batch_upsert_attendance', {
    p_upload: upload,
    p_summaries: summaries,
    p_dailies: dailies,
  })
  if (error) pgError(error)
  return data as string
}

// ─── Contracts ──────────────────────────────────────────────────────────────

export async function fetchContractTemplates() {
  const { data, error } = await supabase.from('hr_contract_templates')
    .select('*').eq('is_active', true).order('name')
  if (error) pgError(error)
  return data as HRContractTemplate[]
}

export async function upsertContractTemplate(t: Partial<HRContractTemplate>) {
  if (t.id) {
    const { data, error } = await supabase
      .from('hr_contract_templates').update(t).eq('id', t.id).select().single()
    if (error) pgError(error)
    return data as HRContractTemplate
  }
  const { data, error } = await supabase
    .from('hr_contract_templates').insert(t).select().single()
  if (error) pgError(error)
  return data as HRContractTemplate
}

export async function fetchContracts(employeeId?: string) {
  let q = supabase.from('hr_contracts')
    .select('*, employee:hr_employees(id, employee_code, first_name, last_name)')
    .order('created_at', { ascending: false })
  if (employeeId) q = q.eq('employee_id', employeeId)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRContract[]
}

export async function upsertContract(c: Partial<HRContract>) {
  if (c.id) {
    const { data, error } = await supabase
      .from('hr_contracts').update(c).eq('id', c.id).select().single()
    if (error) pgError(error)
    return data as HRContract
  }
  const { data, error } = await supabase
    .from('hr_contracts').insert(c).select().single()
  if (error) pgError(error)
  return data as HRContract
}

// ─── Documents & Categories ─────────────────────────────────────────────────

export async function fetchDocumentCategories() {
  const { data, error } = await supabase.from('hr_document_categories')
    .select('*').order('sort_order')
  if (error) pgError(error)
  return data as HRDocumentCategory[]
}

export async function upsertDocumentCategory(c: Partial<HRDocumentCategory>) {
  if (c.id) {
    const { data, error } = await supabase
      .from('hr_document_categories').update(c).eq('id', c.id).select().single()
    if (error) pgError(error)
    return data as HRDocumentCategory
  }
  const { data, error } = await supabase
    .from('hr_document_categories').insert(c).select().single()
  if (error) pgError(error)
  return data as HRDocumentCategory
}

export async function fetchDocumentById(id: string) {
  const { data, error } = await supabase.from('hr_documents')
    .select('*').eq('id', id).single()
  if (error) pgError(error)
  return data as HRDocument
}

export async function fetchDocuments(filters?: { category_id?: string; department_id?: string }) {
  let q = supabase.from('hr_documents')
    .select('*, category:hr_document_categories(name)')
    .eq('is_active', true).order('title')
  if (filters?.category_id) q = q.eq('category_id', filters.category_id)
  if (filters?.department_id) q = q.or(`department_id.eq.${filters.department_id},department_id.is.null`)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRDocument[]
}

export async function upsertDocument(doc: Partial<HRDocument>) {
  if (doc.id) {
    const { data, error } = await supabase
      .from('hr_documents').update(doc).eq('id', doc.id).select().single()
    if (error) pgError(error)
    return data as HRDocument
  }
  const { data, error } = await supabase
    .from('hr_documents').insert(doc).select().single()
  if (error) pgError(error)
  return data as HRDocument
}

// ─── Exams ──────────────────────────────────────────────────────────────────

export async function fetchExams(departmentId?: string) {
  let q = supabase.from('hr_exams').select('*').eq('is_active', true).order('title')
  if (departmentId) q = q.eq('department_id', departmentId)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRExam[]
}

export async function upsertExam(e: Partial<HRExam>) {
  if (e.id) {
    const { data, error } = await supabase
      .from('hr_exams').update(e).eq('id', e.id).select().single()
    if (error) pgError(error)
    return data as HRExam
  }
  const { data, error } = await supabase
    .from('hr_exams').insert(e).select().single()
  if (error) pgError(error)
  return data as HRExam
}

export async function submitExamResult(result: Partial<HRExamResult>) {
  const { data, error } = await supabase
    .from('hr_exam_results').insert(result).select().single()
  if (error) pgError(error)
  return data as HRExamResult
}

export async function fetchExamResults(filters?: { employee_id?: string; exam_id?: string }) {
  let q = supabase.from('hr_exam_results').select('*').order('created_at', { ascending: false })
  if (filters?.employee_id) q = q.eq('employee_id', filters.employee_id)
  if (filters?.exam_id) q = q.eq('exam_id', filters.exam_id)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRExamResult[]
}

// ─── Document Reads ─────────────────────────────────────────────────────────

export async function markDocumentRead(documentId: string, employeeId: string) {
  const { error } = await supabase.from('hr_document_reads')
    .upsert({ document_id: documentId, employee_id: employeeId, read_at: new Date().toISOString(), acknowledged: true }, { onConflict: 'document_id,employee_id' })
  if (error) pgError(error)
}

export async function fetchDocumentReads(employeeId: string) {
  const { data, error } = await supabase.from('hr_document_reads')
    .select('document_id').eq('employee_id', employeeId)
  if (error) pgError(error)
  return (data ?? []) as { document_id: string }[]
}

// ─── Onboarding Templates ───────────────────────────────────────────────────

export async function fetchOnboardingTemplates(departmentId?: string) {
  let q = supabase.from('hr_onboarding_templates').select('*').eq('is_active', true)
  if (departmentId) q = q.eq('department_id', departmentId)
  const { data, error } = await q.order('name')
  if (error) pgError(error)
  return data as HROnboardingTemplate[]
}

export async function upsertOnboardingTemplate(t: Partial<HROnboardingTemplate>) {
  if (t.id) {
    const { data, error } = await supabase
      .from('hr_onboarding_templates').update(t).eq('id', t.id).select().single()
    if (error) pgError(error)
    return data as HROnboardingTemplate
  }
  const { data, error } = await supabase
    .from('hr_onboarding_templates').insert(t).select().single()
  if (error) pgError(error)
  return data as HROnboardingTemplate
}

// ─── Onboarding Plans ───────────────────────────────────────────────────────

export async function fetchOnboardingPlans(filters?: { employee_id?: string; status?: string }) {
  let q = supabase.from('hr_onboarding_plans')
    .select('*, employee:hr_employees!employee_id(id, employee_code, first_name, last_name, nickname, photo_url)')
    .order('created_at', { ascending: false })
  if (filters?.employee_id) q = q.eq('employee_id', filters.employee_id)
  if (filters?.status) q = q.eq('status', filters.status)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HROnboardingPlan[]
}

export async function upsertOnboardingPlan(p: Partial<HROnboardingPlan>) {
  if (p.id) {
    const { data, error } = await supabase
      .from('hr_onboarding_plans').update(p).eq('id', p.id).select().single()
    if (error) pgError(error)
    return data as HROnboardingPlan
  }
  const { data, error } = await supabase
    .from('hr_onboarding_plans').insert(p).select().single()
  if (error) pgError(error)
  return data as HROnboardingPlan
}

export async function getOnboardingDetail(planId: string) {
  const { data, error } = await supabase.rpc('get_onboarding_detail', { p_plan_id: planId })
  if (error) pgError(error)
  return data as {
    plan: HROnboardingPlan
    employee: HREmployee
    mentor: HREmployee | null
    supervisor: HREmployee | null
    manager: HREmployee | null
    template: HROnboardingTemplate
    progress: HROnboardingProgress[]
  }
}

export async function upsertOnboardingProgress(p: Partial<HROnboardingProgress>) {
  if (p.id) {
    const { data, error } = await supabase
      .from('hr_onboarding_progress').update(p).eq('id', p.id).select().single()
    if (error) pgError(error)
    return data as HROnboardingProgress
  }
  const { data, error } = await supabase
    .from('hr_onboarding_progress').insert(p).select().single()
  if (error) pgError(error)
  return data as HROnboardingProgress
}

// ─── Career Tracks & Levels ─────────────────────────────────────────────────

export async function fetchCareerTracks() {
  const { data, error } = await supabase.from('hr_career_tracks').select('*').order('name')
  if (error) pgError(error)
  return data as HRCareerTrack[]
}

export async function upsertCareerTrack(t: Partial<HRCareerTrack>) {
  if (t.id) {
    const { data, error } = await supabase
      .from('hr_career_tracks').update(t).eq('id', t.id).select().single()
    if (error) pgError(error)
    return data as HRCareerTrack
  }
  const { data, error } = await supabase
    .from('hr_career_tracks').insert(t).select().single()
  if (error) pgError(error)
  return data as HRCareerTrack
}

export async function fetchCareerLevels(trackId: string) {
  const { data, error } = await supabase.from('hr_career_levels')
    .select('*').eq('track_id', trackId).order('level_order')
  if (error) pgError(error)
  return data as HRCareerLevel[]
}

export async function upsertCareerLevel(l: Partial<HRCareerLevel>) {
  if (l.id) {
    const { data, error } = await supabase
      .from('hr_career_levels').update(l).eq('id', l.id).select().single()
    if (error) pgError(error)
    return data as HRCareerLevel
  }
  const { data, error } = await supabase
    .from('hr_career_levels').insert(l).select().single()
  if (error) pgError(error)
  return data as HRCareerLevel
}

export async function deleteCareerLevel(id: string) {
  const { error } = await supabase.from('hr_career_levels').delete().eq('id', id)
  if (error) pgError(error)
}

export async function getCareerPath(employeeId: string) {
  const { data, error } = await supabase.rpc('get_career_path', { p_employee_id: employeeId })
  if (error) pgError(error)
  return data as {
    career: { track_id: string; track_name: string; description: string; current_level_id: string; current_salary: number; effective_date: string; levels: HRCareerLevel[] }[]
    history: { from_title: string; to_title: string; from_salary: number; to_salary: number; effective_date: string; reason: string }[]
  }
}

export async function upsertEmployeeCareer(c: Partial<HREmployeeCareer>) {
  if (c.id) {
    const { data, error } = await supabase
      .from('hr_employee_career').update(c).eq('id', c.id).select().single()
    if (error) pgError(error)
    return data as HREmployeeCareer
  }
  const { data, error } = await supabase
    .from('hr_employee_career').insert(c).select().single()
  if (error) pgError(error)
  return data as HREmployeeCareer
}

// ─── Notifications (In-App) ─────────────────────────────────────────────────

export async function fetchNotifications(employeeId: string, unreadOnly = false) {
  let q = supabase.from('hr_notifications')
    .select('*').eq('employee_id', employeeId)
    .order('created_at', { ascending: false }).limit(50)
  if (unreadOnly) q = q.eq('is_read', false)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRNotification[]
}

export async function markNotificationRead(id: string) {
  const { error } = await supabase.from('hr_notifications')
    .update({ is_read: true }).eq('id', id)
  if (error) pgError(error)
}

export async function markAllNotificationsRead(employeeId: string) {
  const { error } = await supabase.from('hr_notifications')
    .update({ is_read: true }).eq('employee_id', employeeId).eq('is_read', false)
  if (error) pgError(error)
}

// ─── Notification Settings ──────────────────────────────────────────────────

export async function fetchNotificationSettings() {
  const { data, error } = await supabase.from('hr_notification_settings')
    .select('*').limit(1).single()
  if (error && error.code !== 'PGRST116') throw error
  return data as HRNotificationSettings | null
}

export async function upsertNotificationSettings(s: Partial<HRNotificationSettings>) {
  if (s.id) {
    const { data, error } = await supabase
      .from('hr_notification_settings').update(s).eq('id', s.id).select().single()
    if (error) pgError(error)
    return data as HRNotificationSettings
  }
  const { data, error } = await supabase
    .from('hr_notification_settings').insert(s).select().single()
  if (error) pgError(error)
  return data as HRNotificationSettings
}

// ─── Leave Balances ─────────────────────────────────────────────────────────

export async function fetchLeaveBalances(employeeId: string, year: number) {
  const { data, error } = await supabase.from('hr_leave_balances')
    .select('*').eq('employee_id', employeeId).eq('year', year)
  if (error) pgError(error)
  return data as HRLeaveBalance[]
}

export async function upsertLeaveBalance(b: Partial<HRLeaveBalance>) {
  if (b.id) {
    const { data, error } = await supabase
      .from('hr_leave_balances').update(b).eq('id', b.id).select().single()
    if (error) pgError(error)
    return data as HRLeaveBalance
  }
  const { data, error } = await supabase
    .from('hr_leave_balances').insert(b).select().single()
  if (error) pgError(error)
  return data as HRLeaveBalance
}

// ─── File Upload Helpers ────────────────────────────────────────────────────

export async function uploadHRFile(bucket: string, path: string, file: File) {
  const { data, error } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: '3600',
    upsert: true,
  })
  if (error) pgError(error)
  return data.path
}

export function getHRFileUrl(bucket: string, path: string) {
  const { data } = supabase.storage.from(bucket).getPublicUrl(path)
  return data.publicUrl
}

// =============================================================================
// SIAM-ID Data.txt Parser
// =============================================================================

export interface SiamIdRecord {
  date: string
  time: string
  citizen_id: string
  prefix: string
  first_name: string
  last_name: string
  prefix_en: string
  first_name_en: string
  last_name_en: string
  birth_date: string
  gender: string
  religion: string
  age_at_issue: string
  age_current: string
  house_no: string
  moo: string
  trok: string
  soi: string
  road: string
  tambon: string
  amphoe: string
  province: string
  card_issue_date: string
  card_expiry_date: string
  card_number: string
  card_issue_place: string
  request_number: string
  custom_1: string
  custom_2: string
  custom_3: string
  custom_4: string
  photo_path: string
}

export function parseSiamIdData(csvText: string): SiamIdRecord[] {
  const lines = csvText.trim().split('\n')
  if (lines.length < 2) return []

  const records: SiamIdRecord[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const parts: string[] = []
    let current = ''
    let inQuotes = false
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue }
      if (ch === ',' && !inQuotes) { parts.push(current.trim()); current = ''; continue }
      current += ch
    }
    parts.push(current.trim())

    if (parts.length < 31) continue

    records.push({
      date: parts[0], time: parts[1],
      citizen_id: parts[2].replace(/\s/g, ''),
      prefix: parts[3], first_name: parts[4], last_name: parts[5],
      prefix_en: parts[6], first_name_en: parts[7], last_name_en: parts[8],
      birth_date: parts[9], gender: parts[10], religion: parts[11],
      age_at_issue: parts[12], age_current: parts[13],
      house_no: parts[14], moo: parts[15], trok: parts[16],
      soi: parts[17], road: parts[18], tambon: parts[19],
      amphoe: parts[20], province: parts[21],
      card_issue_date: parts[22], card_expiry_date: parts[23],
      card_number: parts[24], card_issue_place: parts[25],
      request_number: parts[26],
      custom_1: parts[27], custom_2: parts[28],
      custom_3: parts[29], custom_4: parts[30],
      photo_path: parts[31] || '',
    })
  }
  return records
}

export function getLatestSiamIdRecords(records: SiamIdRecord[]): SiamIdRecord[] {
  const map = new Map<string, SiamIdRecord>()
  for (const r of records) {
    map.set(r.citizen_id, r)
  }
  return Array.from(map.values())
}

export function siamIdToCandidate(r: SiamIdRecord): Partial<HRCandidate> {
  return {
    citizen_id: r.citizen_id,
    prefix: r.prefix,
    first_name: r.first_name,
    last_name: r.last_name,
    first_name_en: r.first_name_en,
    last_name_en: r.last_name_en,
    birth_date: parseThaiDate(r.birth_date),
    gender: r.gender,
    religion: r.religion,
    address: {
      house_no: r.house_no, moo: r.moo, trok: r.trok, soi: r.soi,
      road: r.road, tambon: r.tambon, amphoe: r.amphoe, province: r.province,
    },
    custom_field_1: r.custom_1,
    custom_field_2: r.custom_2,
    custom_field_3: r.custom_3,
    custom_field_4: r.custom_4,
    raw_siam_data: r as unknown as Record<string, string>,
    status: 'new',
  }
}

function parseThaiDate(thai: string): string | undefined {
  if (!thai) return undefined
  const thaiMonths: Record<string, string> = {
    'มกราคม': '01', 'กุมภาพันธ์': '02', 'มีนาคม': '03', 'เมษายน': '04',
    'พฤษภาคม': '05', 'มิถุนายน': '06', 'กรกฎาคม': '07', 'สิงหาคม': '08',
    'กันยายน': '09', 'ตุลาคม': '10', 'พฤศจิกายน': '11', 'ธันวาคม': '12',
  }
  const parts = thai.split(' ')
  if (parts.length < 3) return undefined
  const day = parts[0].padStart(2, '0')
  const month = thaiMonths[parts[1]]
  const yearBE = parseInt(parts[2])
  if (!month || isNaN(yearBE)) return undefined
  const yearCE = yearBE - 543
  return `${yearCE}-${month}-${day}`
}

// =============================================================================
// Excel Parser: ตึกใหม่ (New Building)
// =============================================================================

export interface ParsedAttendanceResult {
  source: 'new_building' | 'old_building'
  periodStart: string
  periodEnd: string
  summaries: Record<string, unknown>[]
  dailies: Record<string, unknown>[]
}

export function parseNewBuildingExcel(file: ArrayBuffer): ParsedAttendanceResult {
  const wb = XLSX.read(file, { type: 'array' })

  const scheduleSheet = wb.Sheets[wb.SheetNames[0]]
  const scheduleData = XLSX.utils.sheet_to_json<(string | number | null)[]>(scheduleSheet, { header: 1 })

  let periodStart = ''
  let periodEnd = ''
  if (scheduleData[1]) {
    const dateStr = String(scheduleData[1][1] || '')
    const match = dateStr.match(/(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/)
    if (match) { periodStart = match[1]; periodEnd = match[2] }
  }

  const dayHeaders = scheduleData[2]?.slice(3) || []
  const summaries: Record<string, unknown>[] = []
  const dailies: Record<string, unknown>[] = []

  for (let i = 4; i < scheduleData.length; i++) {
    const row = scheduleData[i]
    if (!row || !row[0]) continue
    const fpId = String(row[0])
    const name = String(row[1] || '')
    const dept = String(row[2] || '')

    for (let d = 3; d < row.length; d++) {
      const dayNum = dayHeaders[d - 3]
      if (!dayNum) continue
      const shiftVal = row[d]
      const workDate = periodStart ? computeDate(periodStart, Number(dayNum)) : ''
      if (!workDate) continue

      dailies.push({
        fingerprint_id: fpId,
        employee_name: name,
        source: 'new_building',
        work_date: workDate,
        shift_code: shiftVal != null ? String(shiftVal) : null,
        is_holiday: shiftVal == null,
        is_absent: false,
      })
    }

    summaries.push({
      fingerprint_id: fpId,
      employee_name: name,
      department: dept,
      source: 'new_building',
      period_start: periodStart,
      period_end: periodEnd,
    })
  }

  const summarySheet = wb.Sheets[wb.SheetNames[1]]
  if (summarySheet) {
    const summaryData = XLSX.utils.sheet_to_json<(string | number | null)[]>(summarySheet, { header: 1 })
    for (let i = 4; i < summaryData.length; i++) {
      const row = summaryData[i]
      if (!row || !row[0]) continue
      const fpId = String(row[0])
      const existing = summaries.find(s => s.fingerprint_id === fpId)
      if (existing) {
        existing.scheduled_hours = parseHoursToNumber(row[3])
        existing.actual_hours = parseHoursToNumber(row[4])
        existing.late_count = Number(row[5]) || 0
        existing.late_minutes = Number(row[6]) || 0
        existing.early_leave_count = Number(row[7]) || 0
        existing.early_leave_minutes = Number(row[8]) || 0
        const stdActual = String(row[11] || '')
        const parts = stdActual.split('/')
        existing.work_days_required = Number(parts[0]) || 0
        existing.work_days_actual = Number(parts[1]) || 0
        existing.absent_days = Number(row[12]) || 0
        existing.leave_days = Number(row[13]) || 0
      }
    }
  }

  return { source: 'new_building', periodStart, periodEnd, summaries, dailies }
}

// =============================================================================
// Excel Parser: ตึกเก่า (Old Building)
// =============================================================================

export function parseOldBuildingExcel(file: ArrayBuffer): ParsedAttendanceResult {
  const wb = XLSX.read(file, { type: 'array' })

  const summarySheet = wb.Sheets['สรุป']
  const summaryData = XLSX.utils.sheet_to_json<(string | number | null)[]>(summarySheet, { header: 1 })

  let periodStart = ''
  let periodEnd = ''
  if (summaryData[1]) {
    const dateStr = String(summaryData[1][1] || '')
    const match = dateStr.match(/(\d{4})\/(\d{2})\/(\d{2})\s*~\s*(\d{2})\/(\d{2})/)
    if (match) {
      periodStart = `${match[1]}-${match[2]}-${match[3]}`
      periodEnd = `${match[1]}-${match[4]}-${match[5]}`
    }
  }

  const summaries: Record<string, unknown>[] = []
  const dailies: Record<string, unknown>[] = []

  for (let i = 4; i < summaryData.length; i++) {
    const row = summaryData[i]
    if (!row || !row[0] || typeof row[0] !== 'string' && typeof row[0] !== 'number') continue
    const no = String(row[0])
    if (!/^\d+$/.test(no)) continue

    const name = String(row[1] || '')
    const dept = String(row[2] || '')
    const stdActual = String(row[11] || '')
    const parts = stdActual.split('/')

    summaries.push({
      fingerprint_id: no,
      employee_name: name,
      department: dept,
      source: 'old_building',
      period_start: periodStart,
      period_end: periodEnd,
      scheduled_hours: parseHoursToNumber(row[3]),
      actual_hours: parseHoursToNumber(row[4]),
      work_days_required: Number(parts[0]) || 0,
      work_days_actual: Number(parts[1]) || 0,
      absent_days: Number(row[13]) || 0,
      late_count: Number(row[14]) || 0,
    })
  }

  const shiftSheet = wb.Sheets['กะ']
  if (shiftSheet) {
    const shiftData = XLSX.utils.sheet_to_json<(string | number | null)[]>(shiftSheet, { header: 1 })
    const dayHeaders = shiftData[2]?.slice(3) || []

    for (let i = 4; i < shiftData.length; i++) {
      const row = shiftData[i]
      if (!row || !row[0]) continue
      const no = String(row[0])
      if (!/^\d+$/.test(no)) continue
      const name = String(row[1] || '')

      for (let d = 3; d < row.length; d++) {
        const dayNum = dayHeaders[d - 3]
        if (!dayNum) continue
        const shiftVal = row[d]
        const workDate = periodStart ? computeDate(periodStart, Number(dayNum)) : ''
        if (!workDate) continue

        dailies.push({
          fingerprint_id: no,
          employee_name: name,
          source: 'old_building',
          work_date: workDate,
          shift_code: shiftVal != null ? String(shiftVal) : null,
          is_holiday: shiftVal == null,
          is_absent: false,
        })
      }
    }
  }

  const systemSheet = wb.Sheets['ระบบ']
  if (systemSheet) {
    const sysData = XLSX.utils.sheet_to_json<(string | number | null)[]>(systemSheet, { header: 1 })
    const dayHeaders = sysData[2]?.slice(3) || []

    for (let i = 4; i < sysData.length; i++) {
      const row = sysData[i]
      if (!row || !row[0]) continue
      const no = String(row[0])
      if (!/^\d+$/.test(no)) continue
      void String(row[1] || '')

      for (let d = 3; d < row.length; d++) {
        const dayNum = dayHeaders[d - 3]
        if (!dayNum) continue
        const cellVal = String(row[d] || '')
        if (!cellVal) continue
        const times = cellVal.split('\n').map(t => t.trim()).filter(Boolean)
        const clockIn = times[0] || undefined
        const clockOut = times[1] || undefined
        const workDate = periodStart ? computeDate(periodStart, Number(dayNum)) : ''
        if (!workDate) continue

        const existing = dailies.find(
          dd => dd.fingerprint_id === no && dd.work_date === workDate
        )
        if (existing) {
          existing.clock_in = clockIn
          existing.clock_out = clockOut
        }
      }
    }
  }

  return { source: 'old_building', periodStart, periodEnd, summaries, dailies }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeDate(periodStart: string, dayNum: number): string {
  const d = new Date(periodStart)
  d.setDate(dayNum)
  if (isNaN(d.getTime())) return ''
  return d.toISOString().split('T')[0]
}

function parseHoursToNumber(val: unknown): number | undefined {
  if (val == null) return undefined
  const s = String(val)
  if (s.includes(':')) {
    const [h, m] = s.split(':').map(Number)
    return h + (m || 0) / 60
  }
  const n = parseFloat(s)
  return isNaN(n) ? undefined : n
}

// =============================================================================
// Warning Letters (ใบเตือน)
// =============================================================================

const WARNING_SELECT = `*, employee:hr_employees!hr_warnings_employee_id_fkey(id,employee_code,first_name,last_name,nickname,department_id,position_id), issuer:hr_employees!hr_warnings_issued_by_fkey(id,first_name,last_name), witness:hr_employees!hr_warnings_witness_id_fkey(id,first_name,last_name)`

export async function fetchWarnings(filters?: { employeeId?: string; status?: string; level?: string }) {
  let q = supabase.from('hr_warnings').select(WARNING_SELECT).order('created_at', { ascending: false })
  if (filters?.employeeId) q = q.eq('employee_id', filters.employeeId)
  if (filters?.status) q = q.eq('status', filters.status)
  if (filters?.level) q = q.eq('warning_level', filters.level)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRWarning[]
}

export async function fetchWarning(id: string) {
  const { data, error } = await supabase.from('hr_warnings').select(WARNING_SELECT).eq('id', id).single()
  if (error) pgError(error)
  return data as HRWarning
}

export async function upsertWarning(w: Partial<HRWarning>) {
  const payload = { ...w }
  delete payload.employee
  delete payload.issuer
  delete payload.witness
  if (payload.id) {
    const { data, error } = await supabase.from('hr_warnings').update(payload).eq('id', payload.id).select(WARNING_SELECT).single()
    if (error) pgError(error)
    return data as HRWarning
  }
  const { data, error } = await supabase.from('hr_warnings').insert(payload).select(WARNING_SELECT).single()
  if (error) pgError(error)
  return data as HRWarning
}

export async function deleteWarning(id: string) {
  const { error } = await supabase.from('hr_warnings').delete().eq('id', id)
  if (error) pgError(error)
}

export async function fetchEmployeeWarningCount(employeeId: string) {
  const { count, error } = await supabase.from('hr_warnings')
    .select('id', { count: 'exact', head: true })
    .eq('employee_id', employeeId)
    .in('status', ['issued', 'acknowledged'])
  if (error) pgError(error)
  return count ?? 0
}

// =============================================================================
// Training Certificates (ใบรับรอง)
// =============================================================================

const CERT_SELECT = `*, employee:hr_employees!hr_certificates_employee_id_fkey(id,employee_code,first_name,last_name,nickname,department_id,position_id), issuer:hr_employees!hr_certificates_issued_by_fkey(id,first_name,last_name)`

export async function fetchCertificates(filters?: { employeeId?: string; status?: string; passStatus?: string; trainingType?: string }) {
  let q = supabase.from('hr_certificates').select(CERT_SELECT).order('created_at', { ascending: false })
  if (filters?.employeeId) q = q.eq('employee_id', filters.employeeId)
  if (filters?.status) q = q.eq('status', filters.status)
  if (filters?.passStatus) q = q.eq('pass_status', filters.passStatus)
  if (filters?.trainingType) q = q.eq('training_type', filters.trainingType)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRCertificate[]
}

export async function fetchCertificate(id: string) {
  const { data, error } = await supabase.from('hr_certificates').select(CERT_SELECT).eq('id', id).single()
  if (error) pgError(error)
  return data as HRCertificate
}

export async function upsertCertificate(c: Partial<HRCertificate>) {
  const payload = { ...c }
  delete payload.employee
  delete payload.issuer
  if (payload.id) {
    const { data, error } = await supabase.from('hr_certificates').update(payload).eq('id', payload.id).select(CERT_SELECT).single()
    if (error) pgError(error)
    return data as HRCertificate
  }
  const { data, error } = await supabase.from('hr_certificates').insert(payload).select(CERT_SELECT).single()
  if (error) pgError(error)
  return data as HRCertificate
}

export async function deleteCertificate(id: string) {
  const { error } = await supabase.from('hr_certificates').delete().eq('id', id)
  if (error) pgError(error)
}
