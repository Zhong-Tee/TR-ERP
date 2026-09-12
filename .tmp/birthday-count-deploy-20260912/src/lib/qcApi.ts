/**
 * QC System API: work orders, items by WO, settings_reasons, ink_types, storage URL.
 */
import { supabase } from './supabase'
import { buildIlikeOr } from './searchFilter'
import * as XLSX from 'xlsx'
import type { QCItem, QCRecord, WorkOrder, SettingsReason, QCChecklistTopic, QCChecklistItem, QCChecklistTopicProduct, QCCategoryGroup } from '../types'
import { FULFILLMENT_EXCLUDED_ORDER_STATUSES_IN, isOrderAllowedInFulfillmentFlow } from './orderFlowFilter'
import { flatBillUnitUid, normalizedLineQuantity, stableOrderItemUnitKey } from './productionUnits'
import { sortOrderItemsForExport } from './orderItemExportSort'

const QC_SELECTED_WORK_ORDER = 'qc_selected_work_order'
const QC_TEMP_SESSION = 'qc_temp_session'
const QC_QUERY_BATCH_SIZE = 50
const QC_QUERY_PAGE_SIZE = 1000

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
  return fetchAllQueryPages<WorkOrder>((from, to) =>
    supabase
      .from('or_work_orders')
      .select('*')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to)
  )
}

/** Work order with QC progress: total items, pass/fail/remaining counts (items & bills). */
export interface WorkOrderWithProgress extends WorkOrder {
  total_items: number
  qc_done: number
  remaining: number
  pass_items: number
  fail_items: number
  reject_items: number
  total_bills: number
  pass_bills: number
  fail_bills: number
  remaining_bills: number
  /** กำหนดส่งของบิลในใบงาน (เฉพาะบิลที่มี ship_due_at จากเมนู Marketplace) — ใช้แสดงป้าย ส่งด่วน/ล่าช้า */
  due_bills: { ship_due_at: string | null; overdue_at: string | null; shipped_time: string | null }[]
}

type QCProgressRecord = {
  id: string
  session_id: string
  item_uid: string
  order_item_id?: string | null
  unit_index?: number | null
  status: string
  is_rejected: boolean | null
  last_result_at: string | null
}

type QCPaginatedResponse = {
  data: unknown[] | null
  error: unknown
}

/** อ่านทุกหน้า ป้องกันข้อมูลหายเงียบเมื่อ PostgREST จำกัดผลลัพธ์ไว้ 1,000 แถว */
async function fetchAllQueryPages<T>(
  loadPage: (from: number, to: number) => PromiseLike<QCPaginatedResponse>
): Promise<T[]> {
  const result: T[] = []
  let pageStart = 0
  while (true) {
    const { data, error } = await loadPage(pageStart, pageStart + QC_QUERY_PAGE_SIZE - 1)
    if (error) throw error
    const page = (data || []) as T[]
    result.push(...page)
    if (page.length < QC_QUERY_PAGE_SIZE) break
    pageStart += QC_QUERY_PAGE_SIZE
  }
  return result
}

/** แบ่งค่าใน IN(...) ไม่ให้ URL ยาวเกินไป แล้วอ่านผลลัพธ์ทุกหน้าของแต่ละ batch */
async function fetchQueryInBatches<T>(
  values: string[],
  loadPage: (batch: string[], from: number, to: number) => PromiseLike<QCPaginatedResponse>
): Promise<T[]> {
  const uniqueValues = [...new Set(values.filter(Boolean))]
  const result: T[] = []
  for (let batchStart = 0; batchStart < uniqueValues.length; batchStart += QC_QUERY_BATCH_SIZE) {
    const batch = uniqueValues.slice(batchStart, batchStart + QC_QUERY_BATCH_SIZE)
    result.push(...await fetchAllQueryPages<T>((from, to) => loadPage(batch, from, to)))
  }
  return result
}

