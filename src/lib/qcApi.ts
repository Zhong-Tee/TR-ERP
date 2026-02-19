/**
 * QC System API: work orders, items by WO, settings_reasons, ink_types, storage URL.
 */
import { supabase } from './supabase'
import * as XLSX from 'xlsx'
import type { QCItem, WorkOrder, SettingsReason, QCChecklistTopic, QCChecklistItem, QCChecklistTopicProduct } from '../types'

const QC_SELECTED_WORK_ORDER = 'qc_selected_work_order'
const QC_TEMP_SESSION = 'qc_temp_session'

export { QC_SELECTED_WORK_ORDER, QC_TEMP_SESSION }

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''

/** Get public URL for Supabase storage (Product_Pic, Cartoon_Pic). */
export function getPublicUrl(bucket: string, filename: string | null | undefined, ext: string = '.jpg'): string {
  if (!filename || filename === '0' || String(filename).trim() === '') return ''
  let name = String(filename).trim()
  if (!name.includes('.')) name += ext
  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${encodeURIComponent(name)}`
}

/** Load all work orders (for QC WO selector). */
export async function fetchWorkOrders(): Promise<WorkOrder[]> {
  const { data, error } = await supabase
    .from('or_work_orders')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

/** Work order with QC progress: total items, pass/fail/remaining counts (items & bills). */
export interface WorkOrderWithProgress extends WorkOrder {
  total_items: number
  qc_done: number
  remaining: number
  pass_items: number
  fail_items: number
  total_bills: number
  pass_bills: number
  fail_bills: number
  remaining_bills: number
}

/** Load work orders with QC progress. Excludes WOs that are fully QC'd (remaining === 0) when excludeCompleted is true. */
export async function fetchWorkOrdersWithProgress(excludeCompleted = true): Promise<WorkOrderWithProgress[]> {
  const { data: woList, error: woErr } = await supabase
    .from('or_work_orders')
    .select('*')
    .order('created_at', { ascending: false })
  if (woErr) throw woErr
  if (!woList?.length) return []

  const woNames = woList.map((w) => w.work_order_name)

  const { data: orders, error: ordErr } = await supabase
    .from('or_orders')
    .select('id, work_order_name')
    .in('work_order_name', woNames)
  if (ordErr) throw ordErr
  const orderIdsByWo: Record<string, string[]> = {}
  woNames.forEach((n) => (orderIdsByWo[n] = []))
  ;(orders || []).forEach((o) => {
    if (orderIdsByWo[o.work_order_name]) orderIdsByWo[o.work_order_name].push(o.id)
  })

  const allOrderIds = (orders || []).map((o) => o.id)
  if (allOrderIds.length === 0) {
    return woList.map((wo) => ({
      ...wo,
      total_items: 0,
      qc_done: 0,
      remaining: 0,
      pass_items: 0,
      fail_items: 0,
      total_bills: 0,
      pass_bills: 0,
      fail_bills: 0,
      remaining_bills: 0,
    }))
  }

  // ดึง items พร้อม item_uid + order_id เพื่อ mapping กลับไปที่ bill
  const { data: items, error: itemsErr } = await supabase
    .from('or_order_items')
    .select('order_id, item_uid')
    .in('order_id', allOrderIds)
  if (itemsErr) throw itemsErr

  const totalByOrderId: Record<string, number> = {}
  // mapping: item_uid → order_id (เพื่อรู้ว่า item อยู่ bill ไหน)
  const itemUidToOrderId: Record<string, string> = {}
  // mapping: order_id → item_uids (ทุก item ใน bill นั้น)
  const itemUidsByOrderId: Record<string, string[]> = {}
  ;(items || []).forEach((row) => {
    totalByOrderId[row.order_id] = (totalByOrderId[row.order_id] || 0) + 1
    if (row.item_uid) {
      itemUidToOrderId[row.item_uid] = row.order_id
      if (!itemUidsByOrderId[row.order_id]) itemUidsByOrderId[row.order_id] = []
      itemUidsByOrderId[row.order_id].push(row.item_uid)
    }
  })

  const totalByWo: Record<string, number> = {}
  woNames.forEach((name) => {
    const ids = orderIdsByWo[name] || []
    totalByWo[name] = ids.reduce((sum, id) => sum + (totalByOrderId[id] || 0), 0)
  })

  // ดึง sessions ทั้งหมด (รวม session ที่ยังเปิดอยู่) พร้อม end_time เพื่อเช็ค open session
  const { data: allSessions, error: sessErr } = await supabase
    .from('qc_sessions')
    .select('id, filename, end_time')
  if (sessErr) throw sessErr
  const sessionIdsByWo: Record<string, string[]> = {}
  const hasOpenSessionByWo: Record<string, boolean> = {}
  woNames.forEach((n) => { sessionIdsByWo[n] = []; hasOpenSessionByWo[n] = false })
  ;(allSessions || []).forEach((s) => {
    const match = s.filename?.match(/^WO-(.+)$/)
    if (match && woNames.includes(match[1])) {
      sessionIdsByWo[match[1]].push(s.id)
      if (!s.end_time) hasOpenSessionByWo[match[1]] = true
    }
  })

  // ดึง qc_records พร้อม item_uid + status เพื่อคำนวณ pass/fail ทั้ง item level และ bill level
  const allSessionIds = (allSessions || []).map((s) => s.id)
  // mapping: item_uid → status (ล่าสุด)
  const itemStatusMap: Record<string, string> = {}
  let qcPassBySession: Record<string, number> = {}
  if (allSessionIds.length > 0) {
    const { data: records, error: recErr } = await supabase
      .from('qc_records')
      .select('session_id, item_uid, status, created_at')
      .in('session_id', allSessionIds)
      .order('created_at', { ascending: true })
    if (!recErr && records?.length) {
      records.forEach((r) => {
        // เก็บ status ล่าสุดของแต่ละ item_uid
        itemStatusMap[r.item_uid] = r.status
        if (r.status === 'pass') {
          qcPassBySession[r.session_id] = (qcPassBySession[r.session_id] || 0) + 1
        }
      })
    }
  }

  const qcDoneByWo: Record<string, number> = {}
  woNames.forEach((name) => {
    const sids = sessionIdsByWo[name] || []
    qcDoneByWo[name] = sids.reduce((sum, sid) => sum + (qcPassBySession[sid] || 0), 0)
  })

  const result: WorkOrderWithProgress[] = woList.map((wo) => {
    const woName = wo.work_order_name
    const total_items = totalByWo[woName] ?? 0
    const qc_done = qcDoneByWo[woName] ?? 0
    const orderIds = orderIdsByWo[woName] || []
    const total_bills = orderIds.length

    // คำนวณ pass/fail ระดับ item
    let pass_items = 0
    let fail_items = 0
    orderIds.forEach((orderId) => {
      const uids = itemUidsByOrderId[orderId] || []
      uids.forEach((uid) => {
        const st = itemStatusMap[uid]
        if (st === 'pass') pass_items++
        else if (st === 'fail') fail_items++
      })
    })
    const remaining = Math.max(0, total_items - pass_items - fail_items)

    // คำนวณ pass/fail ระดับ bill
    let pass_bills = 0
    let fail_bills = 0
    orderIds.forEach((orderId) => {
      const uids = itemUidsByOrderId[orderId] || []
      if (uids.length === 0) return
      const statuses = uids.map((uid) => itemStatusMap[uid] || 'pending')
      if (statuses.every((s) => s === 'pass')) pass_bills++
      else if (statuses.some((s) => s === 'fail')) fail_bills++
    })
    const remaining_bills = total_bills - pass_bills - fail_bills

    return { ...wo, total_items, qc_done, remaining, pass_items, fail_items, total_bills, pass_bills, fail_bills, remaining_bills }
  })

  // ไม่กรองออกถ้ายังมี session เปิดอยู่ (ยังไม่กด Finish Job) แม้ remaining จะ = 0
  if (excludeCompleted) return result.filter((r) => r.remaining > 0 || hasOpenSessionByWo[r.work_order_name])
  return result
}

/** Load order items for a work order and map to QCItem[] (for QC Operation session). */
export async function fetchItemsByWorkOrder(workOrderName: string): Promise<QCItem[]> {
  const { data: orders, error: ordersErr } = await supabase
    .from('or_orders')
    .select('id, bill_no')
    .eq('work_order_name', workOrderName)
  if (ordersErr) throw ordersErr
  if (!orders?.length) return []

  const orderIds = orders.map((o) => o.id)
  const billByOrderId: Record<string, string> = {}
  orders.forEach((o) => { billByOrderId[o.id] = o.bill_no || '' })

  const { data: items, error: itemsErr } = await supabase
    .from('or_order_items')
    .select('id, order_id, item_uid, product_id, product_name, quantity, ink_color, font, cartoon_pattern, line_1, line_2, line_3, notes, file_attachment')
    .in('order_id', orderIds)
  if (itemsErr) throw itemsErr
  if (!items?.length) return []

  const productIds = [...new Set(items.map((i) => i.product_id).filter(Boolean))] as string[]
  let productCodeMap: Record<string, string> = {}
  let productCategoryMap: Record<string, string | null> = {}
  if (productIds.length > 0) {
    const { data: products } = await supabase
      .from('pr_products')
      .select('id, product_code, product_category')
      .in('id', productIds)
    if (products) {
      products.forEach((p) => {
        productCodeMap[p.id] = p.product_code || ''
        productCategoryMap[p.id] = p.product_category ?? null
      })
    }
  }

  const qcItems: QCItem[] = items.map((row) => ({
    uid: row.item_uid || '',
    product_code: row.product_id ? (productCodeMap[row.product_id] || '0') : '0',
    product_name: row.product_name || '',
    product_category: row.product_id ? (productCategoryMap[row.product_id] ?? null) : null,
    bill_no: billByOrderId[row.order_id] || '',
    ink_color: row.ink_color ?? null,
    font: row.font ?? null,
    floor: '-',
    cartoon_name: row.cartoon_pattern ?? '0',
    line1: row.line_1 ?? '',
    line2: row.line_2 ?? '',
    line3: row.line_3 ?? '',
    qty: row.quantity ?? 1,
    remark: row.notes ?? '',
    file_attachment: row.file_attachment ?? null,
    status: 'pending',
  }))
  return qcItems
}

/** Get open QC session for work order (end_time is null). */
export async function fetchOpenSessionForWo(workOrderName: string): Promise<{ id: string; filename: string; start_time: string } | null> {
  const filename = `WO-${workOrderName}`
  const { data, error } = await supabase
    .from('qc_sessions')
    .select('id, filename, start_time')
    .eq('filename', filename)
    .is('end_time', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

/** Load qc_records for a session (to restore Pass/Fail history). */
export async function fetchRecordsForSession(sessionId: string) {
  const { data, error } = await supabase
    .from('qc_records')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

/** Save one QC record (Pass/Fail) — upsert by session_id + item_uid. */
export async function saveQcRecord(
  sessionId: string,
  item: { uid: string; status: 'pass' | 'fail' | 'pending'; fail_reason?: string | null; product_code?: string; product_name?: string; bill_no?: string; ink_color?: string | null; font?: string | null; floor?: string; cartoon_name?: string; line1?: string; line2?: string; line3?: string; qty?: number; remark?: string },
  qcBy: string
) {
  const row = {
    session_id: sessionId,
    item_uid: item.uid,
    qc_by: qcBy,
    status: item.status,
    fail_reason: item.fail_reason ?? null,
    is_rejected: item.status === 'fail',
    retry_count: 1,
    product_code: item.product_code ?? '',
    product_name: item.product_name ?? '',
    bill_no: item.bill_no ?? '',
    ink_color: item.ink_color ?? null,
    font: item.font ?? null,
    floor: item.floor ?? '',
    cartoon_name: item.cartoon_name ?? '',
    line1: item.line1 ?? '',
    line2: item.line2 ?? '',
    line3: item.line3 ?? '',
    qty: item.qty ?? 1,
    remark: item.remark ?? null,
  }
  const { error } = await supabase.from('qc_records').upsert(row, {
    onConflict: 'session_id,item_uid',
  })
  if (error) throw error
}

/** Load settings_reasons for FAIL dropdown (tree: top-level + children). */
export async function fetchSettingsReasons(): Promise<SettingsReason[]> {
  const { data, error } = await supabase
    .from('settings_reasons')
    .select('id, reason_text, fail_type, parent_id, created_at')
    .order('reason_text')
  if (error) throw error
  const all: SettingsReason[] = data || []
  const topLevel = all.filter((r) => !r.parent_id)
  topLevel.forEach((parent) => {
    parent.children = all.filter((r) => r.parent_id === parent.id)
  })
  return topLevel
}

/** Load flat list of all settings_reasons (including sub-reasons). */
export async function fetchAllReasonsFlat(): Promise<SettingsReason[]> {
  const { data, error } = await supabase
    .from('settings_reasons')
    .select('id, reason_text, fail_type, parent_id, created_at')
    .order('reason_text')
  if (error) throw error
  return data || []
}

/** Load ink_types (id, ink_name, hex_code) for QC ink color display. */
export async function fetchInkTypes() {
  const { data, error } = await supabase
    .from('ink_types')
    .select('id, ink_name, hex_code, created_at')
    .order('ink_name')
  if (error) throw error
  return data || []
}

/** Get saved selected work order name from localStorage. */
export function getSavedWorkOrderName(): string | null {
  try {
    return localStorage.getItem(QC_SELECTED_WORK_ORDER)
  } catch {
    return null
  }
}

/** Save selected work order name to localStorage. */
export function saveWorkOrderName(name: string | null): void {
  try {
    if (name) localStorage.setItem(QC_SELECTED_WORK_ORDER, name)
    else localStorage.removeItem(QC_SELECTED_WORK_ORDER)
  } catch {}
}

/** Parse backup session from localStorage (qcState + qcData). */
export function getSessionBackup(): { qcState: { step: string; startTime: string | null; filename: string; sessionId: string | null }; qcData: { items: QCItem[] }; lastUpdated?: string } | null {
  try {
    const raw = localStorage.getItem(QC_TEMP_SESSION)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (data?.qcState && data?.qcData) return data
    return null
  } catch {
    return null
  }
}

/** Save session backup to localStorage. */
export function setSessionBackup(qcState: { step: string; startTime: Date | null; filename: string; sessionId: string | null }, qcData: { items: QCItem[] }): void {
  try {
    localStorage.setItem(
      QC_TEMP_SESSION,
      JSON.stringify({
        qcState: {
          step: qcState.step,
          startTime: qcState.startTime?.toISOString?.() ?? null,
          filename: qcState.filename,
          sessionId: qcState.sessionId ?? null,
        },
        qcData: { items: qcData.items },
        lastUpdated: new Date().toISOString(),
      })
    )
  } catch {}
}

/** Clear session backup. */
export function clearSessionBackup(): void {
  try {
    localStorage.removeItem(QC_TEMP_SESSION)
  } catch {}
}

/** Load rejected qc_records (is_rejected = true) for Reject Management. */
export async function fetchRejectItems() {
  const { data, error } = await supabase
    .from('qc_records')
    .select('*')
    .eq('is_rejected', true)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

/** Load qc_sessions for Reports (filter by date and optional user). */
export async function fetchReports(params: { startDate: string; endDate: string; user?: string }) {
  let query = supabase
    .from('qc_sessions')
    .select('*')
    .gte('created_at', `${params.startDate}T00:00:00`)
    .lte('created_at', `${params.endDate}T23:59:59`)
    .not('end_time', 'is', null)
  if (params.user) query = query.eq('username', params.user)
  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

/** Load qc_records by session_id (for session detail modal and CSV). */
export async function fetchSessionRecords(sessionId: string) {
  const { data, error } = await supabase
    .from('qc_records')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

/** Search qc_records by item_uid (History Check). */
export async function searchHistoryByUid(itemUid: string) {
  const { data, error } = await supabase
    .from('qc_records')
    .select('*')
    .ilike('item_uid', itemUid)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

/** Get us_users list for report filter — only qc_staff role. */
export async function fetchReportUsers(): Promise<{ id: string; username: string | null }[]> {
  const { data, error } = await supabase
    .from('us_users')
    .select('id, username')
    .eq('role', 'qc_staff')
  if (error) throw error
  return data || []
}

/** Settings: add top-level reason. */
export async function addReason(reasonText: string, failType: string) {
  const { error } = await supabase.from('settings_reasons').insert({ reason_text: reasonText, fail_type: failType })
  if (error) throw error
}

/** Settings: add sub-reason (inherits fail_type from parent). */
export async function addSubReason(parentId: string, reasonText: string, failType: string) {
  const { error } = await supabase.from('settings_reasons').insert({ reason_text: reasonText, fail_type: failType, parent_id: parentId })
  if (error) throw error
}

/** Settings: delete reason. */
export async function deleteReason(id: string) {
  const { error } = await supabase.from('settings_reasons').delete().eq('id', id)
  if (error) throw error
}

/** Settings: update reason fail_type (4M category). */
export async function updateReasonType(id: string, failType: string) {
  const { error } = await supabase.from('settings_reasons').update({ fail_type: failType }).eq('id', id)
  if (error) throw error
}

/** Settings: update ink hex_code (ink_types). */
export async function updateInkHex(id: number, hexCode: string) {
  const { error } = await supabase.from('ink_types').update({ hex_code: hexCode }).eq('id', id)
  if (error) throw error
}

// ============================================
// QC Checklist API
// ============================================

/** Load all checklist topics with item/product counts. */
export async function fetchChecklistTopics(): Promise<QCChecklistTopic[]> {
  const { data: topics, error } = await supabase
    .from('qc_checklist_topics')
    .select('*')
    .order('sort_order')
    .order('created_at')
  if (error) throw error
  if (!topics || topics.length === 0) return []

  const ids = topics.map((t: any) => t.id)

  const { data: items } = await supabase
    .from('qc_checklist_items')
    .select('topic_id')
    .in('topic_id', ids)

  const { data: products } = await supabase
    .from('qc_checklist_topic_products')
    .select('topic_id')
    .in('topic_id', ids)

  const itemCounts: Record<string, number> = {}
  const prodCounts: Record<string, number> = {}
  items?.forEach((i: any) => { itemCounts[i.topic_id] = (itemCounts[i.topic_id] || 0) + 1 })
  products?.forEach((p: any) => { prodCounts[p.topic_id] = (prodCounts[p.topic_id] || 0) + 1 })

  return topics.map((t: any) => ({
    ...t,
    items_count: itemCounts[t.id] || 0,
    products_count: prodCounts[t.id] || 0,
  }))
}

export async function createChecklistTopic(name: string): Promise<QCChecklistTopic> {
  const { data, error } = await supabase
    .from('qc_checklist_topics')
    .insert({ name })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateChecklistTopic(id: string, name: string) {
  const { error } = await supabase
    .from('qc_checklist_topics')
    .update({ name })
    .eq('id', id)
  if (error) throw error
}

export async function deleteChecklistTopic(id: string) {
  const { error } = await supabase
    .from('qc_checklist_topics')
    .delete()
    .eq('id', id)
  if (error) throw error
}

export async function fetchChecklistItems(topicId: string): Promise<QCChecklistItem[]> {
  const { data, error } = await supabase
    .from('qc_checklist_items')
    .select('*')
    .eq('topic_id', topicId)
    .order('sort_order')
    .order('created_at')
  if (error) throw error
  return data || []
}

export async function createChecklistItem(
  topicId: string,
  title: string,
  fileUrl?: string | null,
  fileType?: 'image' | 'pdf' | null,
): Promise<QCChecklistItem> {
  const { data, error } = await supabase
    .from('qc_checklist_items')
    .insert({ topic_id: topicId, title, file_url: fileUrl || null, file_type: fileType || null })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteChecklistItem(id: string) {
  const { error } = await supabase
    .from('qc_checklist_items')
    .delete()
    .eq('id', id)
  if (error) throw error
}

export async function fetchChecklistTopicProducts(topicId: string): Promise<QCChecklistTopicProduct[]> {
  const { data, error } = await supabase
    .from('qc_checklist_topic_products')
    .select('*')
    .eq('topic_id', topicId)
    .order('created_at')
  if (error) throw error
  return data || []
}

export async function addChecklistTopicProduct(
  topicId: string,
  productCode: string,
  productName: string,
): Promise<QCChecklistTopicProduct> {
  const { data, error } = await supabase
    .from('qc_checklist_topic_products')
    .insert({ topic_id: topicId, product_code: productCode, product_name: productName })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function removeChecklistTopicProduct(id: string) {
  const { error } = await supabase
    .from('qc_checklist_topic_products')
    .delete()
    .eq('id', id)
  if (error) throw error
}

/** Fetch all checklist items for a product (used in QC Operation). */
export async function fetchChecklistForProduct(productCode: string): Promise<(QCChecklistItem & { topic_name: string })[]> {
  const { data: links, error: linkErr } = await supabase
    .from('qc_checklist_topic_products')
    .select('topic_id')
    .eq('product_code', productCode)
  if (linkErr) throw linkErr
  if (!links || links.length === 0) return []

  const topicIds = [...new Set(links.map((l: any) => l.topic_id))]

  const { data: topics, error: topicErr } = await supabase
    .from('qc_checklist_topics')
    .select('id, name')
    .in('id', topicIds)
  if (topicErr) throw topicErr

  const topicMap: Record<string, string> = {}
  topics?.forEach((t: any) => { topicMap[t.id] = t.name })

  const { data: items, error: itemErr } = await supabase
    .from('qc_checklist_items')
    .select('*')
    .in('topic_id', topicIds)
    .order('sort_order')
    .order('created_at')
  if (itemErr) throw itemErr

  return (items || []).map((item: any) => ({
    ...item,
    topic_name: topicMap[item.topic_id] || '',
  }))
}

export async function uploadChecklistFile(file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'bin'
  const path = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
  const { error } = await supabase.storage
    .from('qc-checklist-files')
    .upload(path, file, { upsert: false })
  if (error) throw error
  const { data: urlData } = supabase.storage.from('qc-checklist-files').getPublicUrl(path)
  return urlData.publicUrl
}

/** Search products from pr_products for linking. */
export async function searchProducts(query: string): Promise<{ product_code: string; product_name: string }[]> {
  const { data, error } = await supabase
    .from('pr_products')
    .select('product_code, product_name')
    .eq('is_active', true)
    .or(`product_code.ilike.%${query}%,product_name.ilike.%${query}%`)
    .limit(20)
  if (error) throw error
  return data || []
}

// ============================================
// Bulk Import / Template
// ============================================

/** Generate and download an Excel template for bulk checklist import. */
export function generateChecklistTemplate() {
  const wb = XLSX.utils.book_new()

  const ws1Data = [
    ['ชื่อหัวข้อใหญ่', 'ชื่อหัวข้อย่อย'],
    ['ตรวจสอบลายเส้น', 'เส้นตรงไม่คด'],
    ['ตรวจสอบลายเส้น', 'ไม่มีรอยขูดขีด'],
    ['ตรวจสอบสี', 'สีตรงตามตัวอย่าง'],
    ['ตรวจสอบสี', 'ไม่มีสีเลอะ'],
  ]
  const ws1 = XLSX.utils.aoa_to_sheet(ws1Data)
  ws1['!cols'] = [{ wch: 30 }, { wch: 30 }]
  XLSX.utils.book_append_sheet(wb, ws1, 'หัวข้อและหัวข้อย่อย')

  const ws2Data = [
    ['ชื่อหัวข้อใหญ่', 'รหัสสินค้า'],
    ['ตรวจสอบลายเส้น', 'SPTR001'],
    ['ตรวจสอบลายเส้น', 'SPTR002'],
    ['ตรวจสอบสี', 'SPTR001'],
  ]
  const ws2 = XLSX.utils.aoa_to_sheet(ws2Data)
  ws2['!cols'] = [{ wch: 30 }, { wch: 20 }]
  XLSX.utils.book_append_sheet(wb, ws2, 'เชื่อมสินค้า')

  XLSX.writeFile(wb, 'QC_Checklist_Template.xlsx')
}

export interface BulkImportResult {
  topicsCreated: number
  topicsExisting: number
  itemsCreated: number
  productsLinked: number
  productsSkipped: number
  errors: string[]
}

/** Import checklist data from an Excel file (2 sheets). */
export async function importChecklistFromExcel(file: File): Promise<BulkImportResult> {
  const result: BulkImportResult = {
    topicsCreated: 0,
    topicsExisting: 0,
    itemsCreated: 0,
    productsLinked: 0,
    productsSkipped: 0,
    errors: [],
  }

  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { type: 'array' })

  // Sheet 1: หัวข้อและหัวข้อย่อย
  const sheet1 = wb.Sheets[wb.SheetNames[0]]
  if (!sheet1) { result.errors.push('ไม่พบ Sheet แรก'); return result }
  const rows1: string[][] = XLSX.utils.sheet_to_json(sheet1, { header: 1, defval: '' })

  // Sheet 2: เชื่อมสินค้า
  const sheet2 = wb.Sheets[wb.SheetNames[1]]
  const rows2: string[][] = sheet2 ? XLSX.utils.sheet_to_json(sheet2, { header: 1, defval: '' }) : []

  // Load existing topics
  const { data: existingTopics } = await supabase
    .from('qc_checklist_topics')
    .select('id, name')
  const topicMap: Record<string, string> = {}
  existingTopics?.forEach((t: any) => { topicMap[t.name.trim()] = t.id })

  // Process Sheet 1 (skip header row)
  for (let i = 1; i < rows1.length; i++) {
    const topicName = String(rows1[i][0] || '').trim()
    const itemTitle = String(rows1[i][1] || '').trim()
    if (!topicName || !itemTitle) continue

    if (!topicMap[topicName]) {
      try {
        const newTopic = await createChecklistTopic(topicName)
        topicMap[topicName] = newTopic.id
        result.topicsCreated++
      } catch (e: any) {
        result.errors.push(`แถว ${i + 1}: สร้างหัวข้อ "${topicName}" ไม่สำเร็จ - ${e?.message || e}`)
        continue
      }
    } else {
      result.topicsExisting++
    }

    try {
      await createChecklistItem(topicMap[topicName], itemTitle)
      result.itemsCreated++
    } catch (e: any) {
      result.errors.push(`แถว ${i + 1}: เพิ่มหัวข้อย่อย "${itemTitle}" ไม่สำเร็จ - ${e?.message || e}`)
    }
  }

  // Process Sheet 2 (skip header row)
  for (let i = 1; i < rows2.length; i++) {
    const topicName = String(rows2[i][0] || '').trim()
    const productCode = String(rows2[i][1] || '').trim()
    if (!topicName || !productCode) continue

    const topicId = topicMap[topicName]
    if (!topicId) {
      result.errors.push(`เชื่อมสินค้า แถว ${i + 1}: ไม่พบหัวข้อ "${topicName}"`)
      continue
    }

    // Look up product name
    const { data: prod } = await supabase
      .from('pr_products')
      .select('product_name')
      .eq('product_code', productCode)
      .single()
    const productName = prod?.product_name || productCode

    try {
      await addChecklistTopicProduct(topicId, productCode, productName)
      result.productsLinked++
    } catch (e: any) {
      if (e?.message?.includes('duplicate') || e?.code === '23505') {
        result.productsSkipped++
      } else {
        result.errors.push(`เชื่อมสินค้า แถว ${i + 1}: "${productCode}" ไม่สำเร็จ - ${e?.message || e}`)
      }
    }
  }

  return result
}
