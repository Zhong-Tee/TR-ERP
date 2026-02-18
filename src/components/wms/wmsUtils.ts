import { getPublicUrl } from '../../lib/qcApi'
import { supabase } from '../../lib/supabase'

/** key ของเมนูย่อย WMS — ต้องตรงกับ st_user_menus (Settings) ที่ใช้ wms-* prefix */
export const WMS_MENU_KEYS = {
  UPLOAD: 'wms-upload',
  NEW_ORDERS: 'wms-new-orders',
  REVIEW: 'wms-review',
  KPI: 'wms-kpi',
  REQUISITION: 'wms-requisition',
  RETURN_REQUISITION: 'wms-return-requisition',
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
    const { data: assignedRows, error: assignedErr } = await supabase
      .from('wms_orders')
      .select('order_id')
      .in('order_id', woNames)
    if (assignedErr) {
      console.error('loadWmsTabCounts wms_orders error:', assignedErr.message)
    }
    const assignedSet = new Set((assignedRows || []).map((r: any) => r.order_id))
    const unassignedNames = woNames.filter((n) => !assignedSet.has(n))

    if (unassignedNames.length > 0) {
      const mainKW = ['STAMP', 'LASER']
      const etcCats = ['CALENDAR', 'ETC', 'INK']
      const isPickable = (cat: string) => {
        const u = (cat || '').toUpperCase()
        return mainKW.some((kw) => u.includes(kw)) || etcCats.includes(u)
      }

      const { data: orders } = await supabase
        .from('or_orders')
        .select('work_order_name, or_order_items(product_id)')
        .in('work_order_name', unassignedNames)
      const allItems = (orders || []).flatMap((o: any) =>
        (o.or_order_items || []).map((i: any) => ({ product_id: i.product_id, work_order_name: o.work_order_name }))
      )
      const productIds = [...new Set(allItems.map((i: any) => i.product_id).filter(Boolean))]
      let catMap: Record<string, string> = {}
      if (productIds.length > 0) {
        const { data: prods } = await supabase.from('pr_products').select('id, product_category').in('id', productIds)
        catMap = (prods || []).reduce((acc: Record<string, string>, p: any) => { acc[p.id] = p.product_category || ''; return acc }, {})
      }
      const woWithPickable = new Set<string>()
      allItems.forEach((item: any) => {
        if (isPickable(catMap[item.product_id] || '')) woWithPickable.add(item.work_order_name)
      })
      newOrdersCount = unassignedNames.filter((n) => woWithPickable.has(n)).length
    }
  }

  // 2. รายการใบงาน: นับเฉพาะ order_id ที่สถานะภาพรวม = IN PROGRESS (มี item ที่ status เป็น pending/wrong/not_find)
  const { data: wmsData } = await supabase
    .from('wms_orders')
    .select('order_id, status')
    .gte('created_at', today + 'T00:00:00')
    .lte('created_at', today + 'T23:59:59')

  const uploadGroups: Record<string, boolean> = {}
  ;(wmsData || []).forEach((r: any) => {
    if (!uploadGroups[r.order_id]) uploadGroups[r.order_id] = false
    if (['pending', 'wrong', 'not_find'].includes(r.status)) uploadGroups[r.order_id] = true
  })
  const uploadCount = Object.values(uploadGroups).filter(Boolean).length

  // 3. ตรวจสินค้า: completed orders today that still have unchecked items (picked)
  let reviewCount = 0
  if (wmsData) {
    const grouped: Record<string, { total: number; finished: number; picked: number }> = {}
    wmsData.forEach((r: any) => {
      if (!grouped[r.order_id]) grouped[r.order_id] = { total: 0, finished: 0, picked: 0 }
      grouped[r.order_id].total++
      if (['picked', 'correct', 'wrong', 'not_find', 'out_of_stock'].includes(r.status)) grouped[r.order_id].finished++
      if (r.status === 'picked') grouped[r.order_id].picked++
    })
    reviewCount = Object.values(grouped).filter((g) => g.finished === g.total && g.picked > 0).length
  }

  // 4-6. รายการเบิก + รายการคืน + แจ้งเตือน — ยิง parallel เพื่อลด round-trip
  const [reqRes, returnReqRes, notifRes] = await Promise.all([
    supabase
      .from('wms_requisitions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .gte('created_at', today + 'T00:00:00')
      .lte('created_at', today + 'T23:59:59'),
    supabase
      .from('wms_return_requisitions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
    supabase
      .from('wms_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('is_read', false),
  ])

  const counts: WmsTabCounts = {
    [WMS_MENU_KEYS.NEW_ORDERS]: newOrdersCount,
    [WMS_MENU_KEYS.UPLOAD]: uploadCount,
    [WMS_MENU_KEYS.REVIEW]: reviewCount,
    [WMS_MENU_KEYS.REQUISITION]: reqRes.count ?? 0,
    [WMS_MENU_KEYS.RETURN_REQUISITION]: returnReqRes.count ?? 0,
    [WMS_MENU_KEYS.NOTIF]: notifRes.count ?? 0,
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

export function sortOrderItems<T extends { location?: string | null }>(items: T[] | null | undefined): T[] {
  if (!items) return []
  return [...items].sort((a, b) => {
    const locA = a.location || ''
    const locB = b.location || ''
    if (locA === 'อะไหล่' && locB !== 'อะไหล่') return 1
    if (locA !== 'อะไหล่' && locB === 'อะไหล่') return -1
    return locA.localeCompare(locB, undefined, { numeric: true, sensitivity: 'base' })
  })
}
