/**
 * QC System API: work orders, items by WO, settings_reasons, ink_types, storage URL.
 */
import { supabase } from './supabase'
import type { QCItem, WorkOrder } from '../types'

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
  if (productIds.length > 0) {
    const { data: products } = await supabase
      .from('pr_products')
      .select('id, product_code')
      .in('id', productIds)
    if (products) {
      products.forEach((p) => { productCodeMap[p.id] = p.product_code || '' })
    }
  }

  const qcItems: QCItem[] = items.map((row) => ({
    uid: row.item_uid || '',
    product_code: row.product_id ? (productCodeMap[row.product_id] || '0') : '0',
    product_name: row.product_name || '',
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

/** Load settings_reasons for FAIL dropdown. */
export async function fetchSettingsReasons() {
  const { data, error } = await supabase
    .from('settings_reasons')
    .select('id, reason_text, created_at')
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
export function getSessionBackup(): { qcState: { step: string; startTime: string | null; filename: string }; qcData: { items: QCItem[] }; lastUpdated?: string } | null {
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
export function setSessionBackup(qcState: { step: string; startTime: Date | null; filename: string }, qcData: { items: QCItem[] }): void {
  try {
    localStorage.setItem(
      QC_TEMP_SESSION,
      JSON.stringify({
        qcState: {
          step: qcState.step,
          startTime: qcState.startTime?.toISOString?.() ?? null,
          filename: qcState.filename,
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

/** Get us_users list for report filter (username for qc_sessions). */
export async function fetchReportUsers(): Promise<{ id: string; username: string | null }[]> {
  const { data, error } = await supabase
    .from('us_users')
    .select('id, username')
  if (error) throw error
  return data || []
}

/** Settings: add reason. */
export async function addReason(reasonText: string) {
  const { error } = await supabase.from('settings_reasons').insert({ reason_text: reasonText })
  if (error) throw error
}

/** Settings: delete reason. */
export async function deleteReason(id: string) {
  const { error } = await supabase.from('settings_reasons').delete().eq('id', id)
  if (error) throw error
}

/** Settings: update ink hex_code (ink_types). */
export async function updateInkHex(id: number, hexCode: string) {
  const { error } = await supabase.from('ink_types').update({ hex_code: hexCode }).eq('id', id)
  if (error) throw error
}
