import { supabase } from './supabase'

export const KNOWLEDGE_BUCKET = 'knowledge-hub'

export type KnowledgeAccessLevel = 'general' | 'restricted' | 'private'

export interface KnowledgeCategory {
  id: string
  name: string
  description: string | null
  sort_order: number
  is_active: boolean
}

export interface KnowledgeMachine {
  id: string
  name: string
}

export interface KnowledgeDepartment {
  id: string
  name: string
}

export interface KnowledgeFile {
  id: string
  item_id: string
  display_name: string
  original_name: string
  storage_path: string
  mime_type: string | null
  file_extension: string | null
  file_size: number
  description: string | null
  searchable_text: string | null
  created_at: string
}

export interface KnowledgeItem {
  id: string
  knowledge_code: string
  title: string
  description: string | null
  content: string | null
  category_id: string | null
  machine_id: string | null
  department_id: string | null
  access_level: KnowledgeAccessLevel
  tags: string[]
  created_by: string
  updated_by: string
  created_at: string
  updated_at: string
  category: Pick<KnowledgeCategory, 'id' | 'name'> | null
  machine: KnowledgeMachine | null
  department: KnowledgeDepartment | null
  files: KnowledgeFile[]
  allowed_roles: string[]
}

export interface KnowledgeItemInput {
  title: string
  description: string
  content: string
  category_id: string | null
  machine_id: string | null
  department_id: string | null
  access_level: KnowledgeAccessLevel
  tags: string[]
  allowed_roles: string[]
}

const ITEM_COLUMNS = 'id,knowledge_code,title,description,content,category_id,machine_id,department_id,access_level,tags,created_by,updated_by,created_at,updated_at'
const FILE_COLUMNS = 'id,item_id,display_name,original_name,storage_path,mime_type,file_extension,file_size,description,searchable_text,created_at'

