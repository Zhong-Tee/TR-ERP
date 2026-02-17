/**
 * QC System API: work orders, items by WO, settings_reasons, ink_types, storage URL.
 */
import { supabase } from './supabase'
import type { QCItem, WorkOrder, SettingsReason } from '../types'

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
      .select('session_id, item_uid, status')
      .in('session_id', allSessionIds)
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
    .select('id, order_id, item_uid, product_id, product_name, quantity, ink_color, font, cartoon_pattern, line_1, line_2, line_3, notes')
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