/** โหลดผล QC แบบ batch เพื่อไม่ให้หน้า QC ยิง 2 queries ต่อใบงานพร้อมกันจนเบราว์เซอร์หรือเครือข่ายล้มเหลว */
async function fetchProgressRecordsBySessionIds(sessionIds: string[]): Promise<QCProgressRecord[]> {
  return fetchQueryInBatches<QCProgressRecord>(sessionIds, (batch, from, to) =>
    supabase
        .from('qc_records')
        .select('id, session_id, item_uid, order_item_id, unit_index, status, is_rejected, last_result_at')
        .in('session_id', batch)
        .order('last_result_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
  )
}

/** Load work orders with QC progress. When excludeCompleted is true, hides WOs only if nothing left to check AND no open QC session (still waiting for Finish). */
export async function fetchWorkOrdersWithProgress(excludeCompleted = true): Promise<WorkOrderWithProgress[]> {
  const woRaw = await fetchWorkOrders()
  if (!woRaw.length) return []

  // กรองใบงานยกเลิก + dedupe ตามชื่อใบงาน (คงแถวล่าสุด) ป้องกันการ์ดซ้ำในหน้า QC
  const latestWoByName: Record<string, WorkOrder> = {}
  ;(woRaw as WorkOrder[]).forEach((wo) => {
    if (!wo?.work_order_name) return
    if (wo.status === 'ยกเลิก') return
    if (!latestWoByName[wo.work_order_name]) latestWoByName[wo.work_order_name] = wo
  })
  const woList = Object.values(latestWoByName)
  if (!woList.length) return []

  const woNames = woList.map((w) => w.work_order_name)

  const orders = await fetchQueryInBatches<{
    id: string
    work_order_name: string
    bill_no: string | null
    ship_due_at: string | null
    overdue_at: string | null
    shipped_time: string | null
  }>(woNames, (batch, from, to) =>
    supabase
      .from('or_orders')
      .select('id, work_order_name, bill_no, ship_due_at, overdue_at, shipped_time')
      .in('work_order_name', batch)
      .not('status', 'in', FULFILLMENT_EXCLUDED_ORDER_STATUSES_IN)
      .order('id', { ascending: true })
      .range(from, to)
  )
  const dueBillsByWo: Record<string, { ship_due_at: string | null; overdue_at: string | null; shipped_time: string | null }[]> = {}
  woNames.forEach((n) => (dueBillsByWo[n] = []))
  ;(orders || []).forEach((o: { work_order_name: string; ship_due_at?: string | null; overdue_at?: string | null; shipped_time?: string | null }) => {
    if (o.ship_due_at && dueBillsByWo[o.work_order_name]) {
      dueBillsByWo[o.work_order_name].push({ ship_due_at: o.ship_due_at, overdue_at: o.overdue_at ?? null, shipped_time: o.shipped_time ?? null })
    }
  })
  const orderIdsByWo: Record<string, string[]> = {}
  woNames.forEach((n) => (orderIdsByWo[n] = []))
  ;(orders || []).forEach((o) => {
    if (orderIdsByWo[o.work_order_name]) orderIdsByWo[o.work_order_name].push(o.id)
  })

  const allOrderIds = orders.map((o) => o.id)
  if (allOrderIds.length === 0) {
    const emptyProgress = woList.map((wo) => ({
      ...wo,
      total_items: 0,
      qc_done: 0,
      remaining: 0,
      pass_items: 0,
      fail_items: 0,
      reject_items: 0,
      total_bills: 0,
      pass_bills: 0,
      fail_bills: 0,
      remaining_bills: 0,
      due_bills: [],
    }))
    if (excludeCompleted) return []
    return emptyProgress
  }

  const items = await fetchQueryInBatches<{
    order_id: string
    item_uid: string | null
    product_id: string | null
    product_name: string | null
    product_type: string | null
    is_detail_row: boolean | null
    parent_item_id: string | null
    quantity: number | null
    created_at: string | null
    id: string
  }>(allOrderIds, (batch, from, to) =>
    supabase
      .from('or_order_items')
      .select('order_id, item_uid, product_id, product_name, product_type, is_detail_row, parent_item_id, quantity, created_at, id')
      .in('order_id', batch)
      .is('cancellation_stock_action', null)
      .order('id', { ascending: true })
      .range(from, to)
  )

  const itemsByOrderId: Record<string, typeof items> = {}
  items.forEach((row) => {
    if (!itemsByOrderId[row.order_id]) itemsByOrderId[row.order_id] = []
    itemsByOrderId[row.order_id].push(row)
  })
  Object.keys(itemsByOrderId).forEach((oid) => {
    itemsByOrderId[oid] = sortOrderItemsForExport(itemsByOrderId[oid])
  })

  const totalByWo: Record<string, number> = {}
  const flatUidsByWo: Record<string, string[]> = {}
  const sourceUidByFlatUid: Record<string, string> = {}
  const stableKeyByFlatUid: Record<string, string> = {}
  woNames.forEach((name) => {
    const oids = orderIdsByWo[name] || []
    const ords = (orders || [])
      .filter((o: { id: string; work_order_name?: string }) => o.work_order_name === name && oids.includes(o.id))
      .sort((a: { bill_no?: string | null; id: string }, b: { bill_no?: string | null; id: string }) => {
        const c = String(a.bill_no || '').localeCompare(String(b.bill_no || ''))
        if (c !== 0) return c
        return String(a.id).localeCompare(String(b.id))
      })
    let unitSum = 0
    const flatList: string[] = []
    ords.forEach((order: { id: string; bill_no?: string | null }) => {
      const bill = String(order.bill_no || '').trim() || '—'
      let seq = 0
      const rows = itemsByOrderId[order.id] || []
      rows.forEach((r) => {
        const n = normalizedLineQuantity(r.quantity)
        for (let i = 0; i < n; i++) {
          seq++
          unitSum++
          const flatUid = flatBillUnitUid(bill, seq)
          flatList.push(flatUid)
          if (r.item_uid) sourceUidByFlatUid[flatUid] = r.item_uid
          stableKeyByFlatUid[flatUid] = stableOrderItemUnitKey(r.id, i + 1)
        }
      })
    })
    totalByWo[name] = unitSum
    flatUidsByWo[name] = flatList
  })

  // เฉพาะ session ของใบงานในรอบนี้ — กันพลาด default row limit ของ API ที่ตัดตารางใหญ่แล้วไม่ได้แถวล่าสุดของ WO
  const woSessionFilenames = [...new Set(woNames.map((n) => `WO-${n}`))]
  const allSessions = await fetchQueryInBatches<{
    id: string
    filename: string
    end_time: string | null
    created_at: string | null
    start_time: string
  }>(woSessionFilenames, (batch, from, to) =>
    supabase
      .from('qc_sessions')
      .select('id, filename, end_time, created_at, start_time')
      .in('filename', batch)
      .order('id', { ascending: true })
      .range(from, to)
  )
  const sessionIdsByWo: Record<string, string[]> = {}
  woNames.forEach((n) => {
    sessionIdsByWo[n] = []
  })
  const hasOpenSessionByWoName: Record<string, boolean> = {}
  allSessions.forEach((s) => {
    const match = s.filename?.match(/^WO-(.+)$/)
    if (!match || !woNames.includes(match[1])) return
    const woKey = match[1]
    sessionIdsByWo[woKey].push(s.id)
    if (s.end_time == null) hasOpenSessionByWoName[woKey] = true
  })

  // โหลดผลของทุก session เป็น batch แทนการยิง 2 queries ต่อใบงานพร้อมกัน
  // และ paginate เพื่อไม่ให้ติด default row limit ของ PostgREST
  const openSessionIdByWo: Record<string, string> = {}
  allSessions.forEach((session) => {
    const match = session.filename?.match(/^WO-(.+)$/)
    if (!match || !woNames.includes(match[1])) return
    if (session.end_time == null) openSessionIdByWo[match[1]] = session.id
  })
  const sessionIdToWo: Record<string, string> = {}
  Object.entries(openSessionIdByWo).forEach(([woName, sessionId]) => { sessionIdToWo[sessionId] = woName })
  const allSessionIds = Object.values(openSessionIdByWo)
  const progressRecords = await fetchProgressRecordsBySessionIds(allSessionIds)
  const latestRecordsByWo: Record<string, QCProgressRecord[]> = {}
  woNames.forEach((name) => (latestRecordsByWo[name] = []))
  progressRecords.forEach((record) => {
    const woName = sessionIdToWo[record.session_id]
    if (woName) latestRecordsByWo[woName].push(record)
  })
  Object.values(latestRecordsByWo).forEach((records) => {
    records.sort((a, b) => new Date(a.last_result_at || 0).getTime() - new Date(b.last_result_at || 0).getTime())
  })

  const result: WorkOrderWithProgress[] = woList.map((wo) => {
    const woName = wo.work_order_name
    const total_items = totalByWo[woName] ?? 0
    const itemStatusMap: Record<string, string> = {}
    const stableStatusMap: Record<string, string> = {}
    const itemRejectedMap: Record<string, boolean> = {}
    const stableRejectedMap: Record<string, boolean> = {}
    ;(latestRecordsByWo[woName] || []).forEach((record) => {
      if (record.order_item_id && record.unit_index) {
        const stableKey = stableOrderItemUnitKey(record.order_item_id, record.unit_index)
        stableStatusMap[stableKey] = record.status
        if (record.is_rejected) stableRejectedMap[stableKey] = true
      } else {
        itemStatusMap[record.item_uid] = record.status
        if (record.is_rejected) itemRejectedMap[record.item_uid] = true
      }
    })
    const orderIds = orderIdsByWo[woName] || []
    const total_bills = orderIds.length

    let pass_items = 0
    let fail_items = 0
    let reject_items = 0
    const woFlat = flatUidsByWo[woName] || []
    woFlat.forEach((uid) => {
      const sourceUid = sourceUidByFlatUid[uid]
      const stableKey = stableKeyByFlatUid[uid]
      const st = (stableKey ? stableStatusMap[stableKey] : undefined) ?? itemStatusMap[uid] ?? (sourceUid ? itemStatusMap[sourceUid] : undefined)
      if (st === 'pass' || st === 'skipped') pass_items++
      else if (st === 'fail') fail_items++
      if ((stableKey ? stableRejectedMap[stableKey] : false) || itemRejectedMap[uid] || (sourceUid ? itemRejectedMap[sourceUid] : false)) reject_items++
    })
    const remaining = Math.max(0, total_items - pass_items - fail_items)
    const qc_done = pass_items

    let pass_bills = 0
    let fail_bills = 0
    orderIds.forEach((orderId) => {
      const orderRow = (orders || []).find((o: { id: string }) => o.id === orderId) as { bill_no?: string | null; id: string } | undefined
      if (!orderRow) return
      const bill = String(orderRow.bill_no || '').trim() || '—'
      const uids: string[] = []
      let seq = 0
      const rows = itemsByOrderId[orderId] || []
      rows.forEach((r) => {
        const n = normalizedLineQuantity(r.quantity)
        for (let i = 0; i < n; i++) {
          seq++
          const flatUid = flatBillUnitUid(bill, seq)
          uids.push(flatUid)
          if (r.item_uid) sourceUidByFlatUid[flatUid] = r.item_uid
          stableKeyByFlatUid[flatUid] = stableOrderItemUnitKey(r.id, i + 1)
        }
      })
      if (uids.length === 0) return
      const statuses = uids.map((uid) => {
        const sourceUid = sourceUidByFlatUid[uid]
        const stableKey = stableKeyByFlatUid[uid]
        return (stableKey ? stableStatusMap[stableKey] : undefined) ?? itemStatusMap[uid] ?? (sourceUid ? itemStatusMap[sourceUid] : undefined) ?? 'pending'
      })
      if (statuses.every((s) => s === 'pass' || s === 'skipped')) pass_bills++
      else if (statuses.some((s) => s === 'fail')) fail_bills++
    })
    const remaining_bills = total_bills - pass_bills - fail_bills

    return { ...wo, total_items, qc_done, remaining, pass_items, fail_items, reject_items, total_bills, pass_bills, fail_bills, remaining_bills, due_bills: dueBillsByWo[woName] || [] }
  })

  // ล่าสุดต่อชื่อใบงาน (วันที่ใหม่สุดก่อน) — ใช้เทียบว่า Plan ปิดขั้น QC แล้วหรือยัง
  const planJobRows = await fetchQueryInBatches<{
    name: string
    tracks: Record<string, unknown>
    date: string
    id: string
  }>(woNames, (batch, from, to) =>
    supabase
      .from('plan_jobs')
      .select('id, name, tracks, date')
      .in('name', batch)
      .order('date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to)
  )
  const latestPlanTracksByName: Record<string, Record<string, unknown> | undefined> = {}
  for (const row of planJobRows) {
    const n = (row as { name?: string }).name
    if (!n || latestPlanTracksByName[n] !== undefined) continue
    latestPlanTracksByName[n] = (row as { tracks?: Record<string, unknown> }).tracks
  }

  const isPlanQcDoneFromTracks = (tracks: Record<string, unknown> | undefined): boolean => {
    const qc = tracks?.QC as Record<string, { start?: string; end?: string }> | undefined
    return !!qc?.['เสร็จแล้ว']?.end
  }

  if (excludeCompleted) {
    return result.filter((r) => {
      const wo = r.work_order_name
      const sessionIds = sessionIdsByWo[wo] || []
      const planTracks = latestPlanTracksByName[wo]
      if (!hasOpenSessionByWoName[wo] && planTracks && isPlanQcDoneFromTracks(planTracks)) return false
      if (r.remaining > 0) return true
      if (sessionIds.length === 0) {
        if (planTracks && !isPlanQcDoneFromTracks(planTracks)) return true
        return false
      }
      // ถ้ายังมี session ใดเปิดอยู่ แสดงไว้เพื่อให้ผู้ตรวจกลับมาปิดงานได้
      return hasOpenSessionByWoName[wo] === true
    })
  }
  return result
}

/** Load order items for a work order and map to QCItem[] (for QC Operation session). */
export async function fetchItemsByWorkOrder(workOrderName: string): Promise<QCItem[]> {
  const orders = await fetchAllQueryPages<{
    id: string
    bill_no: string | null
    ship_due_at: string | null
    overdue_at: string | null
    shipped_time: string | null
  }>((from, to) =>
    supabase
      .from('or_orders')
      .select('id, bill_no, ship_due_at, overdue_at, shipped_time')
      .eq('work_order_name', workOrderName)
      .not('status', 'in', FULFILLMENT_EXCLUDED_ORDER_STATUSES_IN)
      .order('bill_no', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  )
  if (!orders.length) return []

  const orderIds = orders.map((o) => o.id)
  const billByOrderId: Record<string, string> = {}
  const dueByOrderId: Record<string, { ship_due_at: string | null; overdue_at: string | null; shipped_time: string | null }> = {}
  orders.forEach((o) => {
    billByOrderId[o.id] = o.bill_no || ''
    dueByOrderId[o.id] = { ship_due_at: o.ship_due_at ?? null, overdue_at: o.overdue_at ?? null, shipped_time: o.shipped_time ?? null }
  })

  const items = await fetchQueryInBatches<{
    id: string
    order_id: string
    item_uid: string | null
    product_id: string | null
    product_name: string | null
    product_type: string | null
    is_detail_row: boolean | null
    parent_item_id: string | null
    quantity: number | null
    ink_color: string | null
    font: string | null
    cartoon_pattern: string | null
    line_1: string | null
    line_2: string | null
    line_3: string | null
    notes: string | null
    file_attachment: string | null
    created_at: string | null
  }>(orderIds, (batch, from, to) =>
    supabase
      .from('or_order_items')
      .select('id, order_id, item_uid, product_id, product_name, product_type, is_detail_row, parent_item_id, quantity, ink_color, font, cartoon_pattern, line_1, line_2, line_3, notes, file_attachment, created_at')
      .in('order_id', batch)
      .is('cancellation_stock_action', null)
      .order('id', { ascending: true })
      .range(from, to)
  )
  if (!items.length) return []

  const productIds = [...new Set(items.map((i) => i.product_id).filter(Boolean))] as string[]
  let productCodeMap: Record<string, string> = {}
  let productCategoryMap: Record<string, string | null> = {}
  if (productIds.length > 0) {
    const products = await fetchQueryInBatches<{
      id: string
      product_code: string | null
      product_category: string | null
    }>(productIds, (batch, from, to) =>
      supabase
        .from('pr_products')
        .select('id, product_code, product_category')
        .in('id', batch)
        .order('id', { ascending: true })
        .range(from, to)
    )
    products.forEach((p) => {
      productCodeMap[p.id] = p.product_code || ''
      productCategoryMap[p.id] = p.product_category ?? null
    })
  }

  const byOrder: Record<string, typeof items> = {}
  for (const row of items) {
    if (!byOrder[row.order_id]) byOrder[row.order_id] = []
    byOrder[row.order_id].push(row)
  }
  Object.keys(byOrder).forEach((oid) => {
    byOrder[oid] = sortOrderItemsForExport(byOrder[oid])
  })

  const qcItems: QCItem[] = []
  for (const o of orders) {
    const bill = String(billByOrderId[o.id] || '').trim() || '—'
    let seq = 0
    const rows = byOrder[o.id] || []
    for (const row of rows) {
      const copies = normalizedLineQuantity(row.quantity)
      for (let c = 0; c < copies; c++) {
        seq++
        qcItems.push({
          uid: flatBillUnitUid(bill, seq),
          source_order_id: o.id,
          source_order_item_id: row.id,
          unit_index: c + 1,
          source_line_uid: row.item_uid || undefined,
          product_code: row.product_id ? (productCodeMap[row.product_id] || '0') : '0',
          product_name: row.product_name || '',
          product_category: row.product_id ? (productCategoryMap[row.product_id] ?? null) : null,
          bill_no: billByOrderId[o.id] || '',
          ink_color: row.ink_color ?? null,
          font: row.font ?? null,
          floor: row.product_type ?? '-',
          cartoon_name: row.cartoon_pattern ?? '0',
          line1: row.line_1 ?? '',
          line2: row.line_2 ?? '',
          line3: row.line_3 ?? '',
          qty: 1,
          remark: row.notes ?? '',
          file_attachment: row.file_attachment ?? null,
          status: 'pending',
          ship_due_at: dueByOrderId[o.id]?.ship_due_at ?? null,
          overdue_at: dueByOrderId[o.id]?.overdue_at ?? null,
          shipped_time: dueByOrderId[o.id]?.shipped_time ?? null,
        })
      }
    }
  }
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
  return fetchAllQueryPages<QCRecord>((from, to) =>
    supabase
      .from('qc_records')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  )
}

/** Save one QC record (Pass/Fail) — upsert by session_id + item_uid. */
export async function saveQcRecord(
  sessionId: string,
  item: { uid: string; source_order_id?: string; source_order_item_id?: string; unit_index?: number; status: 'pass' | 'fail' | 'pending'; fail_reason?: string | null; product_code?: string; product_name?: string; bill_no?: string; ink_color?: string | null; font?: string | null; floor?: string; cartoon_name?: string; line1?: string; line2?: string; line3?: string; qty?: number; remark?: string },
  qcBy: string,
  attemptStartedAt?: string
) {
  const now = new Date().toISOString()
  const row = {
    session_id: sessionId,
    item_uid: item.uid,
    order_id: item.source_order_id ?? null,
    order_item_id: item.source_order_item_id ?? null,
    unit_index: item.unit_index ?? null,
    result_source: 'manual',
    qc_by: qcBy,
    status: item.status,
    fail_reason: item.fail_reason ?? null,
    is_rejected: item.status === 'fail',
    retry_count: 1,
    workflow_status: item.status === 'pass' ? 'passed' : item.status === 'fail' ? 'waiting_recheck' : 'pending',
    attempt_started_at: item.status === 'fail' ? now : null,
    resolved_at: item.status === 'pass' ? now : null,
    last_result_at: now,
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
  const conflictColumns = item.source_order_item_id && item.unit_index ? 'session_id,order_item_id,unit_index' : 'session_id,item_uid'
  const { data, error } = await supabase.from('qc_records').upsert(row, {
    onConflict: conflictColumns,
  }).select('*').single()
  if (error) throw error
  if (item.status === 'pass' || item.status === 'fail') {
    const { data: session } = await supabase.from('qc_sessions').select('start_time').eq('id', sessionId).maybeSingle()
    const startedAt = attemptStartedAt || session?.start_time || now
    const durationSeconds = Math.max(0, Math.floor((new Date(now).getTime() - new Date(startedAt).getTime()) / 1000))
    const { error: attemptError } = await supabase.from('qc_record_attempts').upsert({
      qc_record_id: data.id,
      session_id: sessionId,
      item_uid: item.uid,
      attempt_no: 1,
      attempt_type: 'initial',
      result: item.status,
      fail_reason: item.status === 'fail' ? item.fail_reason ?? null : null,
      qc_by: qcBy,
      started_at: startedAt,
      completed_at: now,
      duration_seconds: durationSeconds,
    }, { onConflict: 'qc_record_id,attempt_no' })
    if (attemptError) throw attemptError
  }
  return data
}

export async function submitQcRecheck(recordId: string, result: 'pass' | 'fail', failReason: string | null, qcBy: string) {
  const { data, error } = await supabase.rpc('qc_submit_recheck', {
    p_record_id: recordId,
    p_result: result,
    p_fail_reason: failReason,
    p_qc_by: qcBy,
  })
  if (error) throw error
  return data
}

export async function resolveQcEscalation(
  recordId: string,
  decision: 'special_recheck' | 'produce_new' | 'scrap' | 'return_source',
  reason: string,
  decidedBy: string
) {
  const { data, error } = await supabase.rpc('qc_resolve_escalation', {
    p_record_id: recordId,
    p_decision: decision,
    p_reason: reason,
    p_decided_by: decidedBy,
  })
  if (error) throw error
  return data
}

export async function fetchQcAttemptsByItemUid(itemUid: string) {
  const { data, error } = await supabase
    .from('qc_record_attempts')
    .select('*')
    .ilike('item_uid', itemUid)
    .order('completed_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function fetchQcAttemptsBySession(sessionId: string) {
  const { data, error } = await supabase
    .from('qc_record_attempts')
    .select('*')
    .eq('session_id', sessionId)
    .order('completed_at', { ascending: true })
  if (error) throw error
  return data || []
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
  const rejectedRecords = await fetchAllQueryPages<QCRecord>((from, to) =>
    supabase
      .from('qc_records')
      .select('*')
      .eq('is_rejected', true)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  )
  if (rejectedRecords.length === 0) return []

  // QC records use a flattened per-unit UID (bill-sequence), while or_order_items
  // stores the source-line UID. Linking them by item_uid drops valid siblings from
  // the recheck list. bill_no is persisted on every QC record and is the stable
  // link back to the order containing those flattened units.
  const billNos = [...new Set(rejectedRecords.map((r) => r.bill_no?.trim()).filter((v): v is string => Boolean(v)))]
  if (billNos.length === 0) return rejectedRecords

  const matchingOrders = await fetchQueryInBatches<{
    id: string
    bill_no: string | null
    status: string | null
    ship_due_at: string | null
    overdue_at: string | null
    shipped_time: string | null
  }>(billNos, (batch, from, to) =>
    supabase
      .from('or_orders')
      .select('id, bill_no, status, ship_due_at, overdue_at, shipped_time')
      .in('bill_no', batch)
      .order('id', { ascending: true })
      .range(from, to)
  )

  const matchedBillNoSet = new Set(matchingOrders.map((order) => order.bill_no).filter(Boolean))
  const allowedOrders = matchingOrders.filter((order) => isOrderAllowedInFulfillmentFlow(order.status))
  const allowedOrderIds = allowedOrders.map((order) => order.id)
  const activeItemRows = allowedOrderIds.length === 0 ? [] : await fetchQueryInBatches<{ order_id: string }>(
    allowedOrderIds,
    (batch, from, to) => supabase
      .from('or_order_items')
      .select('order_id')
      .in('order_id', batch)
      .is('cancellation_stock_action', null)
      .order('order_id', { ascending: true })
      .range(from, to)
  )
  const orderIdsWithActiveItems = new Set(activeItemRows.map((row) => row.order_id))
  const activeOrders = allowedOrders.filter((order) => orderIdsWithActiveItems.has(order.id))
  const activeBillNoSet = new Set(activeOrders.map((order) => order.bill_no).filter(Boolean))

  // ป้าย ส่งด่วน/ล่าช้า: map กำหนดส่งตามเลขบิล (บิลจากเมนู Marketplace เท่านั้นที่มีค่า)
  const dueByBillNo: Record<string, { ship_due_at: string | null; overdue_at: string | null; shipped_time: string | null }> = {}
  ;(activeOrders || []).forEach((o: { bill_no?: string | null; ship_due_at?: string | null; overdue_at?: string | null; shipped_time?: string | null }) => {
    if (o.bill_no && o.ship_due_at) {
      dueByBillNo[o.bill_no] = { ship_due_at: o.ship_due_at, overdue_at: o.overdue_at ?? null, shipped_time: o.shipped_time ?? null }
    }
  })
  return rejectedRecords
    // Keep legacy records whose bill can no longer be resolved. If the bill still
    // exists, show it only while at least one matching order item remains active.
    .filter((r) => !r.bill_no || !matchedBillNoSet.has(r.bill_no) || activeBillNoSet.has(r.bill_no))
    .map((r) => ({
      ...r,
      ship_due_at: dueByBillNo[r.bill_no]?.ship_due_at ?? null,
      overdue_at: dueByBillNo[r.bill_no]?.overdue_at ?? null,
      shipped_time: dueByBillNo[r.bill_no]?.shipped_time ?? null,
    }))
}

/** Load qc_sessions for Reports (filter by date and optional user). */
export async function fetchReports(params: { startDate: string; endDate: string; user?: string }) {
  let query = supabase
    .from('qc_sessions')
    .select('*')
    .gte('end_time', `${params.startDate}T00:00:00`)
    .lte('end_time', `${params.endDate}T23:59:59`)
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
    .or(buildIlikeOr(query, ['product_code', 'product_name']))
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

// ============================================
// QC Category Groups API (ตัวกรองหมวดหมู่ในเมนู QC Operation)
// ============================================

/** โหลดกรุ๊ปหมวดหมู่ทั้งหมด พร้อมรายชื่อหมวดหมู่ในแต่ละกรุ๊ป */
export async function fetchQcCategoryGroups(): Promise<QCCategoryGroup[]> {
  const { data: groups, error } = await supabase
    .from('qc_category_groups')
    .select('*')
    .order('sort_order')
    .order('created_at')
  if (error) throw error
  if (!groups || groups.length === 0) return []

  const { data: items, error: itemErr } = await supabase
    .from('qc_category_group_items')
    .select('group_id, category')
    .in('group_id', groups.map((g: any) => g.id))
  if (itemErr) throw itemErr

  const byGroup: Record<string, string[]> = {}
  items?.forEach((i: any) => {
    if (!byGroup[i.group_id]) byGroup[i.group_id] = []
    byGroup[i.group_id].push(i.category)
  })

  return groups.map((g: any) => ({
    ...g,
    categories: (byGroup[g.id] || []).sort((a, b) => a.localeCompare(b, 'th')),
  }))
}

/** ผลตรวจล่าสุดต่อ UID จากทุก session ของใบงานเดียวกัน */
export async function fetchLatestRecordsForWorkOrder(workOrderName: string) {
  const sessions = await fetchAllQueryPages<{ id: string }>((from, to) =>
    supabase
      .from('qc_sessions')
      .select('id')
      .eq('filename', `WO-${workOrderName}`)
      .order('id', { ascending: true })
      .range(from, to)
  )
  const sessionIds = sessions.map((session) => session.id)
  if (sessionIds.length === 0) return []

  const records = await fetchQueryInBatches<QCRecord>(sessionIds, (batch, from, to) =>
    supabase
      .from('qc_records')
      .select('*')
      .in('session_id', batch)
      .order('last_result_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  )

  records.sort((a, b) => {
    const timeDiff = new Date(a.last_result_at || 0).getTime() - new Date(b.last_result_at || 0).getTime()
    return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id)
  })
  const latestByUid = new Map<string, QCRecord>()
  records.forEach((record) => latestByUid.set(record.item_uid, record))
  return Array.from(latestByUid.values())
}

export async function createQcCategoryGroup(name: string, sortOrder = 0): Promise<QCCategoryGroup> {
  const { data, error } = await supabase
    .from('qc_category_groups')
    .insert({ name, sort_order: sortOrder })
    .select()
    .single()
  if (error) throw error
  return { ...data, categories: [] }
}

export async function updateQcCategoryGroup(id: string, patch: { name?: string; sort_order?: number }) {
  const { error } = await supabase
    .from('qc_category_groups')
    .update(patch)
    .eq('id', id)
  if (error) throw error
}

export async function deleteQcCategoryGroup(id: string) {
  const { error } = await supabase
    .from('qc_category_groups')
    .delete()
    .eq('id', id)
  if (error) throw error
}

/**
 * เพิ่มหมวดหมู่เข้ากรุ๊ป — ถ้าหมวดหมู่นั้นอยู่กรุ๊ปอื่นอยู่แล้วจะย้ายมากรุ๊ปใหม่
 * (DB บังคับ UNIQUE(category) ให้หมวดหมู่หนึ่งอยู่ได้กรุ๊ปเดียว)
 */
export async function addQcCategoriesToGroup(groupId: string, categories: string[]) {
  const clean = [...new Set(categories.map((c) => c.trim()).filter(Boolean))]
  if (clean.length === 0) return
  const { error } = await supabase
    .from('qc_category_group_items')
    .upsert(clean.map((category) => ({ group_id: groupId, category })), { onConflict: 'category' })
  if (error) throw error
}

export async function removeQcCategoryFromGroup(groupId: string, category: string) {
  const { error } = await supabase
    .from('qc_category_group_items')
    .delete()
    .eq('group_id', groupId)
    .eq('category', category)
  if (error) throw error
}

/** หมวดหมู่สินค้าทั้งหมดที่มีในระบบ (ใช้เป็นตัวเลือกตอนตั้งค่ากรุ๊ป) */
export async function fetchQcProductCategories(): Promise<string[]> {
  const { data, error } = await supabase
    .from('pr_products')
    .select('product_category')
    .not('product_category', 'is', null)
  if (error) throw error
  const set = new Set(
    (data || [])
      .map((d: any) => String(d.product_category || '').trim())
      .filter(Boolean)
  )
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'th'))
}