async function hydrateItems(rows: any[]): Promise<KnowledgeItem[]> {
  if (rows.length === 0) return []
  const itemIds = rows.map((row) => row.id)
  const categoryIds = [...new Set(rows.map((row) => row.category_id).filter(Boolean))]
  const machineIds = [...new Set(rows.map((row) => row.machine_id).filter(Boolean))]
  const departmentIds = [...new Set(rows.map((row) => row.department_id).filter(Boolean))]
  const [categoryResult, machineResult, departmentResult, fileResult, roleResult] = await Promise.all([
    categoryIds.length
      ? supabase.from('kb_categories').select('id,name').in('id', categoryIds)
      : Promise.resolve({ data: [], error: null }),
    machineIds.length
      ? supabase.from('pr_machinery_machines').select('id,name').in('id', machineIds)
      : Promise.resolve({ data: [], error: null }),
    departmentIds.length
      ? supabase.from('hr_departments').select('id,name').in('id', departmentIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from('kb_files').select(FILE_COLUMNS).in('item_id', itemIds).order('created_at'),
    supabase.from('kb_item_roles').select('item_id,role').in('item_id', itemIds),
  ])
  const firstError = categoryResult.error || machineResult.error || departmentResult.error || fileResult.error || roleResult.error
  if (firstError) throw firstError
  const categoryMap = new Map((categoryResult.data || []).map((row: any) => [row.id, row]))
  const machineMap = new Map((machineResult.data || []).map((row: any) => [row.id, row]))
  const departmentMap = new Map((departmentResult.data || []).map((row: any) => [row.id, row]))
  const filesByItem = new Map<string, KnowledgeFile[]>()
  ;(fileResult.data || []).forEach((file: any) => filesByItem.set(file.item_id, [...(filesByItem.get(file.item_id) || []), file]))
  const rolesByItem = new Map<string, string[]>()
  ;(roleResult.data || []).forEach((entry: any) => rolesByItem.set(entry.item_id, [...(rolesByItem.get(entry.item_id) || []), entry.role]))
  return rows.map((row) => ({
    ...row,
    category: row.category_id ? categoryMap.get(row.category_id) || null : null,
    machine: row.machine_id ? machineMap.get(row.machine_id) || null : null,
    department: row.department_id ? departmentMap.get(row.department_id) || null : null,
    files: filesByItem.get(row.id) || [],
    allowed_roles: rolesByItem.get(row.id) || [],
  })) as KnowledgeItem[]
}

export async function fetchKnowledgeItems(): Promise<KnowledgeItem[]> {
  const { data, error } = await supabase
    .from('kb_items')
    .select(ITEM_COLUMNS)
    .order('updated_at', { ascending: false })
    .limit(2000)
  if (error) throw error
  return hydrateItems(data || [])
}

export async function fetchKnowledgeItem(id: string): Promise<KnowledgeItem> {
  const { data, error } = await supabase.from('kb_items').select(ITEM_COLUMNS).eq('id', id).single()
  if (error) throw error
  const [item] = await hydrateItems([data])
  return item
}

export async function fetchKnowledgeCategories(includeInactive = false): Promise<KnowledgeCategory[]> {
  let query = supabase.from('kb_categories').select('*').order('sort_order').order('name')
  if (!includeInactive) query = query.eq('is_active', true)
  const { data, error } = await query
  if (error) throw error
  return data || []
}

export async function fetchKnowledgeMachines(): Promise<KnowledgeMachine[]> {
  const { data, error } = await supabase
    .from('pr_machinery_machines')
    .select('id,name')
    .order('sort_order')
  if (error) throw error
  return data || []
}

export async function fetchKnowledgeDepartments(): Promise<KnowledgeDepartment[]> {
  const { data, error } = await supabase.from('hr_departments').select('id,name').order('name')
  if (error) throw error
  return data || []
}

async function replaceAllowedRoles(itemId: string, roles: string[]) {
  const { error: deleteError } = await supabase.from('kb_item_roles').delete().eq('item_id', itemId)
  if (deleteError) throw deleteError
  if (roles.length === 0) return
  const { error } = await supabase.from('kb_item_roles').insert(roles.map((role) => ({ item_id: itemId, role })))
  if (error) throw error
}

export async function createKnowledgeItem(input: KnowledgeItemInput): Promise<string> {
  const { allowed_roles, ...item } = input
  const { data, error } = await supabase
    .from('kb_items')
    .insert({ ...item, knowledge_code: null })
    .select('id')
    .single()
  if (error) throw error
  await replaceAllowedRoles(data.id, input.access_level === 'restricted' ? allowed_roles : [])
  return data.id
}

export async function updateKnowledgeItem(id: string, input: KnowledgeItemInput): Promise<void> {
  const { allowed_roles, ...item } = input
  const { error } = await supabase.from('kb_items').update(item).eq('id', id)
  if (error) throw error
  await replaceAllowedRoles(id, input.access_level === 'restricted' ? allowed_roles : [])
}

const SEARCHABLE_EXTENSIONS = new Set(['json', 'txt', 'csv', 'xml', 'yaml', 'yml', 'js', 'ts', 'md', 'sql', 'ini', 'cfg', 'conf'])

async function searchableFileText(file: File, extension: string): Promise<string | null> {
  if (!SEARCHABLE_EXTENSIONS.has(extension) || file.size > 1024 * 1024) return null
  try {
    return (await file.text()).slice(0, 200_000)
  } catch {
    return null
  }
}

export async function uploadKnowledgeFiles(itemId: string, files: File[]): Promise<void> {
  for (const file of files) {
    const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : ''
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_')
    const storagePath = `${itemId}/${crypto.randomUUID()}-${safeName}`
    const { error: uploadError } = await supabase.storage.from(KNOWLEDGE_BUCKET).upload(storagePath, file, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })
    if (uploadError) throw uploadError
    const { error: rowError } = await supabase.from('kb_files').insert({
      item_id: itemId,
      display_name: file.name,
      original_name: file.name,
      storage_path: storagePath,
      mime_type: file.type || null,
      file_extension: extension || null,
      file_size: file.size,
      searchable_text: await searchableFileText(file, extension),
    })
    if (rowError) {
      await supabase.storage.from(KNOWLEDGE_BUCKET).remove([storagePath])
      throw rowError
    }
  }
}

export async function downloadKnowledgeFile(file: KnowledgeFile): Promise<void> {
  const { data, error } = await supabase.storage.from(KNOWLEDGE_BUCKET).createSignedUrl(file.storage_path, 60, {
    download: file.original_name,
  })
  if (error) throw error
  window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
}

export async function deleteKnowledgeFile(file: KnowledgeFile): Promise<void> {
  const { error: storageError } = await supabase.storage.from(KNOWLEDGE_BUCKET).remove([file.storage_path])
  if (storageError) throw storageError
  const { error } = await supabase.from('kb_files').delete().eq('id', file.id)
  if (error) throw error
}

export async function deleteKnowledgeItem(item: KnowledgeItem): Promise<void> {
  const paths = item.files.map((file) => file.storage_path)
  if (paths.length) {
    const { error: storageError } = await supabase.storage.from(KNOWLEDGE_BUCKET).remove(paths)
    if (storageError) throw storageError
  }
  const { error } = await supabase.from('kb_items').delete().eq('id', item.id)
  if (error) throw error
}

export async function saveKnowledgeCategory(category: Partial<KnowledgeCategory> & { name: string }): Promise<void> {
  if (category.id) {
    const { error } = await supabase.from('kb_categories').update({
      name: category.name,
      description: category.description || null,
      sort_order: category.sort_order || 0,
      is_active: category.is_active ?? true,
    }).eq('id', category.id)
    if (error) throw error
    return
  }
  const { error } = await supabase.from('kb_categories').insert({
    name: category.name,
    description: category.description || null,
    sort_order: category.sort_order || 0,
    is_active: category.is_active ?? true,
  })
  if (error) throw error
}
