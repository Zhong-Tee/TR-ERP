import { supabase } from './supabase'

export type KnowledgeTaskStatus = 'todo' | 'in_progress' | 'review' | 'active'

export interface KnowledgeTask {
  id: string
  task_code: string
  title: string
  description: string | null
  status: KnowledgeTaskStatus
  due_date: string | null
  created_at: string
  updated_at: string
}

export interface KnowledgeTaskInput {
  title: string
  description: string
  status: KnowledgeTaskStatus
  due_date: string | null
}

/** @deprecated เวอร์ชันถูกย้ายไปใช้กับข้อมูล Knowledge แล้ว */
export interface KnowledgeTaskVersion {
  id: string
  task_id: string
  version_no: number
  title: string
  description: string | null
  status: KnowledgeTaskStatus
  due_date: string | null
  saved_at: string
}

const TASK_COLUMNS = 'id,task_code,title,description,status,due_date,created_at,updated_at'

export async function fetchKnowledgeTasks(): Promise<KnowledgeTask[]> {
  const { data, error } = await supabase.from('kb_tasks').select(TASK_COLUMNS).order('updated_at', { ascending: false })
  if (error) throw error
  return (data || []) as KnowledgeTask[]
}

export async function saveKnowledgeTask(input: KnowledgeTaskInput, id?: string): Promise<void> {
  const payload = { ...input, title: input.title.trim(), description: input.description.trim() || null }
  const result = id
    ? await supabase.from('kb_tasks').update(payload).eq('id', id)
    : await supabase.from('kb_tasks').insert({ ...payload, task_code: null })
  if (result.error) throw result.error
}

export async function deleteKnowledgeTask(id: string): Promise<void> {
  const { error } = await supabase.from('kb_tasks').delete().eq('id', id)
  if (error) throw error
}

/** @deprecated คงไว้ชั่วคราวสำหรับ UI เก่าที่ซ่อนแล้ว */
export async function fetchKnowledgeTaskVersions(taskId: string): Promise<KnowledgeTaskVersion[]> {
  const { data, error } = await supabase.from('kb_task_versions').select('*').eq('task_id', taskId).order('version_no', { ascending: false })
  if (error) throw error
  return (data || []) as KnowledgeTaskVersion[]
}

/** @deprecated เวอร์ชันถูกย้ายไปใช้กับข้อมูล Knowledge แล้ว */
export async function restoreKnowledgeTaskVersion(taskId: string, version: KnowledgeTaskVersion): Promise<void> {
  const { error } = await supabase.from('kb_tasks').update({ title: version.title, description: version.description, status: version.status, due_date: version.due_date }).eq('id', taskId)
  if (error) throw error
}
