import type { SupabaseClient } from '@supabase/supabase-js'
import type { Order, OrderItem } from '../types'
import { sortOrderItemsForExport } from './orderItemExportSort'

/** หัวตารางเดียวกับปุ่ม "ดาวน์โหลด Excel" ในรายละเอียดบิล (ProductionData) */
export const PRODUCTION_EXCEL_HEADERS = [
  'ชื่อใบงาน',
  'เลขบิล',
  'Item UID',
  'รหัสสินค้า',
  'ชื่อสินค้า',
  'สีหมึก',
  'ชั้นที่',
  'ลายการ์ตูน',
  'ลายเส้น',
  'ฟอนต์',
  'บรรทัด 1',
  'บรรทัด 2',
  'บรรทัด 3',
  'จำนวน',
  'หมายเหตุ',
  'ไฟล์แนบ',
  'หมวด',
] as const

const LAYER_PRODUCT_NAMES = ['ตรายางคอนโด TWB ฟ้า', 'ตรายางคอนโด TWP ชมพู']

const TIER_PRODUCT_NAMES = ['ตรายางคอนโด TWP ชมพู', 'ตรายางคอนโด TWB ฟ้า']

export function fmtThAmount(n: number | null | undefined) {
  return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

async function fetchProductCodeMaps(supabase: SupabaseClient, productIds: string[]) {
  const productCodeByProductId: Record<string, string> = {}
  const productCategoryByProductId: Record<string, string> = {}
  if (productIds.length === 0) return { productCodeByProductId, productCategoryByProductId }
  const { data: products, error } = await supabase
    .from('pr_products')
    .select('id, product_code, product_category')
    .in('id', productIds)
  if (error) throw error
  ;(products || []).forEach((p: { id: string; product_code?: string | null; product_category?: string | null }) => {
    const pid = String(p.id)
    productCodeByProductId[pid] = String(p.product_code ?? '').trim()
    productCategoryByProductId[pid] = String(p.product_category ?? '').trim()
  })
  return { productCodeByProductId, productCategoryByProductId }
}

export function buildProductionDataRowsForOrder(
  order: Order,
  items: OrderItem[],
  productCodeByProductId: Record<string, string>,
  productCategoryByProductId: Record<string, string>
): unknown[][] {
  const sorted = sortOrderItemsForExport(items)
  return sorted.map((item) => {
    const productName = String(item.product_name ?? '').trim()
    const showLayer = LAYER_PRODUCT_NAMES.includes(productName)
    const pid = item.product_id ? String(item.product_id) : ''
    const noName = !!item.no_name_line
    const cleanNotes = noName
      ? ('ไม่รับชื่อ' + ((item.notes || '').replace(/\[SET-.*?\]/g, '').trim() ? ' ' + (item.notes || '').replace(/\[SET-.*?\]/g, '').trim() : ''))
      : (item.notes || '').replace(/\[SET-.*?\]/g, '').trim()
    return [
      order.work_order_name || '-',
      order.bill_no || '-',
      item.item_uid || '-',
      pid ? (productCodeByProductId[pid] ?? '') : '',
      item.product_name || '',
      item.ink_color || '',
      showLayer ? (item.product_type || '') : '',
      item.cartoon_pattern != null && String(item.cartoon_pattern).trim() !== '' ? item.cartoon_pattern : 0,
      item.line_pattern != null && String(item.line_pattern).trim() !== '' ? item.line_pattern : 0,
      item.font || '',
      item.line_1 || '',
      item.line_2 || '',
      item.line_3 || '',
      item.quantity ?? 0,
      cleanNotes,
      item.file_attachment || '',
      pid ? (productCategoryByProductId[pid] || 'N/A') : 'N/A',
    ]
  })
}

/** Export แบบรายละเอียดบิล (ดาวน์โหลด Excel) — ออเดอร์เดียว */
export async function buildProductionLikeExport(
  supabase: SupabaseClient,
  order: Order,
  items: OrderItem[]
): Promise<{ headers: string[]; dataRows: unknown[][] }> {
  const productIds = Array.from(new Set(items.map((item) => item.product_id).filter(Boolean))) as string[]
  const { productCodeByProductId, productCategoryByProductId } = await fetchProductCodeMaps(supabase, productIds)
  const dataRows = buildProductionDataRowsForOrder(order, items, productCodeByProductId, productCategoryByProductId)
  return { headers: [...PRODUCTION_EXCEL_HEADERS], dataRows }
}

/** Export หลายบิล — แถวต่อกันในชีตเดียว หัวตารางเดียว */
export async function buildProductionLikeExportMulti(
  supabase: SupabaseClient,
  orders: Order[]
): Promise<{ headers: string[]; dataRows: unknown[][] }> {
  const allItems: OrderItem[] = []
  for (const order of orders) {
    const items = ((order as unknown as { or_order_items?: OrderItem[] }).or_order_items || []) as OrderItem[]
    allItems.push(...items)
  }
  const productIds = Array.from(new Set(allItems.map((item) => item.product_id).filter(Boolean))) as string[]
  const { productCodeByProductId, productCategoryByProductId } = await fetchProductCodeMaps(supabase, productIds)
  const dataRows: unknown[][] = []
  for (const order of orders) {
    const items = ((order as unknown as { or_order_items?: OrderItem[] }).or_order_items || []) as OrderItem[]
    dataRows.push(...buildProductionDataRowsForOrder(order, items, productCodeByProductId, productCategoryByProductId))
  }
  return { headers: [...PRODUCTION_EXCEL_HEADERS], dataRows }
}

/** หัวตารางรายการสินค้าในบิล (ตามตารางรายละเอียดบิล) + เลขพัสดุ */
export const BILL_LINE_ITEMS_EXCEL_HEADERS = [
  'เลขบิล',
  'เลขพัสดุ',
  '#',
  'ชื่อสินค้า',
  'สีหมึก',
  'ชั้น',
  'ลาย',
  'เส้น',
  'ฟอนต์',
  'บรรทัด 1',
  'บรรทัด 2',
  'บรรทัด 3',
  'จำนวน',
  'ราคา/หน่วย',
  'หมายเหตุ',
  'ไฟล์แนบ',
] as const

export function buildBillLineItemsRows(order: Order, items: OrderItem[]): unknown[][] {
  const tracking = order.tracking_number || ''
  if (items.length === 0) {
    return [[
      order.bill_no || '-',
      tracking,
      1,
      '(ไม่มีรายการสินค้า)',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]]
  }
  const sorted = sortOrderItemsForExport(items)
  return sorted.map((item, idx) => {
    const isTierProduct = TIER_PRODUCT_NAMES.includes(item.product_name || '')
    const hasFile = item.file_attachment && item.file_attachment.trim() !== ''
    const noteCell = item.no_name_line
      ? `ไม่รับชื่อ${item.notes ? ' ' + item.notes : ''}`
      : (item.notes || '-')
    return [
      order.bill_no || '-',
      tracking,
      idx + 1,
      item.product_name || '',
      item.ink_color || '-',
      isTierProduct ? (item.product_type || '-') : '-',
      item.cartoon_pattern || '-',
      item.line_pattern || '-',
      item.font || '-',
      item.line_1 || '-',
      item.line_2 || '-',
      item.line_3 || '-',
      item.quantity ?? 0,
      `฿${fmtThAmount(item.unit_price)}`,
      noteCell,
      hasFile ? item.file_attachment : '-',
    ]
  })
}

export async function buildBillLineItemsExportMulti(
  _supabase: SupabaseClient,
  orders: Order[]
): Promise<{ headers: string[]; dataRows: unknown[][] }> {
  const dataRows: unknown[][] = []
  for (const order of orders) {
    const items = ((order as unknown as { or_order_items?: OrderItem[] }).or_order_items || []) as OrderItem[]
    dataRows.push(...buildBillLineItemsRows(order, items))
  }
  return { headers: [...BILL_LINE_ITEMS_EXCEL_HEADERS], dataRows }
}
