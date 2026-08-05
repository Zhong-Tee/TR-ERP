import { supabase } from './supabase'

export const HR_REQUEST_BUCKET = 'hr-requests'

export type HRRequestStatus =
  | 'submitted' | 'accepted' | 'more_info' | 'approved_waiting'
  | 'in_progress' | 'resolved' | 'cannot_resolve' | 'rejected'

export interface HRRequestAttachment { name: string; path: string; type: string; size: number }

export interface HRRequest {
  id: string
  created_by_user: string
  employee_id: string | null
  problem_title: string
  time_lost: string
  details: string
  suggested_solution: string
  time_reallocation: string
  attachments: HRRequestAttachment[]
  status: HRRequestStatus
  hr_note: string | null
  received_by: string | null
  received_at: string | null
  created_at: string
  updated_at: string
  employee?: { first_name: string; last_name: string; nickname: string | null; employee_code: string } | null
}

export const HR_REQUEST_STATUS: Record<HRRequestStatus, { label: string; color: string }> = {
  submitted: { label: 'ส่งเรื่องแล้ว', color: 'bg-slate-100 text-slate-700' },
  accepted: { label: 'รับเรื่องแล้ว', color: 'bg-blue-100 text-blue-700' },
  more_info: { label: 'ขอข้อมูลเพิ่มเติม', color: 'bg-amber-100 text-amber-800' },
  approved_waiting: { label: 'อนุมัติคำร้อง (รอแก้ไข)', color: 'bg-violet-100 text-violet-700' },
  in_progress: { label: 'กำลังแก้ไข', color: 'bg-cyan-100 text-cyan-700' },
  resolved: { label: 'แก้ไขแล้ว', color: 'bg-emerald-100 text-emerald-700' },
  cannot_resolve: { label: 'แก้ไขไม่ได้', color: 'bg-orange-100 text-orange-800' },
  rejected: { label: 'ปฏิเสธคำร้อง', color: 'bg-red-100 text-red-700' },
}

/** แปลงค่าที่จัดเก็บแบบ DD:HH:MM เป็นข้อความอ่านง่าย */
export function formatHRRequestDuration(value: string) {
  const [days = 0, hours = 0, minutes = 0] = value.split(':').map((part) => Number(part) || 0)
  return `${String(days).padStart(2, '0')} วัน ${String(hours).padStart(2, '0')} ชั่วโมง ${String(minutes).padStart(2, '0')} นาที`
}

export async function uploadRequestFile(userId: string, requestId: string, file: File) {
  const safe = file.name.replace(/[^a-zA-Z0-9ก-๙._-]/g, '_')
  const path = `${userId}/${requestId}/${Date.now()}-${safe}`
  const { error } = await supabase.storage.from(HR_REQUEST_BUCKET).upload(path, file, { upsert: false })
  if (error) throw error
  return { name: file.name, path, type: file.type, size: file.size } satisfies HRRequestAttachment
}

export async function openRequestAttachment(path: string) {
  const { data, error } = await supabase.storage.from(HR_REQUEST_BUCKET).createSignedUrl(path, 300)
  if (error) throw error
  window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
}

export async function fetchMyHRRequests(): Promise<HRRequest[]> {
  const { data, error } = await supabase.from('hr_requests').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return (data || []) as HRRequest[]
}

export async function fetchAllHRRequests(): Promise<HRRequest[]> {
  const { data, error } = await supabase
    .from('hr_requests')
    .select('*, employee:hr_employees(first_name,last_name,nickname,employee_code)')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []) as HRRequest[]
}
