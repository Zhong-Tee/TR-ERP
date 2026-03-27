import { getPublicUrl } from '../../lib/qcApi'
import { supabase } from '../../lib/supabase'

/** แถวที่ต้องหยิบจริง — ซ่อน system_complete จาก Picker / ตรวจสินค้า / รายการหยิบ */
export const WMS_FULFILLMENT_PICK_OR_LEGACY =
  'fulfillment_mode.eq.warehouse_pick,fulfillment_mode.is.null'

/**
 * PostgREST OR: (fulfillment pick/legacy) และ (ไม่ถูกยกเลิก หรือ ยกเลิกแล้วแต่ recall/ตัดจองในระบบแล้ว)
 * ใช้หน้าตรวจสินค้า — แสดงรายการบิลยกเลิกหลังแอดมินดำเนินการสต๊อคแล้ว ให้คลังกดคืนคลังจริง
 */
export const WMS_REVIEW_INCLUDE_CANCELLED_RECALLED_OR =
  'and(fulfillment_mode.eq.warehouse_pick,status.neq.cancelled),' +
  'and(fulfillment_mode.eq.warehouse_pick,status.eq.cancelled,stock_action.eq.recalled),' +
  'and(fulfillment_mode.is.null,status.neq.cancelled),' +
  'and(fulfillment_mode.is.null,status.eq.cancelled,stock_action.eq.recalled)'

/** บิลยกเลิก + คืนสต๊อค/ตัดจองในระบบแล้ว (recalled) แต่ยังรอเก็บคืนที่จัดเก็บ */
export function isWmsCancelledAwaitingPhysicalShelf(row: {
  status?: string | null
  stock_action?: string | null
}): boolean {
  return row.status === 'cancelled' && row.stock_action === 'recalled'
}

/** แถวที่แสดงในรายการตรวจสินค้า (รวมแท็บทั้งหมด) */
export function isWmsReviewVisibleRow(row: { status?: string | null; stock_action?: string | null }): boolean {
  if (isWmsCancelledAwaitingPhysicalShelf(row)) return true
  return ['picked', 'correct', 'wrong', 'not_find', 'out_of_stock', 'returned'].includes(String(row.status || ''))
}

/**
 * ชื่อใบงาน (work_order_name) ที่มีแถว wms_orders มอบหมายแล้ว
 * รองรับทั้ง work_order_id และแถว legacy ที่ work_order_id ว่าง (ใช้ order_id → or_orders.work_order_id)
 */
export async function fetchWorkOrderNamesWithWmsAssigned(): Promise<Set<string>> {
  const { data: wmsRows } = await supabase
    .from('wms_orders')
    .select('work_order_id, order_id')
    .or(WMS_FULFILLMENT_PICK_OR_LEGACY)
    .neq('status', 'cancelled')

  const woIds = new Set<string>()
  const orderIds: string[] = []
  for (const r of wmsRows || []) {
    if (r.work_order_id) woIds.add(r.work_order_id as string)
    else if (r.order_id) orderIds.push(r.order_id as string)
  }
  if (orderIds.length > 0) {
    const { data: ors } = await supabase.from('or_orders').select('work_order_id').in('id', orderIds)
    for (const o of ors || []) {
      if (o.work_order_id) woIds.add(o.work_order_id as string)
    }
  }
  if (woIds.size === 0) return new Set()
  const { data: wos } = await supabase.from('or_work_orders').select('work_order_name').in('id', Array.from(woIds))
  return new Set((wos || []).map((w: { work_order_name?: string }) => w.work_order_name).filter(Boolean) as string[])
}

/** key ของเมนูย่อย WMS — ต้องตรงกับ st_user_menus (Settings) ที่ใช้ wms-* prefix */
export const WMS_MENU_KEYS = {
  UPLOAD: 'wms-upload',
  NEW_ORDERS: 'wms-new-orders',
  REVIEW: 'wms-review',
  KPI: 'wms-kpi',
  REQUISITION: 'wms-requisition',
  RETURN_REQUISITION: 'wms-return-requisition',
  BORROW_REQUISITION: 'wms-borrow-requisition',
  NOTIF: 'wms-notif',
  SETTINGS: 'wms-settings',
} as const

/** เมนูที่ต้องแสดง badge ตัวเลข */
export const WMS_COUNTED_KEYS = [
  WMS_MENU_KEYS.NEW_ORDERS,
  WMS_MENU_KEYS.UPLOAD,
  WMS_MENU_KEYS.REVIEW,
  WMS_MENU_KEYS.REQUISITION,
  WMS_MENU_KEYS.RETURN_REQUISITION,
  WMS_MENU_KEYS.BORROW_REQUISITION,
  WMS_MENU_KEYS.NOTIF,
]

