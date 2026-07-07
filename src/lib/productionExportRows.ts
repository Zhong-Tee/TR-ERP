import { supabase } from './supabase'
import { flatBillUnitUid, normalizedLineQuantity } from './productionUnits'
import { sortOrderItemsForExport } from './orderItemExportSort'

/**
 * คอลัมน์รายการสินค้าสำหรับ export/คัดลอกข้อมูลใบงาน (ลำดับตรงกับหัวตาราง Excel)
 * ใช้ร่วมกันระหว่าง Plan → จัดการใบงาน (ปุ่มคัดลอก/Export) และ
 * ออเดอร์ → Confirm → ไม่ต้องออกแบบ (ปุ่มคัดลอกข้อมูลใบงาน)
 */
export const EXPORT_ITEM_COLUMNS: Array<{ key: string; label: string; settingsKey: string }> = [
  { key: 'product_name', label: 'ชื่อสินค้า', settingsKey: 'product_name' },
  { key: 'ink_color', label: 'สีหมึก', settingsKey: 'ink_color' },
  { key: 'product_type', label: 'ชั้นที่', settingsKey: 'layer' },
  { key: 'cartoon_pattern', label: 'ลายการ์ตูน', settingsKey: 'cartoon_pattern' },
  { key: 'line_pattern', label: 'ลายเส้น', settingsKey: 'line_pattern' },
  { key: 'font', label: 'ฟอนต์', settingsKey: 'font' },
  { key: 'line_1', label: 'บรรทัด 1', settingsKey: 'line_1' },
  { key: 'line_2', label: 'บรรทัด 2', settingsKey: 'line_2' },
  { key: 'line_3', label: 'บรรทัด 3', settingsKey: 'line_3' },
  { key: 'quantity', label: 'จำนวน', settingsKey: 'quantity' },
  { key: 'notes', label: 'หมายเหตุ', settingsKey: 'notes' },
  { key: 'file_attachment', label: 'ไฟล์แนบ', settingsKey: 'attachment' },
]

/** สินค้าที่แสดงคอลัมน์ "ชั้นที่" */
const LAYER_PRODUCT_NAMES = ['ตรายางคอนโด TWB ฟ้า', 'ตรายางคอนโด TWP ชมพู']

/** กัน Excel/Sheets ตีความ +/0 เป็นตัวเลขหรือสูตร (นำหน้าด้วย zero-width space) */
function forceText(val: string | null | undefined): string {
  const str = String(val ?? '').trim()
  if (str === '') return ''
  if (str.startsWith('+') || str.startsWith('0')) return '​' + str
  return str
}

export type ProductionExportOrder = {
  bill_no?: string | null
  work_order_name?: string | null
  or_order_items?: unknown[] | null
  order_items?: unknown[] | null
}

/**
 * สร้างแถวข้อมูล 1 แถวต่อ 1 ชิ้น (unit) — ไม่รวมหัวตาราง
 * โครงสร้างคอลัมน์: [ชื่อใบงาน, เลขบิล, Item UID, รหัสสินค้า, ...EXPORT_ITEM_COLUMNS, หมวด]
 * @param resolveName คืนชื่อใบงานที่จะแสดงในคอลัมน์แรก (บิลที่ยังไม่มีใบงานให้คืน '')
 */
export async function buildProductionExportRows(
  orders: ProductionExportOrder[],
  resolveName: (order: ProductionExportOrder) => string
): Promise<unknown[][]> {
  const ordersSorted = [...orders].sort((a, b) =>
    String(a.bill_no || '').localeCompare(String(b.bill_no || ''))
  )
  if (ordersSorted.length === 0) return []

  const allItemsFlat = ordersSorted.flatMap(
    (o) => (o.or_order_items || o.order_items || []) as any[]
  )
  const productIds = Array.from(
    new Set(allItemsFlat.map((item: any) => item.product_id).filter(Boolean))
  )
  const productCodeByProductId: Record<string, string> = {}
  const productCategoryByProductId: Record<string, string> = {}
  if (productIds.length > 0) {
    const { data: products, error } = await supabase
      .from('pr_products')
      .select('id, product_code, product_category')
      .in('id', productIds)
    if (error) throw error
    ;(products || []).forEach((p: { id: string; product_code?: string | null; product_category?: string | null }) => {
      const id = String(p.id)
      productCodeByProductId[id] = String(p.product_code ?? '').trim()
      productCategoryByProductId[id] = String(p.product_category ?? '').trim()
    })
  }

  const dataToExport: unknown[][] = []
  ordersSorted.forEach((order) => {
    const rawItems = (order.or_order_items || order.order_items || []) as any[]
    const items = sortOrderItemsForExport(rawItems as any)
    const bill = String(order.bill_no ?? '').trim() || '—'
    const nameForDisplay = resolveName(order)
    let unitSeq = 0
    items.forEach((item: any) => {
      const noName = !!item.no_name_line
      const cleanNotes = noName
        ? 'ไม่รับชื่อ' +
          ((item.notes || '').replace(/\[SET-.*?\]/g, '').trim()
            ? ' ' + (item.notes || '').replace(/\[SET-.*?\]/g, '').trim()
            : '')
        : (item.notes || '').replace(/\[SET-.*?\]/g, '').trim()
      const productName = String(item.product_name ?? '').trim()
      const showLayer = LAYER_PRODUCT_NAMES.includes(productName)
      const pid = item.product_id ? String(item.product_id) : ''
      const productCode = pid ? productCodeByProductId[pid] ?? '' : ''
      const category = pid ? productCategoryByProductId[pid] || 'N/A' : 'N/A'
      const copies = normalizedLineQuantity(item.quantity)
      for (let c = 0; c < copies; c++) {
        unitSeq++
        const displayUid = flatBillUnitUid(bill, unitSeq)
        const row: unknown[] = [nameForDisplay, order.bill_no, displayUid, productCode]
        EXPORT_ITEM_COLUMNS.forEach((col) => {
          if (col.key === 'notes') row.push(cleanNotes)
          else if (col.key === 'line_1' || col.key === 'line_2' || col.key === 'line_3')
            row.push(forceText(item[col.key]))
          else if (col.key === 'quantity') row.push(1)
          else if (col.key === 'product_type') row.push(showLayer ? item.product_type ?? '' : '')
          else if (col.key === 'cartoon_pattern' || col.key === 'line_pattern')
            row.push(item[col.key] != null && String(item[col.key]).trim() !== '' ? item[col.key] : 0)
          else row.push(item[col.key] ?? '')
        })
        row.push(category)
        dataToExport.push(row)
      }
    })
  })
  return dataToExport
}

/** แปลงแถวข้อมูลเป็นข้อความ TSV สำหรับวางใน Excel/Sheets ผ่าน clipboard */
export function productionRowsToTsv(rows: unknown[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) => String(value ?? '').replace(/\r?\n/g, ' ').replace(/\t/g, ' '))
        .join('\t')
    )
    .join('\n')
}
