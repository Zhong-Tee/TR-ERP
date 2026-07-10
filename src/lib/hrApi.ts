import { supabase } from './supabase'
import { buildIlikeOr } from './searchFilter'
import type {
  HRDepartment, HRPosition, HREmployee, HRLeaveType, HRLeaveRequest,
  HRLeaveBalance, HRCandidate, HRInterview, HRInterviewScore,
  HRContractTemplate, HRContract, HRDocumentCategory, HRDocument,
  HRExam, HRExamResult, HROnboardingTemplate, HROnboardingPlan,
  HROnboardingProgress, HRCareerTrack, HRCareerLevel, HREmployeeCareer,
  HRNotification, HRNotificationSettings,
  HRWarning, HRCertificate, HRAsset,
  HRClockLocation, HRTimeEntry, HROTRequest, HRWorkSchedule,
} from '../types'

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

/** รหัสถัดไปที่จะได้เมื่อบันทึก (ไม่กินลำดับ) — ต้องมี migration 177 */
export async function previewNextEmployeeCode(): Promise<string> {
  const { data, error } = await supabase.rpc('hr_preview_next_employee_code')
  if (error) pgError(error)
  return String(data ?? '')
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
    .select('*, employee:hr_employees!employee_id(id, employee_code, first_name, last_name, nickname, department:hr_departments!department_id(name), position:hr_positions!position_id(name)), leave_type:hr_leave_types!leave_type_id(name)')
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

/** signed URL ของเอกสารแนบใบลา (bucket hr-medical-certs เป็น private) */
export async function getMedicalCertUrl(path: string, expiresInSec = 3600) {
  if (path.startsWith('http')) return path
  const { data, error } = await supabase.storage.from('hr-medical-certs').createSignedUrl(path, expiresInSec)
  if (error) pgError(error)
  return data.signedUrl
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

// =============================================================================
// Asset Registry (ทะเบียนทรัพย์สิน)
// =============================================================================

const ASSET_SELECT = `*, department:hr_departments!department_id(id,name), assigned_employee:hr_employees!assigned_employee_id(id,employee_code,first_name,last_name,nickname,department_id,position_id)`

export async function fetchAssets(filters?: {
  status?: string
  departmentId?: string
  assignedEmployeeId?: string
  search?: string
}) {
  let q = supabase.from('hr_assets').select(ASSET_SELECT).order('created_at', { ascending: false })
  if (filters?.status) q = q.eq('status', filters.status)
  if (filters?.departmentId) q = q.eq('department_id', filters.departmentId)
  if (filters?.assignedEmployeeId) q = q.eq('assigned_employee_id', filters.assignedEmployeeId)
  if (filters?.search?.trim()) {
    const term = filters.search.trim()
    q = q.or(buildIlikeOr(term, ['name', 'asset_code', 'category', 'location']))
  }
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRAsset[]
}

export async function fetchAsset(id: string) {
  const { data, error } = await supabase.from('hr_assets').select(ASSET_SELECT).eq('id', id).single()
  if (error) pgError(error)
  return data as HRAsset
}

export async function upsertAsset(asset: Partial<HRAsset>) {
  const payload = { ...asset }
  delete payload.department
  delete payload.assigned_employee
  if (payload.id) {
    const { data, error } = await supabase.from('hr_assets').update(payload).eq('id', payload.id).select(ASSET_SELECT).single()
    if (error) pgError(error)
    return data as HRAsset
  }
  const { data, error } = await supabase.from('hr_assets').insert(payload).select(ASSET_SELECT).single()
  if (error) pgError(error)
  return data as HRAsset
}

export async function deleteAsset(id: string) {
  const { error } = await supabase.from('hr_assets').delete().eq('id', id)
  if (error) pgError(error)
}

// =============================================================================
// Time Clock (บันทึกเวลาเข้า-ออกงานด้วย GPS + กล้อง)
// =============================================================================

/** ระยะทางระหว่างพิกัด 2 จุด (เมตร) — สูตร Haversine */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// ─── Clock Locations (จุดพิกัดออฟฟิศ) ───────────────────────────────────────

export async function fetchClockLocations(activeOnly = false) {
  let q = supabase.from('hr_clock_locations').select('*').order('created_at', { ascending: true })
  if (activeOnly) q = q.eq('is_active', true)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRClockLocation[]
}

export async function upsertClockLocation(loc: Partial<HRClockLocation>) {
  if (loc.id) {
    const { data, error } = await supabase
      .from('hr_clock_locations').update(loc).eq('id', loc.id).select().single()
    if (error) pgError(error)
    return data as HRClockLocation
  }
  const { data, error } = await supabase
    .from('hr_clock_locations').insert(loc).select().single()
  if (error) pgError(error)
  return data as HRClockLocation
}

export async function deleteClockLocation(id: string) {
  const { error } = await supabase.from('hr_clock_locations').delete().eq('id', id)
  if (error) pgError(error)
}

// ─── Work Schedules (มาตรฐานเวลาทำงานหลายชุด) ──────────────────────────────

export async function fetchWorkSchedules(activeOnly = false) {
  let q = supabase.from('hr_work_schedules').select('*').order('created_at', { ascending: true })
  if (activeOnly) q = q.eq('is_active', true)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRWorkSchedule[]
}

export async function upsertWorkSchedule(s: Partial<HRWorkSchedule>) {
  if (s.id) {
    const { data, error } = await supabase
      .from('hr_work_schedules').update(s).eq('id', s.id).select().single()
    if (error) pgError(error)
    return data as HRWorkSchedule
  }
  const { data, error } = await supabase
    .from('hr_work_schedules').insert(s).select().single()
  if (error) pgError(error)
  return data as HRWorkSchedule
}

export async function deleteWorkSchedule(id: string) {
  const { error } = await supabase.from('hr_work_schedules').delete().eq('id', id)
  if (error) pgError(error)
}

// ─── Time Entries (บันทึกเวลา) ──────────────────────────────────────────────

const TIME_ENTRY_SELECT = '*, employee:hr_employees!employee_id(id, employee_code, first_name, last_name, nickname, work_schedule_id, department:hr_departments!department_id(name))'

export async function fetchTimeEntries(filters?: {
  employee_id?: string
  date_from?: string
  date_to?: string
  entry_type?: string
  limit?: number
}) {
  let q = supabase.from('hr_time_entries')
    .select(TIME_ENTRY_SELECT)
    .order('entry_time', { ascending: false })
  if (filters?.employee_id) q = q.eq('employee_id', filters.employee_id)
  if (filters?.date_from) q = q.gte('work_date', filters.date_from)
  if (filters?.date_to) q = q.lte('work_date', filters.date_to)
  if (filters?.entry_type) q = q.eq('entry_type', filters.entry_type)
  q = q.limit(filters?.limit ?? 1000)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HRTimeEntry[]
}

export async function createTimeEntry(entry: Partial<HRTimeEntry>) {
  const payload = { ...entry }
  delete payload.employee
  const { data, error } = await supabase
    .from('hr_time_entries').insert(payload).select().single()
  if (error) pgError(error)
  return data as HRTimeEntry
}

/** อัปโหลดรูปถ่ายตอนบันทึกเวลา (บังคับถ่ายจากกล้อง) → คืน path ใน bucket */
export async function uploadTimeClockPhoto(employeeId: string, blob: Blob) {
  const path = `${employeeId}/${Date.now()}.jpg`
  const { data, error } = await supabase.storage.from('hr-time-clock').upload(path, blob, {
    contentType: 'image/jpeg',
    cacheControl: '3600',
    upsert: false,
  })
  if (error) pgError(error)
  return data.path
}

/** bucket hr-time-clock เป็น private → ใช้ signed URL */
export async function getTimeClockPhotoUrl(path: string, expiresInSec = 3600) {
  const { data, error } = await supabase.storage.from('hr-time-clock').createSignedUrl(path, expiresInSec)
  if (error) pgError(error)
  return data.signedUrl
}

/** ขอ signed URL หลายรูปในคำขอเดียว → คืน map path → url (สำหรับ thumbnail ในตาราง) */
export async function getTimeClockPhotoUrls(paths: string[], expiresInSec = 3600) {
  if (paths.length === 0) return {} as Record<string, string>
  const { data, error } = await supabase.storage.from('hr-time-clock').createSignedUrls(paths, expiresInSec)
  if (error) pgError(error)
  const map: Record<string, string> = {}
  for (const d of data) {
    if (d.path && d.signedUrl) map[d.path] = d.signedUrl
  }
  return map
}

// ─── OT Requests (คำขอ OT) ──────────────────────────────────────────────────

export async function fetchOTRequests(filters?: { status?: string; employee_id?: string; date_from?: string; date_to?: string }) {
  let q = supabase.from('hr_ot_requests')
    .select(TIME_ENTRY_SELECT)
    .order('created_at', { ascending: false })
  if (filters?.status) q = q.eq('status', filters.status)
  if (filters?.employee_id) q = q.eq('employee_id', filters.employee_id)
  if (filters?.date_from) q = q.gte('request_date', filters.date_from)
  if (filters?.date_to) q = q.lte('request_date', filters.date_to)
  const { data, error } = await q
  if (error) pgError(error)
  return data as HROTRequest[]
}

export async function createOTRequest(req: Partial<HROTRequest>) {
  const payload = { ...req }
  delete payload.employee
  const { data, error } = await supabase
    .from('hr_ot_requests').insert(payload).select().single()
  if (error) pgError(error)
  return data as HROTRequest
}

export async function updateOTRequest(id: string, updates: Partial<HROTRequest>) {
  const payload = { ...updates }
  delete payload.employee
  const { data, error } = await supabase
    .from('hr_ot_requests').update(payload).eq('id', id).select().single()
  if (error) pgError(error)
  return data as HROTRequest
}