export interface WmsTabCounts {
  [key: string]: number
}

/**
 * คำนวณจำนวนรายการในแต่ละแท็บ WMS — shared logic ใช้ร่วมกันทั้ง Sidebar และ AdminLayout
 * เพื่อให้ตัวเลขตรงกันเสมอ
 */
export async function loadWmsTabCounts(): Promise<{ counts: WmsTabCounts; total: number }> {
  const today = new Date().toISOString().split('T')[0]

  // 1. ใบงานใหม่: work orders with status "กำลังผลิต" not yet assigned picker + มีสินค้าในหมวดหมู่ที่ต้องหยิบ
  const { data: woData } = await supabase
    .from('or_work_orders')
    .select('work_order_name')
    .eq('status', 'กำลังผลิต')
  let newOrdersCount = 0
  if (woData && woData.length > 0) {
    const woNames = [...new Set(woData.map((wo: any) => wo.work_order_name as string))]
    const assignedNames = await fetchWorkOrderNamesWithWmsAssigned()
    const unassignedNames = woNames.filter((n) => !assignedNames.has(n))

    if (unassignedNames.length > 0) {
      const mainKW = ['STAMP', 'LASER', 'SUBLIMATION']
      const etcCats = ['CALENDAR', 'ETC', 'INK']
      const isPickable = (cat: string, rubberCode?: string) => {
        if ((rubberCode || '').trim() !== '') return true
        const u = (cat || '').toUpperCase()
        return mainKW.some((kw) => u.includes(kw)) || etcCats.includes(u)
      }

      const { data: orders } = await supabase
        .from('or_orders')
        .select('work_order_name, or_order_items(product_id, is_free)')
        .in('work_order_name', unassignedNames)
      const allItems = (orders || []).flatMap((o: any) =>
        (o.or_order_items || []).map((i: any) => ({
          product_id: i.product_id,
          work_order_name: o.work_order_name,
          is_free: i.is_free,
        }))
      )
      const productIds = [...new Set(allItems.map((i: any) => i.product_id).filter(Boolean))]
      let catMap: Record<string, string> = {}
      if (productIds.length > 0) {
        const { data: prods } = await supabase
          .from('pr_products')
          .select('id, product_category, rubber_code')
          .in('id', productIds)
        catMap = (prods || []).reduce((acc: Record<string, string>, p: any) => {
          const category = String(p.product_category || '')
          const rubberCode = String(p.rubber_code || '').trim()
          acc[p.id] = rubberCode ? `${category}__RUBBER__${rubberCode}` : category
          return acc
        }, {})
      }
      const woQualifies = new Set<string>()
      allItems.forEach((item: any) => {
        if (!item.product_id) return
        const raw = catMap[item.product_id] || ''
        const marker = '__RUBBER__'
        const markerIdx = raw.indexOf(marker)
        const hasRubber = markerIdx >= 0
        const cat = hasRubber ? raw.slice(0, markerIdx) : raw
        const rubberCode = hasRubber ? raw.slice(markerIdx + marker.length) : ''
        if (isPickable(cat, rubberCode)) woQualifies.add(item.work_order_name)
      })
      newOrdersCount = unassignedNames.filter((n) => woQualifies.has(n)).length
    }
  }

  // 2. รายการใบงาน: นับเฉพาะ order_id ที่สถานะภาพรวม = IN PROGRESS (มี item ที่ status เป็น pending/wrong/not_find)
  const { data: wmsData } = await supabase
    .from('wms_orders')
    .select('work_order_id, order_id, status, stock_action')
    .or(WMS_REVIEW_INCLUDE_CANCELLED_RECALLED_OR)
    .gte('created_at', today + 'T00:00:00')
    .lte('created_at', today + 'T23:59:59')

  const uploadGroups: Record<string, boolean> = {}
  ;(wmsData || []).forEach((r: any) => {
    if (!uploadGroups[r.order_id]) uploadGroups[r.order_id] = false
    if (['pending', 'wrong', 'not_find'].includes(r.status)) uploadGroups[r.order_id] = true
  })
  const uploadCount = Object.values(uploadGroups).filter(Boolean).length

  // 3. ตรวจสินค้า: ใช้เงื่อนไขเดียวกับ ReviewSection (นับเป็น work_order_id)
  let reviewCount = 0
  if (wmsData) {
    const grouped: Record<string, { total: number; pending: number; picked: number; shelfPending: number }> = {}
    wmsData.forEach((r: any) => {
      const wid = String(r.work_order_id || '').trim()
      if (!wid) return
      if (!grouped[wid]) grouped[wid] = { total: 0, pending: 0, picked: 0, shelfPending: 0 }
      grouped[wid].total++
      if (r.status === 'pending') grouped[wid].pending++
      if (r.status === 'picked') grouped[wid].picked++
      if (isWmsCancelledAwaitingPhysicalShelf(r)) grouped[wid].shelfPending++
    })
    reviewCount = Object.values(grouped).filter((g) => g.pending === 0 && (g.picked > 0 || g.shelfPending > 0)).length
  }

  // 4-7. รายการเบิก + รายการคืน + รายการยืม + แจ้งเตือน — ยิง parallel
  const [reqRes, returnReqRes, borrowReqRes, notifRowsRes] = await Promise.all([
    supabase
      .from('wms_requisitions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
    supabase
      .from('wms_return_requisitions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
    supabase
      .from('wms_borrow_requisitions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
    supabase
      .from('wms_notifications')
      .select('id, type, order_id')
      .eq('is_read', false),
  ])

  const notifRows = (notifRowsRes.data || []) as { id: string; type: string; order_id: string | null }[]
  const cancelOrderSet = new Set<string>()
  let notifCount = 0
  for (const row of notifRows) {
    if (row.type === 'ยกเลิกบิล') {
      const key = String(row.order_id || '').trim()
      if (!key) continue
      if (cancelOrderSet.has(key)) continue
      cancelOrderSet.add(key)
      notifCount += 1
    } else {
      notifCount += 1
    }
  }

  const counts: WmsTabCounts = {
    [WMS_MENU_KEYS.NEW_ORDERS]: newOrdersCount,
    [WMS_MENU_KEYS.UPLOAD]: uploadCount,
    [WMS_MENU_KEYS.REVIEW]: reviewCount,
    [WMS_MENU_KEYS.REQUISITION]: reqRes.count ?? 0,
    [WMS_MENU_KEYS.RETURN_REQUISITION]: returnReqRes.count ?? 0,
    [WMS_MENU_KEYS.BORROW_REQUISITION]: borrowReqRes.count ?? 0,
    [WMS_MENU_KEYS.NOTIF]: notifCount,
  }
  const total = Object.values(counts).reduce((s, n) => s + n, 0)
  return { counts, total }
}

export const WMS_STATUS_LABELS: Record<string, string> = {
  pending: 'กำลังจัด',
  picked: 'หยิบแล้ว',
  out_of_stock: 'สินค้าหมด',
  correct: 'หยิบถูก',
  wrong: 'หยิบผิด',
  not_find: 'ไม่เจอสินค้า',
  returned: 'คืนเข้าคลัง',
}

const PRODUCT_IMAGE_BUCKET = 'product-images'

export function getProductImageUrl(productCode: string | null | undefined, ext: string = '.jpg'): string {
  if (!productCode) return ''
  return getPublicUrl(PRODUCT_IMAGE_BUCKET, productCode, ext)
}

export function formatDuration(ms: number): string {
  if (ms < 0 || Number.isNaN(ms)) return '00:00:00'
  let s = Math.floor(ms / 1000)
  let h = Math.floor(s / 3600)
  s %= 3600
  let m = Math.floor(s / 60)
  s %= 60
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

export function calculateDuration(startTime: string, endTime: string | null): string {
  const s = new Date(startTime)
  const e = endTime ? new Date(endTime) : new Date()
  return formatDuration(e.getTime() - s.getTime())
}

export function sortOrderItems<T extends { location?: string | null; created_at?: string | null; id?: string | null }>(
  items: T[] | null | undefined
): T[] {
  if (!items) return []
  return [...items].sort((a, b) => {
    const locA = a.location || ''
    const locB = b.location || ''
    if (locA === 'อะไหล่' && locB !== 'อะไหล่') return 1
    if (locA !== 'อะไหล่' && locB === 'อะไหล่') return -1
    const locCmp = locA.localeCompare(locB, undefined, { numeric: true, sensitivity: 'base' })
    if (locCmp !== 0) return locCmp

    const aTs = a.created_at ? new Date(a.created_at).getTime() : 0
    const bTs = b.created_at ? new Date(b.created_at).getTime() : 0
    if (aTs !== bTs) return aTs - bTs

    const aId = String(a.id || '')
    const bId = String(b.id || '')
    return aId.localeCompare(bId)
  })
}
